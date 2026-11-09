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
import {
  SCAN_OVERLAP_MS,
  SHELL_STORES,
  decideRecord,
  decideRow,
  decideTombstone,
  isReplicable,
  mergeSameAddress,
  type ChangeBatch,
  type ReplicaCursor,
  type ShellRecord,
  type ShellStore,
  type Stamp,
  type StampedRecord,
  type Tombstone,
} from "./replica";
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
const DB_VERSION = 8;

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
  /**
   * Records of deletions, so the other copy of the library (website or extension, see
   * `replica.ts`) removes the row too instead of sending it back. Added in v8.
   */
  tombstones: "tombstones",
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
  /** When this row was last written, for swapping changes with the other copy (v8). */
  syncAt?: number;
  /** Which copy of the library wrote it. */
  syncBy?: string;
}

/** A small-store record as written, with the same write stamp. */
type StoredRecord<T> = T & { syncAt?: number; syncBy?: string };

/* -------------------------------------------------------- write stamps (v8) */

const REPLICA_KEY = "replicaId";
let replicaPromise: Promise<string> | null = null;

/**
 * This database's id among the copies of the library.
 *
 * Created inside one read-write transaction, so the extension's page and its service
 * worker, opening the same database at the same moment, cannot each invent a different
 * one: rows stamped with an id the database no longer claims would never be sent.
 */
