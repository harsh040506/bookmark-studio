/**
 * IndexedDB persistence.
 *
 * localStorage is not an option here: a real Chrome export embeds a base64 favicon per
 * bookmark (908 of them in a 936KB file), which blows past the ~5MB string quota. IndexedDB
 * stores structured values with a far larger budget and does it off the main thread.
 *
 * Everything stays on the device — nothing in this module talks to a network.
 *
 * ## Letting the database do the work
 *
 * For a long time this store had exactly two indexes and every other question — which rows
 * are in the trash, which arrived in this import, what are the newest two hundred — was
 * answered by reading the entire library into memory and filtering it in JavaScript. That
 * is fine at a thousand rows and is the reason the first paint is slow at ten thousand.
 *
 * Two things had to change together for indexes to actually help:
 *
 *   · **Compound indexes over fields that are always present.** IndexedDB silently omits a
 *     record from an index when any part of its key path is `undefined`, so an index on
 *     `trashedAt` — which is absent on every row that is *not* in the trash — contains
 *     precisely the rows nobody wants to page through. Indexing an optional field is not a
 *     weaker version of indexing a required one; it is an index over the complement.
 *
 *   · **A written-down state.** So the row that reaches storage carries a small denormalised
 *     field, stamped on write, saying which of the three mutually exclusive places it is
 *     in. That is what `state_added` is built on, and it is why the first screenful can be
 *     read by cursor instead of by reading everything and sorting it.
 *
 * The denormalised fields are index scaffolding, not part of the domain model — see
 * {@link StoredBookmark}.
 */
import {
  type ActivityEntry,
  type Board,
  type Bookmark,
  type Folder,
  type ImportBatch,
  type Settings,
  type SmartCollection,
  type Source,
} from "../../shared/types";
import { log } from "./log";
import { repairBookmark, repairFolders, repairSettings, type RepairReport } from "./repair";

const DB_NAME = "smart-bookmark-studio";
/**
 * v6 added the compound indexes and the smart-collection store; v7 **removes** four stores
 * whose features are gone — the canvas plane and its edges, the clipboard shelf, and saved
 * tab sessions.
 *
 * Deleting them rather than leaving them orphaned is the point of the version bump: an
 * unreferenced store is invisible, un-inspectable and still occupying the origin's storage
 * quota — which on a library that had the canvas populated is not a rounding error. Every
 * store is created behind a `contains` check and deleted behind the same one, so an upgrade
 * from v1 and a fresh install take the identical path and no version needs its own branch.
 */
const DB_VERSION = 7;

/** Stores that existed once and no longer do. Dropped on upgrade, never recreated. */
const RETIRED_STORES = ["canvasNotes", "canvasEdges", "clips", "sessions"] as const;

export const STORES = {
  bookmarks: "bookmarks",
  folders: "folders",
  boards: "boards",
  meta: "meta",
  activity: "activity",
  imports: "imports",
  /**
   * Downloaded bytes — screenshots, preview images, favicons.
   *
   * The app used to lean on the browser's HTTP cache for these, which is the wrong place
   * for them in every respect: it is opaque (nothing can report how much is stored or
   * clear a single entry), it is evicted on the browser's schedule rather than the
   * library's, it is per-browser-profile rather than per-library, and it means a library
   * that works offline in every other respect shows grey rectangles the moment the
   * network goes. Owning the bytes fixes all four.
   */
  assets: "assets",
  /** Sizes and last-use times, kept apart from the blobs so eviction can be planned
   *  without reading a gigabyte of images into memory to do it. */
  assetMeta: "assetMeta",
  /**
   * Standing places rows arrive from — a browser, an X archive, the clipboard.
   *
   * Separate from `imports`, which records one *event*. A source outlives its imports and
   * is what the sidebar counts and offers to re-read. Added in v5.
   */
  sources: "sources",
  /**
   * Collections that populate themselves by rule. Added in v6.
   *
   * Stored beside folders rather than as folders with a flag, because they have no
   * membership to store: a folder's contents are a fact, a smart collection's are the
   * answer to a question asked afresh each time it is opened.
   */
  smart: "smart",
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];

/* ------------------------------------------------------- index scaffolding */

/** The three mutually exclusive places a row can be. */
export type RowState = "live" | "archive" | "trash";