export function localReplica(): Promise<string> {
  replicaPromise ??= (async () => {
    let id: string | undefined;
    await transact(STORES.meta, "readwrite", ([store]) => {
      const request = store.get(REPLICA_KEY);
      request.onsuccess = () => {
        if (typeof request.result === "string" && request.result) {
          id = request.result;
          return;
        }
        id = `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        store.put(id, REPLICA_KEY);
      };
    });
    if (!id) throw new Error("No replica id");
    return id;
  })().catch((error: unknown) => {
    replicaPromise = null;
    throw error;
  });
  return replicaPromise;
}

let lastStampAt = 0;
/** A stamp for a write happening now. Strictly increasing, so two quick writes never tie. */
async function freshStamp(): Promise<Stamp> {
  const by = await localReplica();
  lastStampAt = Math.max(Date.now(), lastStampAt + 1);
  return { at: lastStampAt, by };
}

function stampRecord<T extends object>(record: T, stamp: Stamp): StoredRecord<T> {
  return { ...record, syncAt: stamp.at, syncBy: stamp.by };
}

function unstampRecord<T>(record: T): T {
  if (!record || typeof record !== "object") return record;
  const { syncAt: _at, syncBy: _by, ...rest } = record as StoredRecord<Record<string, unknown>>;
  return rest as T;
}

const tombstoneKey = (store: string, id: string) => `${store}:${id}`;

export function rowState(bookmark: Bookmark): RowState {
  if (bookmark.trashedAt) return "trash";
  if (bookmark.archived) return "archive";
  return "live";
}

function stampState(bookmark: Bookmark, stamp: Stamp): StoredBookmark {
  return {
    ...bookmark,
    idxState: rowState(bookmark),
    idxArrived: bookmark.importedAt ?? bookmark.addedAt,
    syncAt: stamp.at,
    syncBy: stamp.by,
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
  const { idxState: _state, idxArrived: _arrived, syncAt: _syncAt, syncBy: _syncBy, ...bookmark } = row as StoredBookmark;
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

      // Added in v8, for sharing one library between the website and the extension.
      if (!db.objectStoreNames.contains(STORES.tombstones)) {
        const store = db.createObjectStore(STORES.tombstones, { keyPath: "key" });
        store.createIndex("sync", ["at", "key"], { unique: false });
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
        // "What changed since we last spoke", for the other copy of the library. Rows
        // written before v8 have no stamp and are read by a full scan the first time.
        ensure("sync", ["syncAt", "id"]);
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

/**
 * Told after a library write lands. The extension's page uses it to wake a connected
 * website so it collects the change (see `replication.ts`). `fromReplica` marks writes that
 * were themselves copied in from the other side, which need not be sent back.
 */
type WriteListener = (fromReplica: boolean) => void;
const writeListeners = new Set<WriteListener>();
const LIBRARY_STORES = new Set<string>([STORES.bookmarks, STORES.tombstones, ...SHELL_STORES]);
let applyingReplica = false;

export function onLibraryWrite(listener: WriteListener): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

function noteLibraryWrite(store: string): void {
  if (!LIBRARY_STORES.has(store)) return;
  for (const listener of writeListeners) listener(applyingReplica);
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
    noteLibraryWrite(store);
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
  const [folders, boards, imports, sources, smart] = (
    await Promise.all([
      readAll<Folder>(STORES.folders),
      readAll<Board>(STORES.boards),
      readAll<ImportBatch>(STORES.imports),
      readAll<Source>(STORES.sources),
      readAll<SmartCollection>(STORES.smart),
    ])
  ).map((rows) => rows.map(unstampRecord)) as [Folder[], Board[], ImportBatch[], Source[], SmartCollection[]];
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

/**
 * Reads specific bookmarks by id, repaired, skipping any that no longer exist.
 *
 * For another tab's change notice: re-reading the whole library for every background
 * write meant thousands of full scans a minute at the scale this app is built for.
 */
export async function getBookmarks(ids: string[]): Promise<Bookmark[]> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string"))];
  if (!unique.length) return [];
  const found: unknown[] = [];
  await transact(STORES.bookmarks, "readonly", ([store]) => {
    for (const id of unique) {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result !== undefined) found.push(request.result);
      };
    }
  });
  const report: RepairReport = { repaired: 0, dropped: 0 };
  const rows: Bookmark[] = [];
  for (const row of found) {
    const repaired = unstamp(row as StoredBookmark, report);
    if (repaired) rows.push(repaired);
  }
  noteRepairs("changed-rows", report);
  return rows;
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
  const stamp = await freshStamp();
  const kept: Record<string, Set<string>> = {
    [STORES.bookmarks]: new Set(snapshot.bookmarks.map((row) => row.id)),
    [STORES.folders]: new Set(snapshot.folders.map((row) => row.id)),
    [STORES.boards]: new Set(snapshot.boards.map((row) => row.id)),
    [STORES.imports]: new Set(snapshot.imports.map((row) => row.id)),
    [STORES.sources]: new Set(snapshot.sources.map((row) => row.id)),
    [STORES.smart]: new Set(snapshot.smart.map((row) => row.id)),
  };
  await transact(
    [STORES.bookmarks, STORES.folders, STORES.boards, STORES.imports, STORES.sources, STORES.smart, STORES.tombstones],
    "readwrite",
    ([bookmarks, folders, boards, imports, sources, smart, tombstones]) => {
      // Rows that disappear in the swap are recorded as deleted, so the other copy of the
      // library loses them too rather than sending them straight back.
      for (const store of [bookmarks, folders, boards, imports, sources, smart]) {
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          for (const key of keys.result) {
            const id = String(key);
            if (kept[store.name]?.has(id)) continue;
            tombstones.put({ key: tombstoneKey(store.name, id), store: store.name, id, at: stamp.at, by: stamp.by });
          }
        };
      }
      bookmarks.clear();
      folders.clear();
      boards.clear();
      imports.clear();
      sources.clear();
      smart.clear();
      for (const bookmark of snapshot.bookmarks) bookmarks.put(stampState(bookmark, stamp));
      for (const folder of snapshot.folders) folders.put(stampRecord(folder, stamp));
      for (const board of snapshot.boards) boards.put(stampRecord(board, stamp));
      for (const batch of snapshot.imports) imports.put(stampRecord(batch, stamp));
      for (const source of snapshot.sources) sources.put(stampRecord(source, stamp));
      for (const collection of snapshot.smart) smart.put(stampRecord(collection, stamp));
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
  noteLibraryWrite(STORES.bookmarks);
}

/** Writes small-store records with a fresh stamp. */
async function putRecords<T extends { id: string }>(store: StoreName, records: T[]): Promise<void> {
  if (!records.length) return;
  const stamp = await freshStamp();
  await writeKeyed(store, records.map((record) => ({ key: record.id, value: stampRecord(record, stamp) })));
}

/** Deletes records and leaves a tombstone for each, so the deletion reaches the other copy. */
async function deleteRecords(store: StoreName, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const stamp = await freshStamp();
  await writeKeyed(
    STORES.tombstones,
    ids.map((id) => ({ key: tombstoneKey(store, id), value: { key: tombstoneKey(store, id), store, id, at: stamp.at, by: stamp.by } })),
  );
  await writeKeyed(store, ids.map((id) => ({ key: id, value: DELETE })));
}

export async function putSources(sources: Source[]): Promise<void> {
  await putRecords(STORES.sources, sources);
}

export async function deleteSource(id: string): Promise<void> {
  await deleteRecords(STORES.sources, [id]);
}

/* ---------------------------------------------------- smart collections -- */

export async function loadSmartCollections(): Promise<SmartCollection[]> {
  return (await readAll<SmartCollection>(STORES.smart)).map(unstampRecord);
}

export async function putSmartCollections(collections: SmartCollection[]): Promise<void> {
  await putRecords(STORES.smart, collections);
}

export async function deleteSmartCollection(id: string): Promise<void> {
  await deleteRecords(STORES.smart, [id]);
}

export async function putImports(batches: ImportBatch[]): Promise<void> {
  await putRecords(STORES.imports, batches);
}

export async function deleteImport(id: string): Promise<void> {
  await deleteRecords(STORES.imports, [id]);
}

export async function putBookmarks(bookmarks: Bookmark[]): Promise<void> {
  if (!bookmarks.length) return;
  const stamp = await freshStamp();
  await writeKeyed(
    STORES.bookmarks,
    bookmarks.map((bookmark) => ({ key: bookmark.id, value: stampState(bookmark, stamp) })),
  );
}

export async function deleteBookmarks(ids: string[]): Promise<void> {
  await deleteRecords(STORES.bookmarks, ids);
}

export async function putFolders(folders: Folder[]): Promise<void> {
  await putRecords(STORES.folders, folders);
}

export async function deleteFolders(ids: string[]): Promise<void> {
  await deleteRecords(STORES.folders, ids);
}

export async function putBoards(boards: Board[]): Promise<void> {
  await putRecords(STORES.boards, boards);
}

export async function deleteBoard(id: string): Promise<void> {
  await deleteRecords(STORES.boards, [id]);
}

/* ------------------------------------------- swapping changes with the other copy */

/** Rows and bytes per page. Chrome's extension messages top out at 64 MB; stay far below. */
const PAGE_ROWS = 400;
const PAGE_BYTES = 3_000_000;

export interface ChangePage extends ChangeBatch {
  cursor: ReplicaCursor;
  /** Nothing more to read right now. */
  done: boolean;
}

/**
 * Reads the next page of this database's changes for the other copy.
 *
 * `keep` filters by which copy wrote a record: a reader never sends a record back to the
 * copy it came from. `fresh` marks the first page of a round, which starts a little before
 * the saved cursor: a write is stamped before its transaction commits, so a slow commit
 * can land behind a cursor that has already moved past its stamp. Re-sent records are
 * recognised and skipped on arrival.
 */
export async function readChanges(
  cursor: ReplicaCursor | null,
  keep: (by: string) => boolean,
  fresh: boolean,
): Promise<ChangePage> {
  const me = await localReplica();
  const position: ReplicaCursor = cursor ?? { phase: "scan", after: "", startedAt: Date.now() };
  const page: ChangePage = { rows: [], tombstones: [], shell: [], cursor: position, done: false };
  let bytes = 0;
  const take = (row: StoredBookmark): void => {
    const stamp: Stamp = { at: row.syncAt ?? 0, by: row.syncBy ?? me };
    if (!keep(stamp.by)) return;
    const clean = unstamp(row);
    if (!clean || !isReplicable(clean)) return;
    bytes += JSON.stringify(clean).length;
    page.rows.push({ row: clean, stamp });
  };

  if (position.phase === "scan") {
    let last = position.after;
    let exhausted = false;
    await transact(STORES.bookmarks, "readonly", ([store]) => {
      page.rows = [];
      bytes = 0;
      last = position.after;
      exhausted = false;
      let read = 0;
      const request = store.openCursor(position.after ? IDBKeyRange.lowerBound(position.after, true) : undefined);
      request.onsuccess = () => {
        const at = request.result;
        if (!at) {
          exhausted = true;
          return;
        }
        take(at.value as StoredBookmark);
        last = String(at.primaryKey);
        read += 1;
        if (read < PAGE_ROWS && bytes < PAGE_BYTES) at.continue();
      };
    });
    page.cursor = exhausted
      ? { phase: "index", row: [position.startedAt - SCAN_OVERLAP_MS, ""], tomb: [0, ""], shellAt: -1 }
      : { phase: "scan", after: last, startedAt: position.startedAt };
    return page;
  }

  let rowKey = position.row;
  let tombKey = position.tomb;
  let rowsRead = 0;
  let tombsRead = 0;
  const shellRead: StampedRecord[] = [];
  let shellAt = position.shellAt;
  await transact([STORES.bookmarks, STORES.tombstones, ...SHELL_STORES], "readonly", ([bookmarks, tombstones, ...shell]) => {
    page.rows = [];
    page.tombstones = [];
    shellRead.length = 0;
    bytes = 0;
    rowKey = position.row;
    tombKey = position.tomb;
    rowsRead = 0;
    tombsRead = 0;
    shellAt = position.shellAt;
    const from = (key: [number, string]) =>
      fresh ? IDBKeyRange.lowerBound([key[0] - SCAN_OVERLAP_MS, ""]) : IDBKeyRange.lowerBound(key, true);

    const rows = bookmarks.index("sync").openCursor(from(position.row));
    rows.onsuccess = () => {
      const at = rows.result;
      if (!at) return;
      take(at.value as StoredBookmark);
      rowKey = at.key as [number, string];
      rowsRead += 1;
      if (rowsRead < PAGE_ROWS && bytes < PAGE_BYTES) at.continue();
    };
    const tombs = tombstones.index("sync").openCursor(from(position.tomb));
    tombs.onsuccess = () => {
      const at = tombs.result;
      if (!at) return;
      const value = at.value as Tombstone & { key: string };
      if (keep(value.by)) page.tombstones.push({ store: value.store, id: value.id, at: value.at, by: value.by });
      tombKey = at.key as [number, string];
      tombsRead += 1;
      if (tombsRead < PAGE_ROWS) at.continue();
    };
    // The small stores are read whole once a round, and on the first page after a full
    // scan: a few hundred records at most.
    if (!fresh && position.shellAt >= 0) return;
    shell.forEach((store, index) => {
      const name = SHELL_STORES[index] as ShellStore;
      const all = store.getAll();
      all.onsuccess = () => {
        for (const value of all.result as StoredRecord<ShellRecord>[]) {
          const stamp: Stamp = { at: value?.syncAt ?? 0, by: value?.syncBy ?? me };
          shellAt = Math.max(shellAt, stamp.at, 0);
          if (stamp.at < position.shellAt - SCAN_OVERLAP_MS || !keep(stamp.by)) continue;
          if (!value || typeof (value as { id?: unknown }).id !== "string") continue;
          shellRead.push({ store: name, record: unstampRecord(value), stamp });
        }
      };
    });
  });
  page.shell = shellRead;
  page.cursor = { phase: "index", row: rowKey, tomb: tombKey, shellAt };
  page.done = rowsRead < PAGE_ROWS && bytes < PAGE_BYTES && tombsRead < PAGE_ROWS;
  return page;
}

/** What applying a batch changed, for the open windows to re-read. */
export interface AppliedChanges {
  changed: string[];
  removed: string[];
  shell: boolean;
}

/**
 * This database's own rows by address, for the first time two copies meet.
 *
 * Someone who imported the same file on the website and in the extension has the same
 * bookmarks under different ids. Matching by address on first contact merges them instead
 * of showing every bookmark twice.
 */
export async function localRowsByUrl(): Promise<Map<string, { row: Bookmark; stamp: Stamp }>> {
  const me = await localReplica();
  const map = new Map<string, { row: Bookmark; stamp: Stamp }>();
  for (const stored of await readAll<StoredBookmark>(STORES.bookmarks)) {
    if (stored?.syncBy && stored.syncBy !== me) continue;
    const row = unstamp(stored);
    if (row && isReplicable(row) && !map.has(row.url)) map.set(row.url, { row, stamp: { at: stored.syncAt ?? 0, by: me } });
  }
  return map;
}

/** Writes a batch from the other copy, merging row by row (see `replica.ts`). */
export async function applyChanges(
  batch: ChangeBatch,
  byUrl?: Map<string, { row: Bookmark; stamp: Stamp }>,
): Promise<AppliedChanges> {
  const rowIds = new Set<string>([
    ...batch.rows.map((entry) => entry.row.id),
    ...batch.tombstones.filter((entry) => entry.store === "bookmarks").map((entry) => entry.id),
  ]);
  const local = new Map<string, StoredBookmark>();
  const localShell = new Map<string, StoredRecord<ShellRecord>>();
  const tombs = new Map<string, { at: number }>();

  await transact([STORES.bookmarks, STORES.tombstones, ...SHELL_STORES], "readonly", ([bookmarks, tombstones, ...shell]) => {
    local.clear();
    localShell.clear();
    tombs.clear();
    for (const id of rowIds) {
      const request = bookmarks.get(id);
      request.onsuccess = () => {
        if (request.result) local.set(id, request.result as StoredBookmark);
      };
    }
    const wanted = [
      ...batch.rows.map((entry) => tombstoneKey(STORES.bookmarks, entry.row.id)),
      ...batch.shell.map((entry) => tombstoneKey(entry.store, entry.record.id)),
    ];
    for (const key of wanted) {
      const request = tombstones.get(key);
      request.onsuccess = () => {
        if (request.result) tombs.set(key, request.result as { at: number });
      };
    }
    const shellIds = [
      ...batch.shell.map((entry) => [entry.store, entry.record.id] as const),
      ...batch.tombstones.filter((entry) => entry.store !== "bookmarks").map((entry) => [entry.store as ShellStore, entry.id] as const),
    ];
    for (const [name, id] of shellIds) {
      const request = shell[SHELL_STORES.indexOf(name)]!.get(id);
      request.onsuccess = () => {
        if (request.result) localShell.set(tombstoneKey(name, id), request.result as StoredRecord<ShellRecord>);
      };
    }
  });

  const stampOf = (row: StoredBookmark | StoredRecord<ShellRecord>, me: string): Stamp => ({ at: row.syncAt ?? 0, by: row.syncBy ?? me });
  const me = await localReplica();
  const rowWrites: { key: IDBValidKey; value: WriteValue }[] = [];
  const rowDeletes: string[] = [];
  const changed: string[] = [];
  let blendStamp: Stamp | null = null;

  for (const incoming of batch.rows) {
    const id = incoming.row.id;
    const stored = local.get(id);
    let current = stored ? { row: unstamp(stored)!, stamp: stampOf(stored, me) } : undefined;
    let renamedFrom: string | null = null;
    if (!current && byUrl) {
      const match = byUrl.get(incoming.row.url);
      if (match && match.row.id !== id) {
        current = { row: { ...match.row, id }, stamp: match.stamp };
        renamedFrom = match.row.id;
        byUrl.delete(incoming.row.url);
      }
    }
    const decision = renamedFrom
      ? ({ action: "blend", row: mergeSameAddress(current!, incoming, id) } as const)
      : decideRow(current, incoming, tombs.get(tombstoneKey(STORES.bookmarks, id)));
    if (decision.action === "keep" && !renamedFrom) continue;
    // A merged row is new to both copies, so it goes out under this copy's stamp.
    const row = decision.action === "keep" ? current!.row : decision.row;
    const stamp = decision.action === "take" ? incoming.stamp : (blendStamp ??= await freshStamp());
    rowWrites.push({ key: id, value: stampState(row, stamp) });
    changed.push(id);
    if (renamedFrom) rowDeletes.push(renamedFrom);
  }

  const removed: string[] = [...rowDeletes];
  const tombWrites: { key: IDBValidKey; value: WriteValue }[] = [];
  const shellWrites = new Map<ShellStore, { key: IDBValidKey; value: WriteValue }[]>();
  const shellWrite = (store: ShellStore, entry: { key: IDBValidKey; value: WriteValue }) => {
    const list = shellWrites.get(store) ?? [];
    list.push(entry);
    shellWrites.set(store, list);
  };

  for (const tombstone of batch.tombstones) {
    const key = tombstoneKey(tombstone.store, tombstone.id);
    tombWrites.push({ key, value: { key, ...tombstone } });
    if (tombstone.store === "bookmarks") {
      const stored = local.get(tombstone.id);
      if (decideTombstone(stored ? { stamp: stampOf(stored, me) } : undefined, tombstone)) {
        rowWrites.push({ key: tombstone.id, value: DELETE });
        removed.push(tombstone.id);
      }
    } else {
      const stored = localShell.get(key);
      if (decideTombstone(stored ? { stamp: stampOf(stored, me) } : undefined, tombstone)) {
        shellWrite(tombstone.store, { key: tombstone.id, value: DELETE });
      }
    }
  }
  for (const incoming of batch.shell) {
    const key = tombstoneKey(incoming.store, incoming.record.id);
    const stored = localShell.get(key);
    if (decideRecord(stored ? { stamp: stampOf(stored, me) } : undefined, incoming, tombs.get(key))) {
      shellWrite(incoming.store, { key: incoming.record.id, value: stampRecord(incoming.record, incoming.stamp) });
    }
  }

  applyingReplica = true;
  try {
    if (tombWrites.length) await writeKeyed(STORES.tombstones, tombWrites);
    if (rowDeletes.length) rowWrites.push(...rowDeletes.map((id) => ({ key: id, value: DELETE })));
    if (rowWrites.length) await writeKeyed(STORES.bookmarks, rowWrites);
    for (const [store, entries] of shellWrites) await writeKeyed(store, entries);
  } finally {
    applyingReplica = false;
  }
  return { changed, removed, shell: shellWrites.size > 0 };
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