/**
 * A bookmark as it is actually written to disk.
 *
 * The two extra fields exist only so the database can answer questions it would otherwise
 * have to hand back to JavaScript, and they are derived entirely from the row — see
 * {@link stampState}. They are deliberately *not* on `Bookmark`: nothing in the app should
 * ever read them, because a denormalised field that application code starts trusting is a
 * denormalised field that will eventually be wrong. They are stamped on every write and
 * ignored on every read.
 *
 * A row written before v6 carries neither, which is exactly why `loadSnapshot` still has a
 * whole-store path: an index cannot see records that predate it, and a library must open
 * correctly on the first launch after an upgrade, before anything has been rewritten.
 */
interface StoredBookmark extends Bookmark {
  /** Which of the three places this row is in. */
  idxState: RowState;
  /** `importedAt ?? addedAt`, so arrival ordering is never a missing key. */
  idxArrived: number;
}

export function rowState(bookmark: Bookmark): RowState {
  if (bookmark.trashedAt) return "trash";
  if (bookmark.archived) return "archive";
  return "live";
}

function stampState(bookmark: Bookmark): StoredBookmark {
  return {
    ...bookmark,
    idxState: rowState(bookmark),
    idxArrived: bookmark.importedAt ?? bookmark.addedAt,
  };
}

/**
 * Strips the index scaffolding on the way out.
 *
 * Leaving it on would be harmless today and corrosive later: the fields would flow into
 * exports, into backups, and into the undo stack, and the first time one of them
 * disagreed with the row it describes there would be no way to tell which was right.
 */
/**
 * A stored row, minus its index stamps, repaired to today's shape (see `repair.ts`).
 * `null` only for a record with no usable id.
 */
function unstamp(row: StoredBookmark | Bookmark, report?: RepairReport): Bookmark | null {
  if (!row || typeof row !== "object") {
    if (report) report.dropped += 1;
    return null;
  }
  const { idxState: _state, idxArrived: _arrived, ...bookmark } = row as StoredBookmark;
  return repairBookmark(bookmark, report);
}

/** Logs, once per read, how many stored records needed fixing. */
function noteRepairs(where: string, report: RepairReport): void {
  if (report.repaired || report.dropped) log.warn("storage.repaired-records", { where, ...report });
}

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * How long to wait for another tab to release the database before giving up.
 *
 * `indexedDB.open` at a higher version fires `blocked` and then *waits forever* if an
 * older connection is still open somewhere. Without a deadline that is an app which never
 * finishes loading and never says why — the single worst failure mode available to a
 * local-first library, because the data is right there and simply unreachable.
 */
const OPEN_BLOCKED_TIMEOUT_MS = 10_000;

/**
 * An open that failed for a reason the user may be able to do something about.
 *
 * Carries a plain-language message. Storage refusal is not a bug to be reported as one:
 * private browsing, a disabled-storage setting and a second tab mid-upgrade are all
 * ordinary situations with different remedies, and "failed to open database" describes
 * none of them.
 */
export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(
        new StorageUnavailableError(
          "This browser has no local database available, so nothing can be saved. Private browsing usually causes this.",
        ),
      );
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Firefox throws here outright when storage is disabled, rather than firing `error`.
      reject(
        new StorageUnavailableError(
          "Local storage is blocked for this site, so your library cannot be opened. Check your browser's cookie and site-data settings.",
        ),
      );
      return;
    }

    /*
      Another tab is holding the previous version open.

      Answered with a deadline rather than a wait, because the alternative is a promise
      that never settles and a UI with no way to explain itself. The timer is cleared on
      every terminal outcome below — including `success`, since the other tab may well
      close and let the upgrade through before it fires.
    */
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    request.onblocked = () => {
      blockedTimer = setTimeout(() => {
        reject(
          new StorageUnavailableError(
            "Another tab has this library open and is stopping it from upgrading. Close the other tabs and reload.",
          ),
        );
      }, OPEN_BLOCKED_TIMEOUT_MS);
    };
    const settle = () => clearTimeout(blockedTimer);
    request.onupgradeneeded = () => {
      const db = request.result;
      // The version-change transaction, which is the only place an index may be created —
      // and the only way to reach a store that already exists in order to add one.
      const transaction = request.transaction;

      if (!db.objectStoreNames.contains(STORES.bookmarks)) {
        const store = db.createObjectStore(STORES.bookmarks, { keyPath: "id" });
        store.createIndex("folderId", "folderId", { unique: false });
        store.createIndex("addedAt", "addedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.folders)) {
        db.createObjectStore(STORES.folders, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.boards)) {
        db.createObjectStore(STORES.boards, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta);
      }
      if (!db.objectStoreNames.contains(STORES.activity)) {
        db.createObjectStore(STORES.activity, { keyPath: "id" });
      }
      // Added in v3. Guarded by the same `contains` check as every other store, so an
      // upgrade from v1 and a fresh install take the identical path.
      if (!db.objectStoreNames.contains(STORES.imports)) {
        db.createObjectStore(STORES.imports, { keyPath: "id" });
      }
      // Added in v4, alongside the move off the browser's HTTP cache.
      if (!db.objectStoreNames.contains(STORES.assets)) {
        db.createObjectStore(STORES.assets);
      }
      if (!db.objectStoreNames.contains(STORES.assetMeta)) {
        db.createObjectStore(STORES.assetMeta, { keyPath: "key" });
      }
      // Added in v5, when the library stopped being links-only.
      if (!db.objectStoreNames.contains(STORES.sources)) {
        db.createObjectStore(STORES.sources, { keyPath: "id" });
      }
      // Added in v6.
      if (!db.objectStoreNames.contains(STORES.smart)) {
        db.createObjectStore(STORES.smart, { keyPath: "id" });
      }

      // Removed in v7, along with the features that wrote to them.
      for (const retired of RETIRED_STORES) {
        if (db.objectStoreNames.contains(retired)) db.deleteObjectStore(retired);
      }

      /*
       * Indexes added to stores that already exist.
       *
       * Reached through the upgrade transaction rather than by creating the store, because
       * on any library older than v6 the store is already there with data in it. Each is
       * guarded individually: a user upgrading from v5 needs all of them, and one
       * upgrading from a partially-failed v6 needs whichever did not land.
       */
      if (transaction && db.objectStoreNames.contains(STORES.bookmarks)) {
        const store = transaction.objectStore(STORES.bookmarks);
        const ensure = (name: string, keyPath: string | string[]) => {
          if (!store.indexNames.contains(name)) {
            store.createIndex(name, keyPath, { unique: false });
          }
        };
        // The workhorse: "the newest live rows" is one cursor over this.
        ensure("state_added", ["idxState", "addedAt"]);
        // "Recently added" measures arrival here rather than the browser's timestamp.
        ensure("state_arrived", ["idxState", "idxArrived"]);
        // Facets the sidebar counts and the views filter by.
        ensure("domain", "domain");
        ensure("category", "category");
        // Both optional, and correctly so: a row with no import is a row no import view
        // will ever ask for, so its absence from the index costs nothing.
        ensure("importId", "importId");
        ensure("sourceId", "sourceId");
      }
      if (transaction && db.objectStoreNames.contains(STORES.activity)) {
        const store = transaction.objectStore(STORES.activity);
        if (!store.indexNames.contains("at")) {
          // So the log can be trimmed with a cursor from the oldest end rather than by
          // reading every entry to find out which are oldest.
          store.createIndex("at", "at", { unique: false });
        }
      }
    };
    request.onsuccess = () => {
      settle();
      const db = request.result;

      /*
        Let another tab upgrade.

        The counterpart to `onblocked` above: when a newer version of the app opens in a
        second tab, this connection is what would block *it*. Closing on `versionchange`
        is what turns "one stale tab wedges every other tab forever" into "the stale tab
        reconnects on its next read". Without both halves, a deploy leaves users with a
        library that will not open until they find and close the right tab.
      */
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opening) dbPromise = null;
      };

      /*
        A connection can also close underneath us — storage eviction, a browser
        housekeeping pass, the user clearing site data. Every transaction afterwards
        throws `InvalidStateError`, and a cached handle would keep serving that closed
        connection for the life of the page. Dropping the handle means the next call
        re-opens instead.
      */
      db.onclose = () => {
        if (dbPromise === opening) dbPromise = null;
      };

      resolve(db);
    };

    request.onerror = () => {
      settle();
      reject(
        request.error ??
          new StorageUnavailableError("Your library could not be opened. Reloading usually fixes it."),
      );
    };
  });

  /*
    A failed open must not be cached as a rejected promise.

    `dbPromise` was previously assigned unconditionally, so the first failure — a transient
    error, a tab that happened to be blocking at that moment, a quota check that came back
    badly — was remembered permanently: every later call returned that same rejection, and
    the app could not recover without a reload even once the cause had gone away. Clearing
    the handle on failure makes the next attempt a real attempt.

    The `catch` is attached without being awaited, purely to retract the handle; callers
    still receive the rejection from the promise returned below.
  */
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });

  dbPromise = opening;
  return opening;
}

/**
 * Failures worth one more attempt.
 *
 * `InvalidStateError` is a connection closed underneath us (another tab upgraded the
 * database, or the browser reclaimed it); reopening fixes it. `TransactionInactiveError`,
 * `UnknownError` and a plain abort are the browser's transient "try again" answers. A full
 * disk (`QuotaExceededError`) or a refusal is not transient, and retrying would only delay
 * telling the person.
 */
function isTransient(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return (
    name === "InvalidStateError" ||
    name === "TransactionInactiveError" ||
    name === "UnknownError" ||
    name === "AbortError"
  );
}

const TRANSACT_ATTEMPTS = 3;

function transactOnce<T>(
  names: StoreName[],
  mode: IDBTransactionMode,
  run: (stores: IDBObjectStore[]) => void | IDBRequest<T>,
): Promise<T | void> {
  return openDatabase().then(
    (db) =>
      new Promise<T | void>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(names, mode);
        } catch (error) {
          // The connection is closing; drop the handle so a retry opens a fresh one.
          dbPromise = null;
          reject(error);
          return;
        }
        const stores = names.map((name) => transaction.objectStore(name));
        let request: IDBRequest<T> | void;
        try {
          request = run(stores);
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            // Already finished.
          }
          reject(error);
          return;
        }
        transaction.oncomplete = () =>
          resolve(request && "result" in request ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () =>
          reject(transaction.error ?? new DOMException("The save was interrupted", "AbortError"));
      }),
  );
}

async function transact<T>(
  storeNames: StoreName | StoreName[],
  mode: IDBTransactionMode,
  run: (stores: IDBObjectStore[]) => void | IDBRequest<T>,
): Promise<T | void> {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  let lastError: unknown;
  for (let attempt = 0; attempt < TRANSACT_ATTEMPTS; attempt += 1) {
    try {
      return await transactOnce(names, mode, run);
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === TRANSACT_ATTEMPTS - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 120 * 3 ** attempt));
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------ write health */

/**
 * Changes the screen shows that the disk does not have yet.
 *
 * Edits are applied to memory first and written in the background, so a write that fails
 * (disk full, storage blocked, the database closed by another tab) would otherwise be lost
 * on the next reload without anyone being told. Each keyed write is tracked here instead:
 *
 * - every write takes a sequence number per record, so only the *latest* intended value
 *   for a record is ever remembered or cleared, whatever order attempts finish in;
 * - a failed write leaves its records here, and `retryUnsaved` writes them again;
 * - a later successful write of the same record clears it.
 *
 * Put and delete are idempotent, so replaying them is always safe.
 */
const DELETE: unique symbol = Symbol("delete");
type WriteValue = unknown;
interface Pending {
  store: StoreName;
  key: IDBValidKey;
  value: WriteValue;
  seq: number;
}

const unsaved = new Map<string, Pending>();
const latestSeq = new Map<string, number>();
let sequence = 0;
let inFlight = 0;
let lastFailure: WriteFailureKind | null = null;

export type WriteFailureKind = "quota" | "blocked" | "other";

export interface WriteHealth {
  /** Records whose latest change is not on disk. */
  unsaved: number;
  /** Writes currently running. */
  inFlight: number;
  /** Why the most recent failure happened, while anything is unsaved. */
  failure: WriteFailureKind | null;
}

const healthListeners = new Set<(health: WriteHealth) => void>();

export function writeHealth(): WriteHealth {
  return { unsaved: unsaved.size, inFlight, failure: unsaved.size ? lastFailure : null };
}

export function subscribeWriteHealth(listener: (health: WriteHealth) => void): () => void {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
}

function emitHealth(): void {
  const health = writeHealth();
  for (const listener of healthListeners) {
    try {
      listener(health);
    } catch {
      // A listener's own bug must not break persistence.
    }
  }
}

export function classifyWriteFailure(error: unknown): WriteFailureKind {
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = String((error as { message?: string } | null)?.message ?? "");
  if (name === "QuotaExceededError" || /quota/i.test(message)) return "quota";
  if (error instanceof StorageUnavailableError || name === "SecurityError" || name === "NotAllowedError") {
    return "blocked";
  }
  return "other";
}

/** Marks an error as already shown to the person, so the global handler stays quiet. */
export function markReported<T>(error: T): T {
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, "bsReported", { value: true });
    } catch {
      // A frozen error is reported twice at worst.
    }
  }
  return error;
}

export function isReported(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { bsReported?: boolean }).bsReported);
}

const recordId = (store: StoreName, key: IDBValidKey) => `${store}\u0000${String(key)}`;

/**
 * Writes keyed records with tracking. Rejects on failure (marked as reported), so callers
 * that wait can react, and callers that don't are not shown a second, vaguer error.
 */
async function writeKeyed(store: StoreName, entries: { key: IDBValidKey; value: WriteValue }[]): Promise<void> {
  if (!entries.length) return;
  const stamped = entries.map((entry) => {
    const id = recordId(store, entry.key);
    sequence += 1;
    latestSeq.set(id, sequence);
    return { ...entry, id, seq: sequence };
  });
  inFlight += 1;
  emitHealth();
  try {
    await transact(store, "readwrite", ([objectStore]) => {
      for (const entry of stamped) {
        if (entry.value === DELETE) objectStore.delete(entry.key);
        else if (store === STORES.meta) objectStore.put(entry.value, entry.key);
        else objectStore.put(entry.value);
      }
    });
    for (const entry of stamped) {
      if (latestSeq.get(entry.id) === entry.seq) {
        unsaved.delete(entry.id);
        latestSeq.delete(entry.id);
      }
    }
  } catch (error) {
    lastFailure = classifyWriteFailure(error);
    for (const entry of stamped) {
      if (latestSeq.get(entry.id) === entry.seq) {
        unsaved.set(entry.id, { store, key: entry.key, value: entry.value, seq: entry.seq });
      }
    }
    throw markReported(error);
  } finally {
    inFlight -= 1;
    emitHealth();
  }
}

let retrying: Promise<boolean> | null = null;

/** Writes every unsaved change again. Resolves `true` when nothing is left unsaved. */
export function retryUnsaved(): Promise<boolean> {
  if (retrying) return retrying;
  retrying = (async () => {
    try {
      const byStore = new Map<StoreName, Pending[]>();
      for (const pending of unsaved.values()) {
        const list = byStore.get(pending.store) ?? [];
        list.push(pending);
        byStore.set(pending.store, list);
      }
      for (const [store, list] of byStore) {
        await writeKeyed(
          store,
          list.map((pending) => ({ key: pending.key, value: pending.value })),
        ).catch(() => undefined);
      }
      return unsaved.size === 0;
    } finally {
      retrying = null;
    }
  })();
  return retrying;
}

/** Test hook. */
export function resetWriteHealth(): void {
  unsaved.clear();
  latestSeq.clear();
  inFlight = 0;
  lastFailure = null;
}

function readAll<T>(storeName: StoreName): Promise<T[]> {
  return openDatabase().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const request = db
          .transaction(storeName, "readonly")
          .objectStore(storeName)
          .getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
      }),
  );
}

export interface Snapshot {
  bookmarks: Bookmark[];
  folders: Folder[];
  boards: Board[];
  imports: ImportBatch[];
  sources: Source[];
  smart: SmartCollection[];
}

/**
 * The first screenful, read by index, so something can be drawn before everything is.
 *
 * ## Why this is worth its own path
 *
 * `loadSnapshot` deserialises every row in the library — every embedded base64 favicon
 * included — before the app can render a single card. The user is looking at a skeleton
 * for the whole of that, and what they are waiting for is about forty rows.
 *
 * So the opening sequence is now: read the newest few hundred by cursor, paint, then read
 * the remainder and fold it in. The grid the user sees first is the grid they would have
 * seen anyway, because the default sort is newest-first and this is that same order,
 * asked of the index rather than of a full in-memory sort.
 *
 * ## What it deliberately does not do
 *
 * It does not page the *whole* library. Every derivation in this app is a pure function
 * over an in-memory array, and search, stats and similarity are all only correct once the
 * array is complete — a half-loaded library that reported "3 results" would be worse than
 * one that took longer to open. This is a paint-sooner optimisation, not a windowing
 * strategy, and `loadRest` always follows.
 *
 * Returns an empty page on a library written before v6, whose rows are not in the index
 * yet; the caller falls through to the whole-store read.
 */
export async function loadFirstPage(limit: number): Promise<Bookmark[]> {
  const db = await openDatabase();
  return new Promise<Bookmark[]>((resolve) => {
    let store: IDBObjectStore;
    try {
      store = db.transaction(STORES.bookmarks, "readonly").objectStore(STORES.bookmarks);
    } catch {
      resolve([]);
      return;
    }
    if (!store.indexNames.contains("state_added")) {
      resolve([]);
      return;
    }

    const rows: Bookmark[] = [];
    const report: RepairReport = { repaired: 0, dropped: 0 };
    const range = IDBKeyRange.bound(["live", -Infinity], ["live", Infinity]);
    // `prev` because the default view is newest-first, and reading the oldest rows first
    // would mean sorting before anything could be shown — which is the work being avoided.
    const request = store.index("state_added").openCursor(range, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) {
        noteRepairs("first-page", report);
        resolve(rows);
        return;
      }
      const row = unstamp(cursor.value as StoredBookmark, report);
      if (row) rows.push(row);
      cursor.continue();
    };
    request.onerror = () => resolve([]);
  });
}

/** Everything else, once the first page is on screen. */
export async function loadRest(exclude: Set<string>): Promise<Bookmark[]> {
  const all = await readAll<StoredBookmark>(STORES.bookmarks);
  const rest: Bookmark[] = [];
  const report: RepairReport = { repaired: 0, dropped: 0 };
  for (const row of all) {
    if (row && typeof row === "object" && exclude.has(row.id)) continue;
    const repaired = unstamp(row, report);
    if (repaired) rest.push(repaired);
  }
  noteRepairs("library", report);
  return rest;
}

/** Everything except the bookmarks — small stores, read in one go alongside the page. */
export async function loadShell(): Promise<Omit<Snapshot, "bookmarks">> {
  const [folders, boards, imports, sources, smart] = await Promise.all([
    readAll<Folder>(STORES.folders),
    readAll<Board>(STORES.boards),
    readAll<ImportBatch>(STORES.imports),
    readAll<Source>(STORES.sources),
    readAll<SmartCollection>(STORES.smart),
  ]);
  const report: RepairReport = { repaired: 0, dropped: 0 };
  const identified = <T>(rows: T[]): T[] =>
    rows.filter((row) => {
      const ok = Boolean(row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string");
      if (!ok) report.dropped += 1;
      return ok;
    });
  // Sorting on a missing number would compare NaN and order rows unpredictably.
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const shell = {
    folders: repairFolders(folders, report),
    boards: identified(boards).map((board) =>
      typeof board.name === "string" ? board : { ...board, name: "Untitled board" },
    ),
    imports: identified(imports).sort((a, b) => num(b.at) - num(a.at)),
    sources: identified(sources).sort((a, b) => num(a.createdAt) - num(b.createdAt)),
    smart: identified(smart).sort(
      (a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || num(a.createdAt) - num(b.createdAt),
    ),
  };
  noteRepairs("shell", report);
  return shell;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const [rows, shell] = await Promise.all([
    readAll<StoredBookmark>(STORES.bookmarks),
    loadShell(),
  ]);
  const report: RepairReport = { repaired: 0, dropped: 0 };
  const bookmarks: Bookmark[] = [];
  for (const row of rows) {
    const repaired = unstamp(row, report);
    if (repaired) bookmarks.push(repaired);
  }
  noteRepairs("snapshot", report);
  return { bookmarks, ...shell };
}

/**
 * Writes a whole library in one transaction — used by import and restore.
 *
 * All stores are swapped together. Writing them in separate transactions would leave a
 * window in which bookmarks reference folders or import batches that no longer exist, and
 * a tab closed inside that window persists the inconsistency.
 */
export async function replaceAll(snapshot: Snapshot): Promise<void> {
  await transact(
    [STORES.bookmarks, STORES.folders, STORES.boards, STORES.imports, STORES.sources, STORES.smart],
    "readwrite",
    ([bookmarks, folders, boards, imports, sources, smart]) => {
      bookmarks.clear();
      folders.clear();
      boards.clear();
      imports.clear();
      sources.clear();
      smart.clear();
      for (const bookmark of snapshot.bookmarks) bookmarks.put(stampState(bookmark));
      for (const folder of snapshot.folders) folders.put(folder);
      for (const board of snapshot.boards) boards.put(board);
      for (const batch of snapshot.imports) imports.put(batch);
      for (const source of snapshot.sources) sources.put(source);
      for (const collection of snapshot.smart) smart.put(collection);
    },
  );
  const replaced = new Set<StoreName>([
    STORES.bookmarks,
    STORES.folders,
    STORES.boards,
    STORES.imports,
    STORES.sources,
    STORES.smart,
  ]);
  for (const [id, pending] of unsaved) {
    if (replaced.has(pending.store)) {
      unsaved.delete(id);
      latestSeq.delete(id);
    }
  }
  emitHealth();
}

export async function putSources(sources: Source[]): Promise<void> {
  await writeKeyed(STORES.sources, sources.map((source) => ({ key: source.id, value: source })));
}

export async function deleteSource(id: string): Promise<void> {
  await writeKeyed(STORES.sources, [{ key: id, value: DELETE }]);
}

/* ---------------------------------------------------- smart collections -- */

export function loadSmartCollections(): Promise<SmartCollection[]> {
  return readAll<SmartCollection>(STORES.smart);
}

export async function putSmartCollections(collections: SmartCollection[]): Promise<void> {
  await writeKeyed(STORES.smart, collections.map((collection) => ({ key: collection.id, value: collection })));
}

export async function deleteSmartCollection(id: string): Promise<void> {
  await writeKeyed(STORES.smart, [{ key: id, value: DELETE }]);
}

export async function putImports(batches: ImportBatch[]): Promise<void> {
  await writeKeyed(STORES.imports, batches.map((batch) => ({ key: batch.id, value: batch })));
}

export async function deleteImport(id: string): Promise<void> {
  await writeKeyed(STORES.imports, [{ key: id, value: DELETE }]);
}

export async function putBookmarks(bookmarks: Bookmark[]): Promise<void> {
  await writeKeyed(
    STORES.bookmarks,
    bookmarks.map((bookmark) => ({ key: bookmark.id, value: stampState(bookmark) })),
  );
}

export async function deleteBookmarks(ids: string[]): Promise<void> {
  await writeKeyed(STORES.bookmarks, ids.map((id) => ({ key: id, value: DELETE })));
}

export async function putFolders(folders: Folder[]): Promise<void> {
  await writeKeyed(STORES.folders, folders.map((folder) => ({ key: folder.id, value: folder })));
}

export async function deleteFolders(ids: string[]): Promise<void> {
  await writeKeyed(STORES.folders, ids.map((id) => ({ key: id, value: DELETE })));
}

export async function putBoards(boards: Board[]): Promise<void> {
  await writeKeyed(STORES.boards, boards.map((board) => ({ key: board.id, value: board })));
}

export async function deleteBoard(id: string): Promise<void> {
  await writeKeyed(STORES.boards, [{ key: id, value: DELETE }]);
}

export async function clearLibrary(): Promise<void> {
  await replaceAll({
    bookmarks: [],
    folders: [],
    boards: [],
    imports: [],
    sources: [],
    smart: [],
  });
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(STORES.meta, "readonly").objectStore(STORES.meta).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await writeKeyed(STORES.meta, [{ key, value }]);
}

/** Activity log — newest first, trimmed so it cannot grow without bound. */
const ACTIVITY_LIMIT = 200;

export async function loadActivity(): Promise<ActivityEntry[]> {
  const db = await openDatabase();
  const store = db.transaction(STORES.activity, "readonly").objectStore(STORES.activity);
  if (!store.indexNames.contains("at")) {
    // Pre-v6 library: no index to read from, so fall back to the whole store. This runs
    // exactly once per upgraded library, on the launch before the first entry is written.
    const entries = await readAll<ActivityEntry>(STORES.activity);
    return entries.sort((a, b) => b.at - a.at).slice(0, ACTIVITY_LIMIT);
  }

  return new Promise<ActivityEntry[]>((resolve, reject) => {
    const entries: ActivityEntry[] = [];
    const request = store.index("at").openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || entries.length >= ACTIVITY_LIMIT) {
        resolve(entries);
        return;
      }
      entries.push(cursor.value as ActivityEntry);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Appends one entry, and trims from the old end without reading the log.
 *
 * ## What this replaces
 *
 * It used to write the entry, then read *every* entry back to decide whether the log had
 * grown too long — a full store read per logged action, which is per delete, per move, per
 * bulk tag. The information needed to make that decision is a count and the position of
 * the oldest few, and both are things the database can answer directly.
 *
 * `count()` is O(1) on an object store. The trim then walks a cursor forward over the `at`
 * index — oldest first — deleting as it goes and stopping the moment the log is back
 * under the limit, so it touches only the entries it actually removes.
 *
 * Trimming stays opportunistic: it runs when the log is half again over the limit rather
 * than on every write, so the common case is one `put` and one `count`.
 */
export async function appendActivity(entry: ActivityEntry): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORES.activity, "readwrite");
    const store = transaction.objectStore(STORES.activity);
    store.put(entry);

    const counted = store.count();
    counted.onsuccess = () => {
      const total = counted.result;
      if (total <= ACTIVITY_LIMIT * 1.5 || !store.indexNames.contains("at")) return;
      let excess = total - ACTIVITY_LIMIT;
      // Forward over the `at` index is oldest-first, which is exactly the delete order.
      const cursorRequest = store.index("at").openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || excess <= 0) return;
        cursor.delete();
        excess -= 1;
        cursor.continue();
      };
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function clearActivity(): Promise<void> {
  await transact(STORES.activity, "readwrite", ([store]) => {
    store.clear();
  });
}

export async function loadSettings(): Promise<Settings> {
  const stored = await getMeta<unknown>("settings").catch((error: unknown) => {
    // Unreadable settings must not stop the library opening; the defaults are safe.
    log.warn("storage.settings-unreadable", { error });
    return undefined;
  });
  return repairSettings(stored);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await setMeta("settings", settings);
}

/** Rough size of the stored library, for the storage readout in settings. */
export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}

/* ------------------------------------------------------------------ assets */

/**
 * What is known about one stored asset without opening it.
 *
 * Held in its own store so the eviction pass and the storage readout can work from a few
 * hundred kilobytes of bookkeeping rather than by deserialising every blob in the
 * library — which on a full 3,000-bookmark shelf would be well over a gigabyte, read into
 * memory, to answer "how much is stored".
 */
export interface AssetMeta {
  key: string;
  bytes: number;
  type: string;
  /** When the bytes were first stored. */
  at: number;
  /** When something last displayed them; the eviction order. */
  usedAt: number;
}

/** Every asset's bookkeeping, for the in-memory ledger built once at start-up. */
export function loadAssetMeta(): Promise<AssetMeta[]> {
  return readAll<AssetMeta>(STORES.assetMeta);
}

export async function readAsset(key: string): Promise<Blob | undefined> {
  const db = await openDatabase();
  return new Promise<Blob | undefined>((resolve, reject) => {
    const request = db.transaction(STORES.assets, "readonly").objectStore(STORES.assets).get(key);
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Stores the bytes and their bookkeeping in one transaction.
 *
 * Together, because a blob with no meta is invisible to the eviction pass and would leak
 * forever, and meta with no blob makes the storage readout lie. Either failure is only
 * possible if these are allowed to be separate writes.
 */
export async function writeAsset(key: string, blob: Blob, meta: AssetMeta): Promise<void> {
  await transact([STORES.assets, STORES.assetMeta], "readwrite", ([assets, assetMeta]) => {
    assets.put(blob, key);
    assetMeta.put(meta);
  });
}

/** Records that an asset was displayed, so the eviction pass keeps what is in use. */
export async function touchAssets(entries: AssetMeta[]): Promise<void> {
  if (!entries.length) return;
  await transact(STORES.assetMeta, "readwrite", ([store]) => {
    for (const entry of entries) store.put(entry);
  });
}

export async function deleteAssets(keys: string[]): Promise<void> {
  if (!keys.length) return;
  await transact([STORES.assets, STORES.assetMeta], "readwrite", ([assets, assetMeta]) => {
    for (const key of keys) {
      assets.delete(key);
      assetMeta.delete(key);
    }
  });
}

export async function clearAssets(): Promise<void> {
  await transact([STORES.assets, STORES.assetMeta], "readwrite", ([assets, assetMeta]) => {
    assets.clear();
    assetMeta.clear();
  });
}
