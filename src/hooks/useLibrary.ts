/**
 * The single source of truth for the library.
 *
 * Every mutation goes through `commit`, which gives three things at once: persistence, an
 * undo entry and an activity record. State updaters stay pure — IndexedDB writes happen
 * after the next state is computed, never inside a `setState` callback, because React
 * double-invokes those in development and the writes would fire twice.
 *
 * ## What this hook owns, and what it deliberately does not
 *
 * It owns rows, folders, boards, sources, imports, smart collections, settings and the
 * background jobs. It does not own *selection* — which rows a view is showing is derived
 * by `lib/engine.ts` from an index this hook builds once per version, and no component
 * ever filters an array itself. That separation is what keeps a fifty-thousand-row library
 * responsive: a commit rebuilds one index; a keystroke re-runs one linear pass over it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_SETTINGS,
  hasPage,
  type ActivityEntry,
  type Board,
  type Bookmark,
  type DeviceName,
  type Folder,
  type ImportBatch,
  type Settings,
  type SmartCollection,
  type Source,
} from "../../shared/types";
import * as api from "../lib/api";
import {
  assetKey,
  clearAssets,
  ensureAsset,
  forgetAsset,
  getAssetBlob,
  initAssets,
  pinAsset,
  putAssetBlob,
  setAssetBudget,
} from "../lib/assets";
import {
  CHROME_SOURCE_ID,
  OTHER_BOOKMARKS_ID,
  allowBrowserSync,
  canReachBrowserBookmarks,
  createBookmarkNode,
  createFolderNode,
  isChromeBookmarksAvailable,
  moveBookmarkNode,
  reconcile as reconcileChromeBookmarks,
  removeBookmarkNode,
  removeFolderNode,
  renameFolderNode,
  startSync as startChromeSync,
  updateBookmarkNode,
} from "../lib/chrome-bookmarks";
import { classify, isTopicTag, suggestTags, topicsIn } from "../lib/classify";
import * as db from "../lib/db";
import { buildLibraryIndex, countFacets, type LibraryIndex } from "../lib/engine";
import { Vocabulary } from "../lib/fuzzy";
import { buildIndexAsync } from "../lib/indexer";
import {
  buildFolderPaths,
  folderSubtree,
  planDuplicateCleanup,
  toIndexDoc,
  retagDerived,
} from "../lib/library";
import { serializeNetscapeBookmarks } from "../lib/netscape";
import {
  configurePipeline,
  observeLibrary,
  pipelineState,
  setPipelineHidden,
  setPipelineOnline,
  setPipelineSettings,
  subscribePipeline,
  yieldPipeline,
  type PipelineState,
} from "../lib/pipeline";
import { forgetPrefetch } from "../lib/prefetch";
import {
  createSource,
  matchSource,
  sourcesWithCounts,
  type SourceWithCount,
} from "../lib/sources";
import { announceCommit, announceReplace, subscribeSync } from "../lib/sync";
import { TfIdfIndex } from "../lib/tfidf";
import { canonicalUrl, extractSummary, getDomain } from "../lib/text";
import { chunk, downloadFile, newId } from "../lib/utils";
import { groupLookalikes, indexImage } from "../lib/visual";
import { isVideoUrl, thumbnailUrl } from "../lib/embeds";
import { mergeBackup, parseBackupFile } from "../lib/backup";
import { IS_EXTENSION } from "../lib/env";
import { normalizeUserUrl } from "../lib/url-input";
import { runImport, type ColumnMap, type ImportOutcome, type SourceDefinition } from "../lib/import";

/** What the import dialog hands the library, for a preview or for the real thing. */
export interface ImportRunOptions {
  file: File;
  source: SourceDefinition;
  csvColumns?: ColumnMap;
  mode: "merge" | "replace";
  keepDuplicates: boolean;
  /** Text already read from the file, so a preview and its import read the disk once. */
  text?: string;
}

/**
 * The rows a "replace" import keeps.
 *
 * Replacing the library means replacing what earlier *imports* brought in. The browser's
 * own bookmarks (mirrored two-way when sync is on) are not the importer's to delete: wiping
 * them here would delete them from the browser too.
 */
function keptOnReplace(rows: Bookmark[]): Bookmark[] {
  return rows.filter((row) => row.sourceId === CHROME_SOURCE_ID);
}

/** A backup's numbers for the review step, without writing anything. */
async function previewBackup(file: File): Promise<ImportOutcome> {
  try {
    const restored = await parseBackupFile(file);
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const row of restored.bookmarks) {
      if (row.addedAt < from) from = row.addedAt;
      if (row.addedAt > to) to = row.addedAt;
    }
    return {
      ok: true,
      parser: "backup",
      warnings: [],
      skipped: restored.skipped,
      duplicates: 0,
      internalDuplicates: 0,
      total: restored.bookmarks.length,
      folderCount: restored.folders.length,
      span: Number.isFinite(from) ? { from, to } : undefined,
      sample: restored.bookmarks.slice(0, 6).map((row) => ({ title: row.title, url: row.url, folder: "" })),
      bookmarks: [],
      newFolders: [],
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "That backup could not be read",
      parser: "backup",
      warnings: [],
      skipped: 0,
      duplicates: 0,
      internalDuplicates: 0,
      total: 0,
      folderCount: 0,
      sample: [],
      bookmarks: [],
      newFolders: [],
    };
  }
}

export interface JobState {
  running: boolean;
  done: number;
  total: number;
  label: string;
  /** Failures are surfaced rather than silently swallowed. */
  failed: number;
  /** False for work that cannot be interrupted safely (an import mid-write). */
  cancellable?: boolean;
}

const IDLE_JOB: JobState = { running: false, done: 0, total: 0, label: "", failed: 0 };
const UNDO_LIMIT = 40;

/**
 * How many rows the first paint reads before showing anything.
 *
 * Sized to comfortably exceed a screenful at the largest card size on the widest display,
 * so the user never sees the grid end at a boundary that is an artefact of loading. The
 * remainder follows immediately; this is a head start, not a page size.
 */
const FIRST_PAINT_ROWS = 240;
/** Meta key recording that old word tags have been replaced with topic tags. */
const TOPIC_TAGS_MIGRATION = "migration:topic-tags";

/**
 * Batch sizes for user-initiated jobs.
 *
 * Larger than the background pipeline's, because somebody is watching these and the
 * politeness budget can be spent on the thing they asked for.
 */
const JOB_CAPTURE_BATCH = 6;
const JOB_ENRICH_BATCH = 6;
const JOB_HEALTH_BATCH = 40;

/**
 * An undoable change: the previous version of every row it touched, plus the ids of rows
 * that did not exist before (which undo removes).
 *
 * `before` is a *diff*, not a row. Complete `Bookmark` objects are the obvious
 * implementation and quietly enormous — a bookmark carries an embedded base64 favicon and
 * a scraped text blob, so one entry for a whole-import delete of 5,000 rows put hundreds
 * of megabytes on a stack that holds forty of them. Deletions are the exception and carry
 * the whole row, because there is nothing left to patch.
 */
type Patch =
  | { id: string; fields: Partial<Bookmark>; whole?: undefined }
  | { id: string; whole: Bookmark; fields?: undefined };

interface Mutation {
  label: string;
  before: Patch[];
  createdIds: string[];
}

/**
 * Fields that differ between two versions of a row.
 *
 * Compared by reference for objects and arrays rather than deeply: every mutation path
 * here produces new objects for the parts it changes and reuses the parts it does not —
 * which is what makes the memoised cards work at all — so reference equality is both
 * correct and cheap. `undefined` is written explicitly for a field that was present and is
 * now gone, because a patch that merely omits it would leave the current value in place,
 * which is how an "undo archive" quietly fails to un-archive anything.
 */
function diffRow(before: Bookmark, after: Bookmark): Partial<Bookmark> {
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const left = (before as unknown as Record<string, unknown>)[key];
    const right = (after as unknown as Record<string, unknown>)[key];
    if (left !== right) patch[key] = left;
  }
  return patch as Partial<Bookmark>;
}

function applyPatch(current: Bookmark | undefined, patch: Patch): Bookmark | null {
  if (patch.whole) return patch.whole;
  if (!current) return null;
  return { ...current, ...patch.fields };
}

export function useLibrary() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [imports, setImports] = useState<ImportBatch[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [smart, setSmart] = useState<SmartCollection[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  /**
   * True between the first painted rows and the complete library.
   *
   * Separate from `loading`, which means "there is nothing to draw". During hydration
   * there *is* something to draw and it is correct as far as it goes — but the counts are
   * not final, so the interface says so rather than showing a total that changes a moment
   * later with no explanation.
   */
  const [hydrating, setHydrating] = useState(true);
  const [job, setJob] = useState<JobState>(IDLE_JOB);
  const [serverStatus, setServerStatus] = useState<api.ServerStatus>({
    online: false,
    screenshots: false,
  });
  const [pipeline, setPipeline] = useState<PipelineState>(() => pipelineState());

  /**
   * The undo/redo stacks live in refs, not state.
   *
   * Applying a mutation is a side effect, and React double-invokes state updaters in
   * development — running it inside one would apply the change twice and record a
   * corrupted inverse. `stackSizes` exists only so the toolbar re-renders when the buttons
   * should appear.
   */
  const undoRef = useRef<Mutation[]>([]);
  const redoRef = useRef<Mutation[]>([]);
  const [stackSizes, setStackSizes] = useState({ undo: 0, redo: 0 });
  const syncStacks = useCallback(() => {
    setStackSizes({ undo: undoRef.current.length, redo: redoRef.current.length });
  }, []);
  const cancelJob = useRef(false);

  /**
   * The search index, held rather than derived.
   *
   * It takes writes (see `lib/tfidf.ts`), so it lives in a ref and is *updated* rather
   * than replaced. `indexVersion` tells React the contents changed, so the handful of
   * derivations that read the whole index — the spelling vocabulary — know to recompute.
   * A full rebuild is reserved for the three moments the corpus is genuinely replaced:
   * opening, importing, and restoring.
   */
  const textIndexRef = useRef<TfIdfIndex>(new TfIdfIndex([]));
  const [indexVersion, setIndexVersion] = useState(0);
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const smartRef = useRef(smart);
  smartRef.current = smart;
  const folderPathsRef = useRef<Map<string, string>>(new Map());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const rebuildToken = useRef(0);
  const rebuildTextIndex = useCallback(async (rows: Bookmark[], paths: Map<string, string>) => {
    const token = ++rebuildToken.current;
    const built = await buildIndexAsync(rows, paths);
    // A rebuild started before a faster one finishes must not overwrite the newer result:
    // a stale index arriving late is a library that has silently forgotten its last import.
    if (token !== rebuildToken.current) return;
    textIndexRef.current = built;
    setIndexVersion((version) => version + 1);
  }, []);

  /**
   * Folds changed rows into the text index in place.
   *
   * One `bulk` call rather than a loop of `add`, because each write invalidates every
   * cached norm — so a loop over five hundred rows would throw the cache away five hundred
   * times and hand the next search a cold index anyway.
   */
  const reindexRows = useCallback((changed: Bookmark[], removed: readonly string[] = []) => {
    textIndexRef.current.bulk({
      add: changed.map((row) => toIndexDoc(row, folderPathsRef.current)),
      remove: [...removed],
    });
    setIndexVersion((version) => version + 1);
  }, []);

  /* ------------------------------------------------------- chrome bookmarks -- */

  /**
   * Folds a Chrome-originated bookmark change straight into state and storage.
   *
   * The minimal half of `commit` — persistence, reindex, cross-tab announcement — with
   * no undo entry and no activity record. A change that happened on the Chrome side is
   * not something this app's own undo stack should try to reverse, and every bookmark
   * bar edit logging an activity row would drown out everything this app actually did.
   */
  const applyChromeBookmarkChanges = useCallback(
    (next: Bookmark[], remove: string[] = []) => {
      if (!next.length && !remove.length) return;
      const current = bookmarksRef.current;
      const nextById = new Map(next.map((row) => [row.id, row]));
      const removing = new Set(remove);
      const survivors = current.filter((row) => !removing.has(row.id)).map((row) => nextById.get(row.id) ?? row);
      const created = next.filter((row) => !current.some((existing) => existing.id === row.id));
      const updated = created.length ? [...created, ...survivors] : survivors;

      setBookmarks(updated);
      bookmarksRef.current = updated;
      reindexRows(next, remove);
      void db.putBookmarks(next);
      if (remove.length) void db.deleteBookmarks(remove);
      announceCommit({ changed: next.map((row) => row.id), removed: remove });
    },
    [reindexRows],
  );

  /** The folder-tree counterpart, mirroring how `createFolder`/`renameFolder` already
   *  write outside `commit` — folders have never gone through the undo stack. */
  const applyChromeFolderChanges = useCallback((next: Folder[], remove: string[] = []) => {
    if (!next.length && !remove.length) return;
    const current = foldersRef.current;
    const nextById = new Map(next.map((row) => [row.id, row]));
    const removing = new Set(remove);
    const survivors = current.filter((row) => !removing.has(row.id)).map((row) => nextById.get(row.id) ?? row);
    const created = next.filter((row) => !current.some((existing) => existing.id === row.id));
    const updated = created.length ? [...survivors, ...created] : survivors;

    setFolders(updated);
    foldersRef.current = updated;
    void db.putFolders(next);
    if (remove.length) void db.deleteFolders(remove);
  }, []);

  /** Detaches the Chrome bookmarks listeners on unmount. A no-op until sync starts. */
  const chromeSyncCleanupRef = useRef<() => void>(() => undefined);

  /**
   * Reads the whole Chrome tree and folds it in, then (re)builds the text index over the
   * result. Used both on first open and after a bulk change on the Chrome side (its own
   * "import bookmarks" dialog, for instance) that would be wasteful to apply event by
   * event.
   */
  const reconcileAndReindex = useCallback(async () => {
    const result = await reconcileChromeBookmarks(bookmarksRef.current, foldersRef.current);
    applyChromeFolderChanges(result.folders);
    applyChromeBookmarkChanges(result.bookmarks, result.removedBookmarkIds);

    const removedSet = new Set(result.removedBookmarkIds);
    const freshById = new Map(result.bookmarks.map((row) => [row.id, row]));
    const merged = [
      ...result.bookmarks,
      ...bookmarksRef.current.filter((row) => !freshById.has(row.id) && !removedSet.has(row.id)),
    ];
    void rebuildTextIndex(merged, buildFolderPaths(result.folders));
    return result;
  }, [applyChromeBookmarkChanges, applyChromeFolderChanges, rebuildTextIndex]);


  /**
   * Starts two-way sync with the browser's bookmarks, when it is allowed and reachable.
   *
   * Inside the extension this runs on every open. On the website it runs when the person
   * switches it on (Settings → Sources) with the extension installed. Idempotent: a second
   * call tears down the previous listeners first.
   */
  const startBrowserSync = useCallback(async (): Promise<boolean> => {
    if (!isChromeBookmarksAvailable()) return false;
    try {
      chromeSyncCleanupRef.current();
      await reconcileAndReindex();

      setSources((current) => {
        if (current.some((source) => source.id === CHROME_SOURCE_ID)) return current;
        const chromeSource: Source = {
          id: CHROME_SOURCE_ID,
          kind: "browser",
          name: IS_EXTENSION ? "Chrome" : "This browser",
          browser: "Chrome",
          createdAt: Date.now(),
          syncedAt: Date.now(),
          resyncable: false,
        };
        void db.putSources([chromeSource]);
        return [...current, chromeSource];
      });

      chromeSyncCleanupRef.current = startChromeSync({
        onBookmarkUpserted: (bookmark) => applyChromeBookmarkChanges([bookmark]),
        onBookmarkRemoved: (ids) => applyChromeBookmarkChanges([], ids),
        onFolderUpserted: (folder) => applyChromeFolderChanges([folder]),
        onFolderRemoved: (ids) => applyChromeFolderChanges([], ids),
        onBulkChange: () => void reconcileAndReindex(),
        getBookmarks: () => bookmarksRef.current,
        getFolders: () => foldersRef.current,
      });
      return true;
    } catch {
      // Unreadable for some reason (permission not yet granted after an update, the
      // extension reloaded underneath the website) — the library keeps what it has.
      return false;
    }
  }, [reconcileAndReindex, applyChromeBookmarkChanges, applyChromeFolderChanges]);

  /** Switches browser-bookmark sync on or off (the website's opt-in; always on in the extension). */
  const setBrowserSync = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      allowBrowserSync(enabled);
      const next = { ...settingsRef.current, browserSync: enabled };
      setSettings(next);
      void db.saveSettings(next);
      if (!enabled) {
        chromeSyncCleanupRef.current();
        chromeSyncCleanupRef.current = () => undefined;
        toast("Stopped syncing with this browser", {
          description: "Bookmarks already here are kept.",
        });
        return true;
      }
      if (!canReachBrowserBookmarks()) {
        toast.error("The extension is not connected", {
          description: "Install the Bookmark Studio extension, then reload this page.",
        });
        return false;
      }
      const ok = await startBrowserSync();
      if (ok) toast.success("Syncing with this browser's bookmarks");
      else toast.error("Could not read this browser's bookmarks");
      return ok;
    },
    [startBrowserSync],
  );

  /* ------------------------------------------------------------- opening -- */

  useEffect(() => {
    let active = true;
    // The asset ledger is read alongside the library so the first painted screen can
    // resolve its previews synchronously instead of flashing placeholders.
    void initAssets();

    /**
     * Opening the library in two passes.
     *
     * The first asks the database for the newest screenful *by index* and paints it; the
     * second reads the remainder and folds it in. The order is the one the default sort
     * would have produced, so nothing moves when the rest lands.
     *
     * The whole library still loads, because every derivation is a pure function over a
     * complete array — a library that reported "3 results" while still loading would be
     * worse than one that took a moment longer to open.
     */
    const open = async () => {
      const [shell, log, stored] = await Promise.all([
        db.loadShell(),
        db.loadActivity(),
        db.loadSettings(),
      ]);
      if (!active) return;

      setFolders(shell.folders);
      foldersRef.current = shell.folders;
      setBoards(shell.boards);
      setImports(shell.imports);
      setSources(shell.sources);
      setSmart(shell.smart);
      setActivity(log);
      setSettings(stored);
      setAssetBudget(stored.assetBudgetMb);

      const pin = (rows: Bookmark[]) => {
        // Bytes the library owns rather than caches must never be evicted. Re-pinned on
        // every open, since the pin set is per-session.
        for (const row of rows) {
          if (row.media?.assetKey) pinAsset(row.media.assetKey);
          if (row.media?.posterKey) pinAsset(row.media.posterKey);
          if (row.offline?.assetKey) pinAsset(row.offline.assetKey);
        }
      };

      const first = await db.loadFirstPage(FIRST_PAINT_ROWS);
      if (!active) return;
      if (first.length) {
        pin(first);
        setBookmarks(first);
        bookmarksRef.current = first;
        setLoading(false);
      }

      // A library written before the compound index exists returns an empty first page;
      // the whole-store read below is then the only path.
      const rest = await db.loadRest(new Set(first.map((row) => row.id)));
      if (!active) return;
      pin(rest);
      let all = [...first, ...rest];

      // One-time clean-up of word tags written by earlier versions (see `retagDerived`).
      if (!(await db.getMeta<boolean>(TOPIC_TAGS_MIGRATION))) {
        const retagged = retagDerived(all, buildFolderPaths(shell.folders), suggestTags, isTopicTag);
        if (retagged.length) {
          await db.putBookmarks(retagged);
          const byId = new Map(retagged.map((row) => [row.id, row]));
          all = all.map((row) => byId.get(row.id) ?? row);
        }
        await db.setMeta(TOPIC_TAGS_MIGRATION, true);
        if (!active) return;
      }
      setBookmarks(all);
      bookmarksRef.current = all;
      setLoading(false);
      setHydrating(false);
      void rebuildTextIndex(all, buildFolderPaths(shell.folders));

      /*
        The extension build has no import dialog — the library *is* the browser's
        bookmarks. `reconcileAndReindex` catches up on anything that changed while this
        tab (or the extension's own service worker) was not running; `startChromeSync`
        takes over from there for as long as this tab stays open.
      */
      allowBrowserSync(stored.browserSync);
      await startBrowserSync();
    };

    open().catch((error: unknown) => {
      if (!active) return;
      /*
        Say which failure this is.

        A second tab holding the database open needs that tab closed, private browsing
        needs a normal window, blocked site data needs a settings change — and none of them
        share a remedy. The toast does not auto-dismiss, because an unopened library is not
        transient: nothing else works until it is resolved.
      */
      const message =
        error instanceof db.StorageUnavailableError
          ? error.message
          : "Your library could not be opened. Reloading usually fixes it; if it does not, another tab may have it open.";
      toast.error(message, { duration: Infinity });
      setLoading(false);
      setHydrating(false);
    });

    void api.getServerStatus().then((status) => active && setServerStatus(status));
    return () => {
      active = false;
      chromeSyncCleanupRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on mount
  }, []);

  /**
   * Another tab wrote to the same database.
   *
   * Reconciled by re-reading the affected rows rather than by trusting what was sent: the
   * database is the only copy both tabs agree on. A whole-library replace is not
   * reconciled at all — there is no per-row answer to "the library you were holding no
   * longer exists".
   */
  useEffect(
    () =>
      subscribeSync((notice) => {
        if (notice.kind === "replace") {
          void db.loadSnapshot().then((snapshot) => {
            setBookmarks(snapshot.bookmarks);
            bookmarksRef.current = snapshot.bookmarks;
            setFolders(snapshot.folders);
            foldersRef.current = snapshot.folders;
            setBoards(snapshot.boards);
            setImports(snapshot.imports);
            setSources(snapshot.sources);
            setSmart(snapshot.smart);
            void rebuildTextIndex(snapshot.bookmarks, buildFolderPaths(snapshot.folders));
            toast("The library was replaced in another tab", {
              description: "This tab has been brought up to date.",
            });
          });
          return;
        }

        void db.loadSnapshot().then((snapshot) => {
          const fresh = new Map(snapshot.bookmarks.map((row) => [row.id, row]));
          const removed = new Set(notice.removed);
          const current = bookmarksRef.current;
          const merged: Bookmark[] = [];
          for (const row of current) {
            if (removed.has(row.id)) continue;
            merged.push(fresh.get(row.id) ?? row);
          }
          // A row that exists in the database and in no tab's memory is the one case where
          // "trust the database" means adding rather than replacing.
          const known = new Set(merged.map((row) => row.id));
          for (const id of notice.changed) {
            const row = fresh.get(id);
            if (row && !known.has(id)) merged.push(row);
          }
          setBookmarks(merged);
          bookmarksRef.current = merged;
          reindexRows(
            notice.changed.flatMap((id) => {
              const row = fresh.get(id);
              return row ? [row] : [];
            }),
            notice.removed,
          );
        });
      }),
    [rebuildTextIndex, reindexRows],
  );

  /**
   * Keep the server-status badge honest over the life of the tab.
   *
   * Asymmetric on purpose: while offline it retries briskly so recovery is noticed within
   * seconds, and while online it settles into a slow heartbeat, because a server that dies
   * is already reported by whichever request fails first.
   */
  useEffect(() => {
    let active = true;
    const interval = serverStatus.online ? 60_000 : 5_000;
    const timer = setInterval(() => {
      void api.getServerStatus().then((status) => {
        if (!active) return;
        setServerStatus((current) =>
          current.online === status.online && current.screenshots === status.screenshots
            ? current
            : status,
        );
      });
    }, interval);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [serverStatus.online]);

  /* ---------------------------------------------------------- derivations -- */

  const folderPaths = useMemo(() => buildFolderPaths(folders), [folders]);
  folderPathsRef.current = folderPaths;

  /**
   * The selection index, rebuilt when the library or the folder tree changes.
   *
   * This is the one expensive derivation in the app and it is deliberately keyed to the
   * *identity* of the bookmarks array, which `commit` replaces exactly once per mutation.
   * Everything else — search, facet counts, smart-collection membership, the sidebar's
   * badges — reads this and costs a linear pass over typed arrays.
   */
  const index = useMemo<LibraryIndex>(
    () => buildLibraryIndex(bookmarks, folderPaths),
    [bookmarks, folderPaths],
  );

  const facets = useMemo(() => countFacets(index), [index]);

  const textIndex = textIndexRef.current;

  /**
   * The library's own words, for spelling correction.
   *
   * Keyed to the index's *contents* rather than its identity — the instance is stable, so
   * that is the only signal there is. The trigram buckets cost real work to assemble and
   * only change when the indexed text does, so typing in the search box must never rebuild
   * them.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed to index contents, not identity
  const vocabulary = useMemo(() => new Vocabulary(textIndexRef.current.vocabulary()), [indexVersion]);

  const sourceList = useMemo<SourceWithCount[]>(
    () => sourcesWithCounts(sources, bookmarks),
    [sources, bookmarks],
  );

  const importList = useMemo(
    () =>
      imports.map((batch) => ({
        ...batch,
        liveCount: facets.imports.get(batch.id) ?? 0,
      })),
    [imports, facets],
  );

  /* -------------------------------------------------------------- commit -- */

  const logActivity = useCallback(
    (kind: ActivityEntry["kind"], summary: string, count: number, undoable = false) => {
      const entry: ActivityEntry = {
        id: newId("act"),
        at: Date.now(),
        kind,
        summary,
        count,
        undoable,
      };
      setActivity((current) => [entry, ...current].slice(0, 200));
      void db.appendActivity(entry);
    },
    [],
  );

  const commit = useCallback(
    (options: {
      label: string;
      kind: ActivityEntry["kind"];
      /** Rows to update or insert. */
      next: Bookmark[];
      /** Ids to remove. */
      remove?: string[];
      /** Skip the undo entry for background jobs that only add derived data. */
      undoable?: boolean;
      /** Whether the change affects searchable text. */
      reindex?: boolean;
      silent?: boolean;
    }) => {
      const { label, kind, next, remove = [], undoable = true, reindex = true, silent } = options;
      if (!next.length && !remove.length) return;

      const current = bookmarksRef.current;
      const byId = new Map(current.map((bookmark) => [bookmark.id, bookmark]));

      const before: Patch[] = [];
      const created: Bookmark[] = [];
      for (const row of next) {
        const previous = byId.get(row.id);
        if (previous) before.push({ id: row.id, fields: diffRow(previous, row) });
        else created.push(row);
      }
      const createdIds = created.map((row) => row.id);
      for (const id of remove) {
        const previous = byId.get(id);
        // A deletion must carry the whole row: after the commit there is nothing left for
        // a patch to be applied to.
        if (previous) before.push({ id, whole: previous });
      }

      const nextById = new Map(next.map((row) => [row.id, row]));
      const removing = new Set(remove);
      const survivors = current
        .filter((bookmark) => !removing.has(bookmark.id))
        .map((bookmark) => nextById.get(bookmark.id) ?? bookmark);

      /*
       * New rows go in front, in the order supplied, as one concatenation.
       *
       * A loop of `unshift` was quadratic — a 5,000-row restore did twelve million element
       * moves on the main thread — and reversed the batch, because each successive row
       * displaced the one before it.
       */
      const updated = created.length ? [...created, ...survivors] : survivors;

      setBookmarks(updated);
      bookmarksRef.current = updated;
      if (reindex) reindexRows(next, remove);

      // Persistence happens here, outside any state updater.
      void db.putBookmarks(next);
      if (remove.length) void db.deleteBookmarks(remove);
      announceCommit({ changed: next.map((row) => row.id), removed: remove });

      if (undoable) {
        undoRef.current = [
          ...undoRef.current.slice(-(UNDO_LIMIT - 1)),
          { label, before, createdIds },
        ];
        redoRef.current = [];
        syncStacks();
      }
      if (!silent) logActivity(kind, label, next.length + remove.length, undoable);
    },
    [logActivity, syncStacks, reindexRows],
  );

  const applyMutation = useCallback(
    (mutation: Mutation): Mutation => {
      const current = bookmarksRef.current;
      const byId = new Map(current.map((bookmark) => [bookmark.id, bookmark]));

      const restored: Bookmark[] = [];
      for (const patch of mutation.before) {
        const row = applyPatch(byId.get(patch.id), patch);
        if (row) restored.push(row);
      }

      /*
       * Capture the inverse before applying, so the change can be re-applied later.
       *
       * This records the *current* version of every row the mutation touches, not just the
       * created ones: undoing an edit has to remember the edited row, or redo has nothing
       * to put back.
       */
      const inverse: Mutation = {
        label: mutation.label,
        before: [
          ...restored.flatMap<Patch>((row) => {
            const now = byId.get(row.id);
            return now ? [{ id: row.id, fields: diffRow(now, row) }] : [];
          }),
          ...mutation.createdIds.flatMap<Patch>((id) => {
            const row = byId.get(id);
            return row ? [{ id, whole: row }] : [];
          }),
        ],
        createdIds: restored.filter((row) => !byId.has(row.id)).map((row) => row.id),
      };

      const restoring = new Map(restored.map((row) => [row.id, row]));
      const removing = new Set(mutation.createdIds);
      const survivors = current
        .filter((bookmark) => !removing.has(bookmark.id))
        .map((bookmark) => restoring.get(bookmark.id) ?? bookmark);

      const reborn = restored.filter((row) => !byId.has(row.id));
      const updated = reborn.length ? [...reborn, ...survivors] : survivors;

      setBookmarks(updated);
      bookmarksRef.current = updated;
      reindexRows(restored, mutation.createdIds);
      void db.putBookmarks(restored);
      if (mutation.createdIds.length) void db.deleteBookmarks(mutation.createdIds);
      announceCommit({ changed: restored.map((row) => row.id), removed: mutation.createdIds });

      return inverse;
    },
    [reindexRows],
  );

  const undo = useCallback(() => {
    const mutation = undoRef.current[undoRef.current.length - 1];
    if (!mutation) {
      toast("Nothing to undo");
      return;
    }
    const inverse = applyMutation(mutation);
    undoRef.current = undoRef.current.slice(0, -1);
    redoRef.current = [...redoRef.current, inverse];
    syncStacks();
    toast.success(`Undid: ${mutation.label}`);
  }, [applyMutation, syncStacks]);

  const redo = useCallback(() => {
    const mutation = redoRef.current[redoRef.current.length - 1];
    if (!mutation) {
      toast("Nothing to redo");
      return;
    }
    const inverse = applyMutation(mutation);
    redoRef.current = redoRef.current.slice(0, -1);
    undoRef.current = [...undoRef.current, inverse];
    syncStacks();
    toast.success(`Redid: ${mutation.label}`);
  }, [applyMutation, syncStacks]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      void db.saveSettings(next);
      return next;
    });
  }, []);

  const rowsFor = useCallback((ids: string[]) => {
    const wanted = new Set(ids);
    return bookmarksRef.current.filter((bookmark) => wanted.has(bookmark.id));
  }, []);

  /* -------------------------------------------------------------- imports -- */

  /**
   * Removes an import and every bookmark it brought in.
   *
   * The counterpart to recording provenance, and the reason recording it is worth
   * anything: importing the wrong file is a mistake people make constantly, and the only
   * other remedies are deleting hundreds of rows by hand or wiping the library. Folders
   * the import created are removed only if nothing else is filed in them.
   */
  const deleteImport = useCallback(
    async (batchId: string) => {
      const batch = imports.find((entry) => entry.id === batchId);
      const doomed = bookmarksRef.current.filter((row) => row.importId === batchId);

      if (doomed.length) {
        commit({
          label: `Removed the “${batch?.name ?? "import"}” import`,
          kind: "delete",
          next: [],
          remove: doomed.map((row) => row.id),
        });
      }

      const occupied = new Set(
        bookmarksRef.current.map((row) => row.folderId).filter(Boolean) as string[],
      );
      const emptied = foldersRef.current.filter(
        (folder) => folder.importId === batchId && !occupied.has(folder.id),
      );
      if (emptied.length) {
        const doomedIds = new Set(emptied.map((folder) => folder.id));
        const remaining = foldersRef.current.filter((folder) => !doomedIds.has(folder.id));
        setFolders(remaining);
        foldersRef.current = remaining;
        void db.deleteFolders([...doomedIds]);
      }

      const nextImports = imports.filter((entry) => entry.id !== batchId);
      setImports(nextImports);
      await db.deleteImport(batchId);

      logActivity("delete", `Removed the import “${batch?.name ?? batchId}”`, doomed.length, true);
      toast.success(`Removed ${doomed.length} bookmark${doomed.length === 1 ? "" : "s"}`, {
        description: emptied.length
          ? `${emptied.length} folder${emptied.length === 1 ? "" : "s"} left empty were removed too.`
          : "The import is gone from the sidebar.",
        action: { label: "Undo", onClick: () => undo() },
      });
    },
    [commit, imports, logActivity, undo],
  );

  const renameImport = useCallback((batchId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setImports((current) => {
      const next = current.map((entry) =>
        entry.id === batchId ? { ...entry, name: trimmed } : entry,
      );
      const changed = next.find((entry) => entry.id === batchId);
      if (changed) void db.putImports([changed]);
      return next;
    });
  }, []);


  /**
   * Reads a file without writing anything, for the import dialog's review step.
   *
   * The real pipeline in `previewOnly` mode — the same parser, normaliser and duplicate
   * check the import will use — so the numbers the dialog promises are the numbers it
   * delivers.
   */
  const previewImport = useCallback(
    async (options: ImportRunOptions): Promise<ImportOutcome> => {
      if (options.source.id === "backup") return previewBackup(options.file);
      const replacing = options.mode === "replace";
      const kept = replacing ? keptOnReplace(bookmarksRef.current) : bookmarksRef.current;
      return runImport({
        file: options.file,
        source: options.source,
        csvColumns: options.csvColumns,
        text: options.text,
        keepDuplicates: options.keepDuplicates,
        previewOnly: true,
        existingUrls: kept.filter((row) => !row.trashedAt && row.url).map((row) => row.url),
        folders: replacing ? [] : foldersRef.current,
        importId: "preview",
        importedAt: Date.now(),
        sourceId: "preview",
      });
    },
    [],
  );

  /** Restores a JSON backup written by this app — ids, folders, boards, notes, history. */
  const restoreBackup = useCallback(
    async (file: File, mode: "merge" | "replace"): Promise<ImportOutcome | null> => {
      let restored: Awaited<ReturnType<typeof parseBackupFile>>;
      try {
        restored = await parseBackupFile(file);
      } catch (error) {
        toast.error("That backup could not be read", {
          description: error instanceof Error ? error.message : undefined,
        });
        return null;
      }
      const replacing = mode === "replace";
      const keptRows = replacing ? keptOnReplace(bookmarksRef.current) : bookmarksRef.current;
      const merged = mergeBackup(restored, {
        bookmarks: keptRows,
        folders: replacing ? foldersRef.current.filter((folder) => !folder.importId) : foldersRef.current,
        boards: replacing ? [] : boards,
        imports: replacing ? [] : imports,
      });

      if (replacing) {
        const keepIds = new Set(keptRows.map((row) => row.id));
        const doomed = bookmarksRef.current.filter((row) => !keepIds.has(row.id)).map((row) => row.id);
        if (doomed.length) {
          commit({ label: "Cleared for restore", kind: "delete", next: [], remove: doomed, undoable: false, silent: true, reindex: false });
        }
      }

      setFolders(merged.folders);
      foldersRef.current = merged.folders;
      void db.putFolders(merged.folders);
      setBoards(merged.boards);
      void db.putBoards(merged.boards);
      setImports(merged.imports);
      void db.putImports(merged.imports);

      commit({
        label: `Restored ${restored.bookmarks.length.toLocaleString()} from a backup`,
        kind: "import",
        next: restored.bookmarks,
        undoable: !replacing,
        reindex: false,
      });
      void rebuildTextIndex(bookmarksRef.current, buildFolderPaths(merged.folders));

      toast.success(`Restored ${restored.bookmarks.length.toLocaleString()} bookmarks`, {
        description: `${merged.added.toLocaleString()} new, ${merged.updated.toLocaleString()} updated.`,
      });
      return {
        ok: true,
        parser: "backup",
        warnings: [],
        skipped: restored.skipped,
        duplicates: 0,
        internalDuplicates: 0,
        total: restored.bookmarks.length,
        folderCount: restored.folders.length,
        sample: [],
        bookmarks: [],
        newFolders: [],
      };
    },
    [boards, imports, commit, rebuildTextIndex],
  );

  /**
   * Imports a file from any of the supported sources.
   *
   * Every row is stamped with the batch it arrived in and the standing source it came
   * from, so the import can be removed wholesale later and a re-import of the same browser
   * folds into the same sidebar entry rather than stacking a new one.
   */
  const importFile = useCallback(
    async (options: ImportRunOptions & { label?: string }): Promise<ImportOutcome | null> => {
      const { file, source, csvColumns, mode, keepDuplicates, label } = options;
      if (source.id === "backup") return restoreBackup(file, mode);

      const importId = newId("imp");
      const importedAt = Date.now();
      const existingSource = matchSource(sources, source.kind, source.name);
      const standing: Source = existingSource
        ? { ...existingSource, syncedAt: importedAt }
        : createSource(source.kind, source.name, {
            browser: source.group === "Browsers" ? source.name : undefined,
          });

      const replacing = mode === "replace";
      const keptRows = replacing ? keptOnReplace(bookmarksRef.current) : bookmarksRef.current;
      const keptFolders = replacing
        ? foldersRef.current.filter((folder) => keptRows.some((row) => row.folderId === folder.id) || !folder.importId)
        : foldersRef.current;

      setJob({ running: true, label: `Importing ${file.name}`, done: 0, total: 1, failed: 0, cancellable: false });
      let outcome: ImportOutcome;
      try {
        outcome = await runImport({
          file,
          source,
          csvColumns,
          text: options.text,
          keepDuplicates,
          existingUrls: keptRows.filter((row) => !row.trashedAt && row.url).map((row) => row.url),
          folders: keptFolders,
          importId,
          importedAt,
          sourceId: standing.id,
          onProgress: (progress) =>
            setJob((current) => ({ ...current, done: progress.done, total: Math.max(progress.total, 1) })),
        });
      } finally {
        setJob(IDLE_JOB);
      }

      if (!outcome.ok) {
        toast.error("That file could not be imported", { description: outcome.error });
        return outcome;
      }
      if (!outcome.bookmarks.length) {
        toast("Nothing new to import", {
          description: outcome.duplicates
            ? `All ${outcome.duplicates.toLocaleString()} links are already in the library.`
            : "The file had no links this importer could read.",
        });
        return outcome;
      }

      if (replacing) {
        const keepIds = new Set(keptRows.map((row) => row.id));
        const doomed = bookmarksRef.current.filter((row) => !keepIds.has(row.id)).map((row) => row.id);
        if (doomed.length) {
          commit({ label: "Cleared for import", kind: "delete", next: [], remove: doomed, undoable: false, silent: true, reindex: false });
        }
        const keepFolderIds = new Set(keptFolders.map((folder) => folder.id));
        const doomedFolders = foldersRef.current.filter((folder) => !keepFolderIds.has(folder.id)).map((folder) => folder.id);
        if (doomedFolders.length) void db.deleteFolders(doomedFolders);
        foldersRef.current = keptFolders;
      }

      const nextFolders = [...foldersRef.current, ...outcome.newFolders];
      setFolders(nextFolders);
      foldersRef.current = nextFolders;
      if (outcome.newFolders.length) void db.putFolders(outcome.newFolders);

      const count = outcome.bookmarks.length;
      commit({
        label: `Imported ${count.toLocaleString()} from ${file.name}`,
        kind: "import",
        next: outcome.bookmarks,
        reindex: false,
      });
      void rebuildTextIndex(bookmarksRef.current, buildFolderPaths(nextFolders));

      const batch: ImportBatch = {
        id: importId,
        name: label?.trim() || file.name.replace(/\.[^.]+$/, "") || source.name,
        fileName: file.name,
        at: importedAt,
        format: /\.json$/i.test(file.name) ? "json" : "html",
        mode,
        bookmarkCount: count,
        folderCount: outcome.folderCount,
        duplicateCount: outcome.duplicates,
      };
      setImports((current) => [batch, ...current]);
      void db.putImports([batch]);

      setSources((current) =>
        current.some((entry) => entry.id === standing.id)
          ? current.map((entry) => (entry.id === standing.id ? standing : entry))
          : [...current, standing],
      );
      void db.putSources([standing]);

      toast.success(`Imported ${count.toLocaleString()} bookmark${count === 1 ? "" : "s"}`, {
        description: [
          outcome.folderCount ? `${outcome.folderCount.toLocaleString()} folders` : "",
          outcome.duplicates ? `${outcome.duplicates.toLocaleString()} already here` : "",
          outcome.skipped ? `${outcome.skipped.toLocaleString()} unreadable rows skipped` : "",
        ]
          .filter(Boolean)
          .join(" · ") || `From ${source.name}.`,
        action: replacing ? undefined : { label: "Undo", onClick: () => undo() },
      });
      return outcome;
    },
    [sources, commit, rebuildTextIndex, restoreBackup, undo],
  );

  /* -------------------------------------------------------------- export -- */

  const exportLibrary = useCallback(
    (subset?: Bookmark[], format: "html" | "json" | "csv" = "html") => {
      const list = subset ?? bookmarksRef.current.filter((row) => !row.trashedAt);
      const stamp = new Date().toISOString().slice(0, 10);

      if (format === "json") {
        /*
         * The complete format, and it has to actually be complete.
         *
         * Batches ship alongside the rows that cite them. Without them a restore reads
         * `importId`s pointing at nothing and has to clear them — losing the Imports rail,
         * "Recently added", and the ability to undo one import wholesale, on a round trip
         * through the app's own backup.
         */
        const cited = new Set(list.map((bookmark) => bookmark.importId).filter(Boolean));
        downloadFile(
          JSON.stringify(
            {
              exportedAt: Date.now(),
              folders,
              boards,
              imports: imports.filter((batch) => cited.has(batch.id)),
              bookmarks: list,
            },
            null,
            2,
          ),
          `bookmarks-${stamp}.json`,
          "application/json",
        );
      } else if (format === "csv") {
        const columns = ["title", "url", "domain", "category", "tags", "folder", "added", "health", "visits"];
        const escape = (value: string) => `"${String(value).replace(/"/g, '""')}"`;
        const rows = list.map((bookmark) =>
          [
            bookmark.title,
            bookmark.url,
            bookmark.domain,
            bookmark.category,
            bookmark.tags.join(" "),
            bookmark.folderId ? (folderPaths.get(bookmark.folderId) ?? "") : "",
            new Date(bookmark.addedAt).toISOString(),
            bookmark.health.status,
            String(bookmark.visitCount),
          ]
            .map(escape)
            .join(","),
        );
        downloadFile([columns.join(","), ...rows].join("\n"), `bookmarks-${stamp}.csv`, "text/csv");
      } else {
        // Only ship folders that actually contain something in this subset.
        const used = new Set<string>();
        const byId = new Map(folders.map((folder) => [folder.id, folder]));
        for (const bookmark of list) {
          let folderId = bookmark.folderId;
          while (folderId) {
            if (used.has(folderId)) break;
            used.add(folderId);
            folderId = byId.get(folderId)?.parentId ?? null;
          }
        }
        downloadFile(
          serializeNetscapeBookmarks({
            folders: folders.filter((folder) => used.has(folder.id)),
            bookmarks: list
              .filter((bookmark) => bookmark.url)
              .map((bookmark) => ({
                url: bookmark.url,
                title: bookmark.title,
                description: bookmark.description,
                icon: bookmark.icon,
                addedAt: bookmark.addedAt,
                lastModifiedAt: bookmark.lastModifiedAt,
                folderId: bookmark.folderId,
                tags: bookmark.tags,
                sourceOrder: bookmark.sourceOrder,
              })),
          }),
          `bookmarks-${stamp}.html`,
        );
      }

      logActivity("export", `Exported ${list.length} bookmarks as ${format.toUpperCase()}`, list.length);
      toast.success(`Exported ${list.length.toLocaleString()} bookmarks`, {
        description:
          format === "html"
            ? "Netscape HTML — re-importable by any browser."
            : `${format.toUpperCase()} file`,
      });
    },
    [folders, boards, imports, folderPaths, logActivity],
  );

  /* ----------------------------------------------------------------- CRUD -- */

  const addBookmark = useCallback(
    async (input: { url: string; title: string; folderId: string | null; tags?: string[]; note?: string }) => {
      const checked = normalizeUserUrl(input.url);
      if (!checked.ok) {
        toast.error(checked.error);
        return null;
      }
      const url = checked.url;
      const key = canonicalUrl(url);
      if (bookmarksRef.current.some((bookmark) => bookmark.url && canonicalUrl(bookmark.url) === key)) {
        toast.error("That URL is already in your library");
        return null;
      }
      const title = input.title.trim() || getDomain(url);
      // Mirrored into Chrome first, so the id this row is created under is the real one —
      // there is no separate mapping table, so this is the one moment that matters.
      const chromeId = await createBookmarkNode(input.folderId, title, url);
      // Chrome has no "no folder": a bookmark placed nowhere in particular lands in
      // "Other Bookmarks", exactly where an address-bar star with no folder chosen would.
      const folderId = chromeId ? (input.folderId ?? OTHER_BOOKMARKS_ID) : input.folderId;
      const folderPath = folderId ? (folderPaths.get(folderId) ?? "") : "";
      const bookmark: Bookmark = {
        id: chromeId ?? newId("bmk"),
        url,
        title,
        domain: getDomain(url),
        description: "",
        category: classify({ url, title, folderPath }),
        tags: input.tags?.length ? input.tags : suggestTags({ url, title, folderPath }),
        folderId,
        boardIds: [],
        addedAt: Date.now(),
        importedAt: Date.now(),
        visitCount: 0,
        note: input.note,
        health: { status: "unchecked" },
        // A video's thumbnail is derivable from its URL, so it is on the card before the
        // pipeline has done anything — and a render of a YouTube watch page is player
        // chrome, not the video.
        preview: { method: "card", imageUrl: thumbnailUrl(url) ?? undefined },
        kind: isVideoUrl(url) ? "video" : undefined,
        sourceId: chromeId ? CHROME_SOURCE_ID : undefined,
      };
      commit({ label: `Added “${title}”`, kind: "create", next: [bookmark] });
      toast.success(`Saved “${title}”`, { action: { label: "Undo", onClick: () => undo() } });
      return bookmark;
    },
    [commit, folderPaths, undo],
  );

  const updateBookmark = useCallback(
    (id: string, patch: Partial<Bookmark>) => {
      const row = rowsFor([id])[0];
      if (!row) return;
      const next = { ...row, ...patch, editedAt: Date.now() };
      // A changed URL changes the domain, and the domain is indexed and displayed.
      if (patch.url && patch.url !== row.url) next.domain = getDomain(patch.url);
      if (patch.title !== undefined || patch.url !== undefined) {
        void updateBookmarkNode(id, { title: next.title, url: next.url || undefined });
      }
      commit({ label: `Edited “${next.title}”`, kind: "edit", next: [next] });
      toast.success("Bookmark updated", { action: { label: "Undo", onClick: () => undo() } });
    },
    [commit, rowsFor, undo],
  );

  const removeBookmarks = useCallback(
    (ids: string[]) => {
      const rows = rowsFor(ids);
      if (!rows.length) return;
      for (const id of ids) void removeBookmarkNode(id);
      commit({
        label: `Deleted ${rows.length} bookmark${rows.length === 1 ? "" : "s"}`,
        kind: "delete",
        next: [],
        remove: ids,
      });
      toast.success(`Deleted ${ids.length} bookmark${ids.length === 1 ? "" : "s"}`, {
        action: { label: "Undo", onClick: () => undo() },
      });
    },
    [commit, rowsFor, undo],
  );

  /**
   * Moves rows to the trash rather than destroying them.
   *
   * The other kind of delete: reversible for as long as the user likes, at the cost of the
   * rows still occupying storage — which is why emptying it is a separate, explicit act.
   *
   * Chrome itself has no trash, so the real bookmark is removed immediately — from the
   * browser's own bookmarks bar this looks exactly like an ordinary delete. Undoing it, or
   * restoring from this app's trash later, re-creates it in Chrome (see `restoreFromTrash`).
   */
  const trashBookmarks = useCallback(
    (ids: string[]) => {
      const at = Date.now();
      const rows = rowsFor(ids).map((row) => ({ ...row, trashedAt: at }));
      if (!rows.length) return;
      for (const row of rows) if (row.url) void removeBookmarkNode(row.id);
      commit({
        label: `Moved ${rows.length} to the trash`,
        kind: "trash",
        next: rows,
        reindex: false,
      });
      toast.success(`Moved ${rows.length} to the trash`, {
        description: "Nothing is deleted until the trash is emptied.",
        action: { label: "Undo", onClick: () => undo() },
      });
    },
    [commit, rowsFor, undo],
  );

  const restoreFromTrash = useCallback(
    async (ids: string[]) => {
      const rows = rowsFor(ids);
      if (!rows.length) return;

      /*
        A row that came from Chrome (or was trashed while sync was available) lost its
        real bookmark when it was trashed — Chrome has no undo-remove. Restoring one
        re-creates it, which mints a *new* Chrome id, so the local row has to change id
        too: `commit` below both adds the row under its new id and removes the old one in
        the same call, rather than leaving a duplicate behind under the id nothing points
        to any more. A note, upload or other page-less item never had a Chrome bookmark to
        lose, so it just comes back as itself.
      */
      const restored: Bookmark[] = [];
      const staleIds: string[] = [];
      for (const row of rows) {
        if (row.url && isChromeBookmarksAvailable()) {
          const chromeId = await createBookmarkNode(row.folderId, row.title, row.url);
          if (chromeId && chromeId !== row.id) {
            staleIds.push(row.id);
            restored.push({ ...row, id: chromeId, trashedAt: undefined, sourceId: CHROME_SOURCE_ID });
            continue;
          }
        }
        restored.push({ ...row, trashedAt: undefined });
      }

      commit({
        label: `Restored ${restored.length}`,
        kind: "restore",
        next: restored,
        remove: staleIds,
        reindex: false,
      });
      toast.success(`Restored ${restored.length} item${restored.length === 1 ? "" : "s"}`);
    },
    [commit, rowsFor],
  );

  /**
   * Destroys everything in the trash, and the bytes belonging to it.
   *
   * The assets go too, and they have to: an uploaded image's bytes are the only copy, so
   * leaving them behind keeps orphaned blobs nothing references and nothing can show.
   */
  const emptyTrash = useCallback(async (): Promise<number> => {
    const doomed = bookmarksRef.current.filter((row) => row.trashedAt);
    if (!doomed.length) return 0;

    for (const row of doomed) {
      if (row.media?.assetKey) await forgetAsset(row.media.assetKey);
      if (row.media?.posterKey) await forgetAsset(row.media.posterKey);
      if (row.offline?.assetKey) await forgetAsset(row.offline.assetKey);
    }
    commit({
      label: `Deleted ${doomed.length} from the trash`,
      kind: "delete",
      next: [],
      remove: doomed.map((row) => row.id),
      undoable: false,
    });
    toast.success(`Deleted ${doomed.length} item${doomed.length === 1 ? "" : "s"}`, {
      description: "This one could not be undone.",
    });
    return doomed.length;
  }, [commit]);

  /**
   * Collapses every duplicate group in the library into one merged bookmark each.
   *
   * A Duplicates view that can only show you the problem is half a feature — the reason to
   * look is to fix it, and doing so by hand across a few hundred groups is not work anyone
   * will actually do. The merge policy lives in `planDuplicateCleanup` so it stays testable
   * and out of the React layer.
   */
  const dedupeLibrary = useCallback(() => {
    const plan = planDuplicateCleanup(bookmarksRef.current);
    if (!plan.remove.length) {
      toast("No duplicates to merge");
      return 0;
    }
    commit({
      label: `Merged ${plan.groups} duplicate group${plan.groups === 1 ? "" : "s"}`,
      kind: "delete",
      next: plan.keep,
      remove: plan.remove,
    });
    toast.success(`Merged ${plan.remove.length} duplicate${plan.remove.length === 1 ? "" : "s"}`, {
      description: `${plan.groups} group${plan.groups === 1 ? "" : "s"} collapsed — tags, notes and boards were kept.`,
      action: { label: "Undo", onClick: () => undo() },
    });
    return plan.remove.length;
  }, [commit, undo]);

  const setArchived = useCallback(
    (ids: string[], archived: boolean) => {
      const rows = rowsFor(ids).map((row) => ({ ...row, archived }));
      if (!rows.length) return;
      commit({
        label: `${archived ? "Archived" : "Unarchived"} ${rows.length} bookmark${rows.length === 1 ? "" : "s"}`,
        kind: archived ? "archive" : "restore",
        next: rows,
        reindex: false,
      });
      toast.success(`${archived ? "Archived" : "Unarchived"} ${rows.length}`, {
        action: { label: "Undo", onClick: () => undo() },
      });
    },
    [commit, rowsFor, undo],
  );

  const toggleFavorite = useCallback(
    (id: string) => {
      const row = rowsFor([id])[0];
      if (!row) return;
      commit({
        label: row.favorite ? "Removed from favourites" : "Added to favourites",
        kind: "edit",
        next: [{ ...row, favorite: !row.favorite }],
        reindex: false,
        silent: true,
      });
    },
    [commit, rowsFor],
  );

  const setFavorites = useCallback(
    (ids: string[], favorite: boolean) => {
      const rows = rowsFor(ids)
        .filter((row) => Boolean(row.favorite) !== favorite)
        .map((row) => ({ ...row, favorite }));
      if (!rows.length) {
        toast(favorite ? "Already favourited" : "None were favourited");
        return;
      }
      commit({
        label: `${favorite ? "Favourited" : "Unfavourited"} ${rows.length} bookmark${rows.length === 1 ? "" : "s"}`,
        kind: "edit",
        next: rows,
        reindex: false,
      });
      toast.success(`${favorite ? "Favourited" : "Unfavourited"} ${rows.length}`, {
        action: { label: "Undo", onClick: () => undo() },
      });
    },
    [commit, rowsFor, undo],
  );

  const addTags = useCallback(
    (ids: string[], tags: string[]) => {
      const cleaned = tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
      if (!cleaned.length) return;
      const rows = rowsFor(ids).map((row) => ({
        ...row,
        tags: [...new Set([...row.tags, ...cleaned])].slice(0, 24),
        // Re-typing a derived tag makes it the user's: they have now vouched for it.
        derivedTags: row.derivedTags?.filter(
          (entry) => !cleaned.includes(entry.toLowerCase()),
        ),
      }));
      if (!rows.length) return;
      commit({ label: `Tagged ${rows.length} with ${cleaned.join(", ")}`, kind: "tag", next: rows });
      toast.success(`Tagged ${rows.length} bookmark${rows.length === 1 ? "" : "s"}`, {
        action: { label: "Undo", onClick: () => undo() },
      });
    },
    [commit, rowsFor, undo],
  );

  const removeTag = useCallback(
    (ids: string[], tag: string) => {
      const rows = rowsFor(ids)
        .filter((row) => row.tags.some((value) => value.toLowerCase() === tag.toLowerCase()))
        .map((row) => ({
          ...row,
          tags: row.tags.filter((value) => value.toLowerCase() !== tag.toLowerCase()),
          derivedTags: row.derivedTags?.filter(
            (value) => value.toLowerCase() !== tag.toLowerCase(),
          ),
        }));
      if (!rows.length) return;
      commit({ label: `Removed tag “${tag}”`, kind: "tag", next: rows });
    },
    [commit, rowsFor],
  );

  const moveToFolder = useCallback(
    (ids: string[], folderId: string | null) => {
      const target = folderId ? (folderPaths.get(folderId) ?? "folder") : "no folder";
      // Chrome has no "no folder": moving something out of every folder really moves it
      // into "Other Bookmarks", the same place Chrome itself would put it.
      const effectiveFolderId = isChromeBookmarksAvailable() ? (folderId ?? OTHER_BOOKMARKS_ID) : folderId;
      const rows = rowsFor(ids).map((row) => ({ ...row, folderId: effectiveFolderId }));
      if (!rows.length) return;
      for (const id of ids) void moveBookmarkNode(id, folderId);
      commit({ label: `Moved ${rows.length} to ${target}`, kind: "move", next: rows });
      toast.success(`Moved ${rows.length} bookmark${rows.length === 1 ? "" : "s"}`, {
        action: { label: "Undo", onClick: () => undo() },
      });
    },
    [commit, rowsFor, folderPaths, undo],
  );

  const recordVisit = useCallback(
    (id: string) => {
      const row = rowsFor([id])[0];
      if (!row) return;
      commit({
        label: "Opened",
        kind: "create",
        next: [{ ...row, visitCount: row.visitCount + 1, lastVisitedAt: Date.now() }],
        undoable: false,
        reindex: false,
        silent: true,
      });
    },
    [commit, rowsFor],
  );

  const setNote = useCallback(
    (id: string, note: string) => {
      const row = rowsFor([id])[0];
      if (!row) return;
      commit({
        label: "Edited a note",
        kind: "edit",
        next: [{ ...row, note: note.trim() || undefined, editedAt: Date.now() }],
      });
    },
    [commit, rowsFor],
  );

  /** Writes alt text, which is a hand-written field and never generated. */
  const setAltText = useCallback(
    (id: string, alt: string) => {
      const row = rowsFor([id])[0];
      if (!row) return;
      commit({
        label: "Edited alt text",
        kind: "edit",
        next: [{ ...row, alt: alt.trim() || undefined, editedAt: Date.now() }],
      });
    },
    [commit, rowsFor],
  );

  const addHighlight = useCallback(
    (id: string, text: string, note?: string) => {
      const row = rowsFor([id])[0];
      if (!row || !text.trim()) return;
      commit({
        label: "Added a highlight",
        kind: "edit",
        next: [
          {
            ...row,
            highlights: [
              ...(row.highlights ?? []),
              { id: newId("hl"), text: text.trim(), note, at: Date.now() },
            ],
          },
        ],
      });
    },
    [commit, rowsFor],
  );

  const removeHighlight = useCallback(
    (id: string, highlightId: string) => {
      const row = rowsFor([id])[0];
      if (!row?.highlights) return;
      commit({
        label: "Removed a highlight",
        kind: "edit",
        next: [{ ...row, highlights: row.highlights.filter((entry) => entry.id !== highlightId) }],
      });
    },
    [commit, rowsFor],
  );

  /* ------------------------------------------------------ folders, boards -- */

  const createFolder = useCallback(async (name: string, parentId: string | null) => {
    const trimmedName = name.trim() || "New folder";
    // Chrome has no root-level folder outside its three fixed ones, so a new top-level
    // folder here becomes a new folder inside "Other Bookmarks" — the same constraint
    // `addBookmark` and `moveToFolder` already work around.
    const chromeId = await createFolderNode(parentId, trimmedName);
    const folder: Folder = {
      id: chromeId ?? newId("fld"),
      name: trimmedName,
      parentId: chromeId ? (parentId ?? OTHER_BOOKMARKS_ID) : parentId,
      addedAt: Date.now(),
    };
    setFolders((current) => [...current, folder]);
    foldersRef.current = [...foldersRef.current, folder];
    void db.putFolders([folder]);
    return folder;
  }, []);

  const renameFolder = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void renameFolderNode(id, trimmed);
    setFolders((current) => {
      const next = current.map((folder) =>
        folder.id === id ? { ...folder, name: trimmed, lastModifiedAt: Date.now() } : folder,
      );
      foldersRef.current = next;
      const changed = next.find((folder) => folder.id === id);
      if (changed) void db.putFolders([changed]);
      return next;
    });
  }, []);

  /**
   * Deletes a folder and everything nested under it.
   *
   * Bookmarks are never destroyed here — they move up to the deleted folder's parent.
   * Removing only the named folder would strand its subfolders as unreachable orphans with
   * a `parentId` pointing at nothing, so the whole subtree goes.
   */
  const deleteFolder = useCallback(
    async (id: string) => {
      const doomed = folderSubtree(foldersRef.current, id);
      const parentId = foldersRef.current.find((folder) => folder.id === id)?.parentId ?? null;

      const affected = bookmarksRef.current.filter(
        (bookmark) => bookmark.folderId && doomed.has(bookmark.folderId),
      );
      if (affected.length) {
        // Chrome's own copy of each bookmark has to move out *before* the folder tree
        // below is torn down, or `removeTree` destroys them along with the folder rather
        // than leaving them reparented the way this app's own model does.
        await Promise.all(affected.map((row) => moveBookmarkNode(row.id, parentId)));
        commit({
          label: `Moved ${affected.length} out of a deleted folder`,
          kind: "move",
          next: affected.map((row) => ({ ...row, folderId: parentId })),
        });
      }
      await removeFolderNode(id);

      const remaining = foldersRef.current.filter((folder) => !doomed.has(folder.id));
      setFolders(remaining);
      foldersRef.current = remaining;
      void db.deleteFolders([...doomed]);
      logActivity("delete", `Deleted a folder and ${doomed.size - 1} subfolders`, doomed.size);
      toast.success("Folder deleted", {
        description: affected.length
          ? `${affected.length} bookmark${affected.length === 1 ? "" : "s"} moved up a level.`
          : undefined,
      });
    },
    [commit, logActivity],
  );

  const createBoard = useCallback((name: string, color: string) => {
    const board: Board = {
      id: newId("brd"),
      name: name.trim() || "New board",
      color,
      createdAt: Date.now(),
    };
    setBoards((current) => [...current, board]);
    void db.putBoards([board]);
    return board;
  }, []);

  const renameBoard = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBoards((current) => {
      const next = current.map((board) => (board.id === id ? { ...board, name: trimmed } : board));
      const changed = next.find((board) => board.id === id);
      if (changed) void db.putBoards([changed]);
      return next;
    });
  }, []);

  const setBoardMembership = useCallback(
    (ids: string[], boardId: string, member: boolean) => {
      const rows = rowsFor(ids)
        .filter((row) => row.boardIds.includes(boardId) !== member)
        .map((row) => ({
          ...row,
          boardIds: member
            ? [...new Set([...row.boardIds, boardId])]
            : row.boardIds.filter((value) => value !== boardId),
        }));
      if (!rows.length) return;
      commit({
        label: member ? `Added ${rows.length} to a board` : `Removed ${rows.length} from a board`,
        kind: "move",
        next: rows,
        reindex: false,
      });
    },
    [commit, rowsFor],
  );

  const removeBoard = useCallback(
    (boardId: string) => {
      setBoards((current) => current.filter((board) => board.id !== boardId));
      void db.deleteBoard(boardId);
      const members = bookmarksRef.current.filter((bookmark) => bookmark.boardIds.includes(boardId));
      if (members.length) {
        commit({
          label: "Deleted a board",
          kind: "delete",
          next: members.map((row) => ({
            ...row,
            boardIds: row.boardIds.filter((id) => id !== boardId),
          })),
          reindex: false,
        });
      }
    },
    [commit],
  );

  /* --------------------------------------------------- smart collections -- */

  const createSmart = useCallback((collection: SmartCollection) => {
    setSmart((current) => [...current, collection]);
    void db.putSmartCollections([collection]);
  }, []);

  const updateSmart = useCallback((id: string, patch: Partial<SmartCollection>) => {
    setSmart((current) => {
      const next = current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
      const changed = next.find((entry) => entry.id === id);
      if (changed) void db.putSmartCollections([changed]);
      return next;
    });
  }, []);

  const deleteSmart = useCallback((id: string) => {
    setSmart((current) => current.filter((entry) => entry.id !== id));
    void db.deleteSmartCollection(id);
    toast.success("Collection removed", { description: "The bookmarks it matched are untouched." });
  }, []);

  /* -------------------------------------------------------------- sources -- */

  const renameSource = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSources((current) => {
      const next = current.map((row) => (row.id === id ? { ...row, name: trimmed } : row));
      const changed = next.find((row) => row.id === id);
      if (changed) void db.putSources([changed]);
      return next;
    });
  }, []);

  /**
   * Forgets a source without touching what it brought in.
   *
   * Deliberately not a delete: the rows are the user's library, and losing four hundred
   * bookmarks because they tidied a sidebar entry would be indefensible.
   */
  const forgetSource = useCallback(
    (id: string) => {
      const orphans = bookmarksRef.current.filter((row) => row.sourceId === id);
      if (orphans.length) {
        commit({
          label: "Detached a source",
          kind: "edit",
          next: orphans.map((row) => ({ ...row, sourceId: undefined })),
          undoable: false,
          reindex: false,
          silent: true,
        });
      }
      setSources((current) => current.filter((row) => row.id !== id));
      void db.deleteSource(id);
      toast.success("Source removed", {
        description: `${orphans.length} item${orphans.length === 1 ? "" : "s"} kept.`,
      });
    },
    [commit],
  );

  /* -------------------------------------------------------------- uploads -- */

  /**
   * Takes files from the user's own disk into the library.
   *
   * The bytes are stored and pinned before the row is created, in that order and never the
   * other way round: a row whose asset failed to write is a card that will never have a
   * picture and cannot be repaired, because there is no URL to re-fetch from.
   */
  const uploadFiles = useCallback(
    async (files: File[]): Promise<number> => {
      const usable = files.filter(
        (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
      );
      if (!usable.length) {
        toast.error("Nothing to add", { description: "Only images and video can be added as files." });
        return 0;
      }

      // One file larger than this is refused by name, rather than filling the browser's storage.
      const MAX_UPLOAD_BYTES = 750 * 1024 * 1024;
      const tooLarge = usable.filter((file) => file.size > MAX_UPLOAD_BYTES);
      if (tooLarge.length) {
        toast.error(`${tooLarge.length === 1 ? `“${tooLarge[0].name}” is` : `${tooLarge.length} files are`} too large to keep here`, {
          description: "Files over 750 MB are skipped. Save a link to where the file lives instead.",
        });
      }
      const accepted = usable.filter((file) => file.size <= MAX_UPLOAD_BYTES);
      if (!accepted.length) return 0;
      const needed = accepted.reduce((sum, file) => sum + file.size, 0);
      const estimate = await db.estimateUsage();
      if (estimate && estimate.quota - estimate.usage < needed * 1.1) {
        toast.error("Not enough browser storage for these files", {
          description: "Free some space in Settings → Storage, or add fewer files at once.",
        });
        return 0;
      }
      usable.length = 0;
      usable.push(...accepted);

      const at = Date.now();
      const existing = matchSource(sources, "upload", "Media");
      const source = existing ?? createSource("upload", "Media");
      const created: Bookmark[] = [];

      cancelJob.current = false;
      setJob({ running: true, done: 0, total: usable.length, label: "Adding files", failed: 0 });

      let failed = 0;
      for (const [position, file] of usable.entries()) {
        if (cancelJob.current) break;
        const id = newId("bmk");
        const key = assetKey("image", `media:${id}`);
        const stored = await putAssetBlob(key, file);
        if (!stored) {
          failed += 1;
          setJob((current) => ({ ...current, done: position + 1, failed }));
          continue;
        }
        pinAsset(key);

        const isVideo = file.type.startsWith("video/");
        created.push({
          id,
          kind: isVideo ? "video" : "image",
          // No page behind it, and the empty string says so — every consumer asks
          // `hasPage` before trying to open, check or screenshot a row.
          url: "",
          title: file.name.replace(/\.[^.]+$/, "") || "Untitled",
          domain: "",
          description: "",
          category: isVideo ? "Video" : "Assets & Icons",
          tags: [],
          folderId: null,
          boardIds: [],
          addedAt: file.lastModified || at,
          importedAt: at,
          visitCount: 0,
          health: { status: "unchecked" },
          preview: { method: "card" },
          sourceId: source.id,
          media: { assetKey: key, mime: file.type, bytes: file.size, fileName: file.name },
        });
        setJob((current) => ({ ...current, done: position + 1, failed }));
      }

      setJob(IDLE_JOB);
      if (!created.length) {
        toast.error("Nothing could be added", { description: "Storage refused the files." });
        return 0;
      }

      if (!existing) {
        setSources((current) => [...current, source]);
        void db.putSources([source]);
      }
      commit({
        label: `Added ${created.length} file${created.length === 1 ? "" : "s"}`,
        kind: "upload",
        next: created,
      });
      toast.success(`Added ${created.length} file${created.length === 1 ? "" : "s"}`, {
        description: failed ? `${failed} could not be stored` : undefined,
        action: { label: "Undo", onClick: () => undo() },
      });
      return created.length;
    },
    [commit, sources, undo],
  );

  /* ----------------------------------------------------------------- jobs -- */

  const requireServer = useCallback(async (what: string) => {
    const status = await api.getServerStatus();
    setServerStatus(status);
    if (!status.online) {
      toast.error(`${what} needs the extension or the local server`, {
        description:
          "A web page cannot read other sites on its own. Add the Bookmark Studio extension, or run the local server (npm start). Settings → Connections explains both.",
        duration: 8000,
      });
      return false;
    }
    return true;
  }, []);

  const stopJob = useCallback(() => {
    cancelJob.current = true;
  }, []);

  /**
   * Checks one batch of links and folds the answers in.
   *
   * Shared by the visible job and the background pipeline, which matters more than it
   * sounds: two implementations of "what a health result means" would drift, and the one
   * nobody watches would be the one that drifted. Bookmarks are grouped by URL first, so a
   * library with the same link filed in four places costs one request rather than four.
   */
  const checkBatch = useCallback(
    async (targets: Bookmark[]): Promise<{ updated: number; dead: number }> => {
      const byUrl = new Map<string, Bookmark[]>();
      for (const bookmark of targets) {
        if (!hasPage(bookmark)) continue;
        const list = byUrl.get(bookmark.url) ?? [];
        list.push(bookmark);
        byUrl.set(bookmark.url, list);
      }
      if (!byUrl.size) return { updated: 0, dead: 0 };

      const { results } = await api.checkHealth([...byUrl.keys()]);
      const updates: Bookmark[] = [];
      let dead = 0;
      for (const result of results) {
        for (const bookmark of byUrl.get(result.url) ?? []) {
          if (result.status === "dead") dead += 1;
          updates.push({
            ...bookmark,
            health: {
              ...bookmark.health,
              status: result.status,
              httpCode: result.httpCode,
              finalUrl: result.finalUrl,
              redirectCount: result.redirectCount,
              checkedAt: Date.now(),
              error: result.error,
            },
          });
        }
      }

      commit({
        label: "Link check",
        kind: "health",
        next: updates,
        undoable: false,
        reindex: false,
        silent: true,
      });
      return { updated: updates.length, dead };
    },
    [commit],
  );

  const runHealthCheck = useCallback(
    async (targets: Bookmark[]) => {
      const usable = targets.filter(hasPage);
      if (!usable.length) {
        toast("Nothing here has a link to check");
        return;
      }
      if (!(await requireServer("Link checking"))) return;

      cancelJob.current = false;
      setJob({ running: true, done: 0, total: usable.length, label: "Checking links", failed: 0 });

      let done = 0;
      let dead = 0;
      for (const batch of chunk(usable, JOB_HEALTH_BATCH)) {
        if (cancelJob.current) break;
        try {
          const result = await checkBatch(batch);
          dead += result.dead;
        } catch {
          setJob((current) => ({ ...current, failed: current.failed + batch.length }));
        }
        done += batch.length;
        setJob((current) => ({ ...current, done: Math.min(done, usable.length) }));
      }

      setJob(IDLE_JOB);
      logActivity("health", `Checked ${done} links`, done);
      toast.success("Link check finished", {
        description: dead ? `${dead} link${dead === 1 ? "" : "s"} did not respond` : "Everything responded",
      });
    },
    [checkBatch, logActivity, requireServer],
  );

  /**
   * Captures one batch of screenshots and returns the URLs that landed.
   *
   * The `forgetAsset` call is the non-obvious part: the screenshot endpoint's URL does not
   * change when a page is re-rendered, so nothing about the `src` would tell a card the
   * bytes behind it are now different — and a card that asked a moment ago and got "not
   * captured yet" is holding a remembered miss that would keep it grey.
   */
  const captureBatch = useCallback(
    async (batch: Bookmark[], device: DeviceName): Promise<string[]> => {
      const pages = batch.filter(hasPage);
      if (!pages.length) return [];
      const { results } = await api.captureScreenshots(
        pages.map((bookmark) => bookmark.url),
        device,
      );
      const outcomeByUrl = new Map(results.map((result) => [result.url, result]));
      const updates = pages
        .map((bookmark): Bookmark | null => {
          const outcome = outcomeByUrl.get(bookmark.url);
          if (!outcome?.ok) return null;
          return {
            ...bookmark,
            preview: {
              ...bookmark.preview,
              method: "screenshot",
              shotAt: outcome.capturedAt ?? Date.now(),
              // Recorded, not assumed: the grid reads this back to decide whether the
              // picture it is about to ask for actually exists.
              shotDevice: device,
            },
          };
        })
        .filter((row): row is Bookmark => row !== null);

      for (const row of updates) {
        const key = assetKey("shot", row.url, device);
        forgetPrefetch(key);
        void forgetAsset(key);
      }

      commit({
        label: "Preview capture",
        kind: "capture",
        next: updates,
        undoable: false,
        reindex: false,
        silent: true,
      });
      // The URLs, not a count: the pipeline needs to know *which* pages to stop asking
      // about, and a count silently attributes success to whichever rows come first.
      return updates.map((row) => row.url);
    },
    [commit],
  );

  const runCapture = useCallback(
    async (targets: Bookmark[], deviceOverride?: DeviceName) => {
      const usable = targets.filter(hasPage);
      if (!usable.length) {
        toast("Nothing here has a page to capture");
        return;
      }
      // Capture at the viewport the library is *showing*: the grid resolves its previews
      // through `previewDevice`, so a hardcoded default renders pictures no card requests.
      const device = deviceOverride ?? settingsRef.current.previewDevice;
      const status = await api.getServerStatus();
      setServerStatus(status);
      if (!status.online) {
        toast.error("Capturing previews needs the local server");
        return;
      }
      if (!status.screenshots) {
        toast.error("No Chrome or Edge installation found", {
          description: "Screenshots need a local Chrome/Edge. Set CHROME_PATH to point at one.",
        });
        return;
      }

      cancelJob.current = false;
      setJob({ running: true, done: 0, total: usable.length, label: "Capturing previews", failed: 0 });

      let done = 0;
      let failed = 0;
      for (const batch of chunk(usable, JOB_CAPTURE_BATCH)) {
        if (cancelJob.current) break;
        try {
          const captured = await captureBatch(batch, device);
          failed += batch.length - captured.length;
        } catch {
          failed += batch.length;
        }
        done += batch.length;
        setJob((current) => ({ ...current, done: Math.min(done, usable.length), failed }));
      }

      setJob(IDLE_JOB);
      logActivity("capture", `Captured ${done - failed} previews`, done - failed);
      toast.success("Preview capture finished", {
        description: failed ? `${failed} could not be captured` : `${done} pages captured`,
      });
    },
    [captureBatch, logActivity],
  );

  /**
   * Reads one page and folds what it says into the bookmark.
   *
   * This is the whole "intelligence" of the app in one function, and none of it is a
   * model: the description is the page's own, the tags are its keywords and headings, and
   * the body text is stored so search can find a bookmark by words that appear nowhere in
   * its title.
   */
  const enrichOne = useCallback(async (bookmark: Bookmark): Promise<Bookmark> => {
    const metadata = await api.fetchMetadata(bookmark.url);
    if (metadata.error) throw new Error(metadata.error);

    // Anything the user wrote by hand outranks anything the page says about itself.
    // Without this, re-reading a page silently discards a corrected title.
    const handWritten = Boolean(bookmark.editedAt);

    const scraped =
      metadata.description?.trim() || (metadata.text ? extractSummary(metadata.text) : "") || "";
    const description =
      handWritten && bookmark.description ? bookmark.description : scraped || bookmark.description;
    const summary = metadata.text ? extractSummary(metadata.text, 320) : bookmark.summary;

    // Only recognisable topics, never loose words from the page: a heading like "Everything
    // you need" must not become the tags `everything` and `need`.
    const pageTopics = new Map<string, number>();
    for (const keyword of metadata.keywords) topicsIn(keyword, pageTopics, 2);
    topicsIn(metadata.title ?? "", pageTopics, 2);
    for (const heading of (metadata.headings ?? []).slice(0, 3)) topicsIn(heading, pageTopics, 1);
    const scrapedTags = [
      ...[...pageTopics.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag),
      ...(metadata.tech ?? []).map((entry) => entry.toLowerCase()),
    ].slice(0, 4);

    // Scraped tags are additive; a tag the user removed is not re-added, because their
    // edit is the more recent statement of intent.
    const nextTags = handWritten
      ? bookmark.tags
      : [...new Set([...bookmark.tags, ...scrapedTags])].slice(0, 12);

    /*
     * Which of those tags the *page* is responsible for.
     *
     * Recorded at the moment of writing, the only moment the distinction is knowable. A
     * tag the user had already typed stays theirs even if the page agrees: their
     * authorship is the older claim, and marking it would tell them their own judgement
     * was guessed.
     */
    const alreadyUsers = new Set(
      bookmark.tags
        .filter((tag) => !bookmark.derivedTags?.includes(tag))
        .map((tag) => tag.toLowerCase()),
    );
    const derived = [
      ...new Set([
        ...(bookmark.derivedTags ?? []),
        ...scrapedTags.filter((tag) => !alreadyUsers.has(tag.toLowerCase())),
      ]),
    ].filter((tag) => nextTags.includes(tag));

    return {
      ...bookmark,
      description,
      summary,
      title: bookmark.title || metadata.title || bookmark.domain,
      tags: nextTags,
      derivedTags: derived.length ? derived : undefined,
      enriched: true,
      meta: {
        siteName: metadata.siteName,
        author: metadata.author,
        publishedAt: metadata.publishedAt,
        type: metadata.type,
        lang: metadata.lang,
        readingMinutes: metadata.readingMinutes,
        headings: metadata.headings?.slice(0, 8),
        keywords: metadata.keywords,
        tech: metadata.tech,
        feedUrl: metadata.feedUrl,
        text: metadata.text?.slice(0, 1500),
        fetchedAt: Date.now(),
      },
      preview: {
        ...bookmark.preview,
        // A real screenshot outranks an og:image, so never downgrade.
        method:
          bookmark.preview.method === "screenshot"
            ? "screenshot"
            : metadata.image
              ? "snapshot"
              : bookmark.preview.method,
        imageUrl: metadata.image ?? bookmark.preview.imageUrl,
        capturedAt: Date.now(),
      },
    };
  }, []);

  /**
   * Reads a batch of pages.
   *
   * Returns two numbers because two callers need different things: a progress bar wants
   * `succeeded`, the background queue wants `recorded` — how many rows it can stop asking
   * about, which includes failures, because a page that cannot be reached is stamped as
   * attempted precisely so it is not tried forever.
   */
  const enrichBatch = useCallback(
    async (batch: Bookmark[], silent: boolean): Promise<{ succeeded: number; recorded: number }> => {
      const pages = batch.filter(hasPage);
      if (!pages.length) return { succeeded: 0, recorded: batch.length };

      const settled = await Promise.allSettled(pages.map(enrichOne));
      const updates = settled
        .filter((entry): entry is PromiseFulfilledResult<Bookmark> => entry.status === "fulfilled")
        .map((entry) => entry.value);

      commit({
        label: "Page details",
        kind: "enrich",
        next: updates,
        undoable: false,
        silent: true,
      });

      const failures = settled
        .map((entry, position) =>
          entry.status === "rejected"
            ? { row: pages[position], reason: String(entry.reason?.message ?? entry.reason) }
            : null,
        )
        .filter((entry): entry is { row: Bookmark; reason: string } => entry !== null);

      if (failures.length && silent) {
        commit({
          label: "Unreadable pages",
          kind: "enrich",
          next: failures.map(({ row, reason }) => ({
            ...row,
            enriched: true,
            meta: { ...row.meta, fetchedAt: Date.now(), error: reason.slice(0, 120) },
          })),
          undoable: false,
          reindex: false,
          silent: true,
        });
      }
      return {
        succeeded: updates.length,
        recorded: silent ? updates.length + failures.length : updates.length,
      };
    },
    [commit, enrichOne],
  );

  const runEnrichment = useCallback(
    async (targets: Bookmark[]) => {
      const usable = targets.filter(hasPage);
      if (!usable.length) {
        toast("Nothing here has a page to read");
        return;
      }
      if (!(await requireServer("Reading pages"))) return;

      cancelJob.current = false;
      setJob({ running: true, done: 0, total: usable.length, label: "Reading pages", failed: 0 });

      let done = 0;
      let failed = 0;
      for (const batch of chunk(usable, JOB_ENRICH_BATCH)) {
        if (cancelJob.current) break;
        const { succeeded } = await enrichBatch(batch, true);
        failed += batch.length - succeeded;
        done += batch.length;
        setJob((current) => ({ ...current, done: Math.min(done, usable.length), failed }));
      }

      setJob(IDLE_JOB);
      logActivity("enrich", `Read ${done - failed} pages`, done - failed);
      toast.success("Finished reading pages", {
        description: failed ? `${failed} could not be read` : undefined,
      });
    },
    [enrichBatch, logActivity, requireServer],
  );

  /* --------------------------------------------------------- visual index -- */

  /**
   * Builds the perceptual hash and colour histogram for one row's picture.
   *
   * Reads the bytes the asset store already holds rather than the network: by the time a
   * card has been on screen its image is materialised, so indexing is a canvas draw and a
   * few hundred arithmetic operations with no request at all.
   */
  const indexVisual = useCallback(async (row: Bookmark): Promise<Bookmark | null> => {
    const key =
      row.media?.posterKey ??
      row.media?.assetKey ??
      (row.preview.shotAt
        ? assetKey("shot", row.url, settingsRef.current.previewDevice)
        : row.preview.imageUrl
          ? assetKey("image", row.preview.imageUrl)
          : null);
    if (!key) return null;

    const source = await ensureAsset(
      key,
      row.media?.assetKey
        ? ""
        : row.preview.shotAt
          ? api.screenshotUrl(row.url, settingsRef.current.previewDevice, "cached")
          : api.proxiedImage(row.preview.imageUrl ?? ""),
    );
    if (!source) return null;

    const visual = await indexImage(source);
    if (!visual) return null;
    return { ...row, visual };
  }, []);

  const runVisualIndex = useCallback(
    async (targets?: Bookmark[]) => {
      const pending = (targets ?? bookmarksRef.current).filter(
        (row) =>
          !row.trashedAt &&
          !row.visual?.at &&
          (row.media?.assetKey || row.preview.shotAt || row.preview.imageUrl),
      );
      if (!pending.length) {
        toast("Every picture is already indexed");
        return;
      }

      cancelJob.current = false;
      setJob({ running: true, done: 0, total: pending.length, label: "Indexing pictures", failed: 0 });

      let done = 0;
      let failed = 0;
      for (const group of chunk(pending, 8)) {
        if (cancelJob.current) break;
        const settled = await Promise.all(group.map(indexVisual));
        const updates = settled.filter((row): row is Bookmark => row !== null);
        failed += group.length - updates.length;
        commit({
          label: "Picture index",
          kind: "enrich",
          next: updates,
          undoable: false,
          reindex: false,
          silent: true,
        });
        done += group.length;
        setJob((current) => ({ ...current, done: Math.min(done, pending.length), failed }));
      }

      setJob(IDLE_JOB);
      toast.success("Finished indexing pictures", {
        description: failed ? `${failed} could not be read` : `${done - failed} indexed`,
      });
    },
    [commit, indexVisual],
  );

  /**
   * Collapses groups of the same picture saved more than once.
   *
   * The visual counterpart to `dedupeLibrary`, and it catches what that cannot: a
   * screenshot pasted from three places has three different URLs, or none, so comparing
   * addresses finds nothing.
   */
  const mergeLookalikes = useCallback((): number => {
    const groups = groupLookalikes(bookmarksRef.current, settingsRef.current.lookalikeThreshold);
    if (!groups.length) {
      toast("No look-alike pictures found");
      return 0;
    }

    const keep: Bookmark[] = [];
    const remove: string[] = [];
    for (const group of groups) {
      keep.push({
        ...group.keep,
        tags: [...new Set([...group.keep.tags, ...group.rest.flatMap((row) => row.tags)])].slice(0, 24),
        boardIds: [...new Set([...group.keep.boardIds, ...group.rest.flatMap((row) => row.boardIds)])],
        note: group.keep.note ?? group.rest.find((row) => row.note)?.note,
        favorite: [group.keep, ...group.rest].some((row) => row.favorite) || undefined,
      });
      for (const row of group.rest) remove.push(row.id);
    }

    commit({
      label: `Merged ${groups.length} group${groups.length === 1 ? "" : "s"} of look-alikes`,
      kind: "delete",
      next: keep,
      remove,
    });
    toast.success(`Removed ${remove.length} duplicate picture${remove.length === 1 ? "" : "s"}`, {
      description: `${groups.length} group${groups.length === 1 ? "" : "s"} collapsed — the original was kept.`,
      action: { label: "Undo", onClick: () => undo() },
    });
    return remove.length;
  }, [commit, undo]);

  /* --------------------------------------------------------- offline copy -- */

  /**
   * Saves a page as a self-contained file that opens with the network off.
   *
   * Stored and pinned, because unlike a screenshot there is no way to regenerate it once
   * the site is gone — which is the case the whole feature exists for.
   */
  const saveOfflineCopy = useCallback(
    async (bookmark: Bookmark): Promise<boolean> => {
      if (!hasPage(bookmark)) {
        toast.error("There is no page to save", { description: "Offline copies are for links." });
        return false;
      }
      if (!(await requireServer("Saving an offline copy"))) return false;

      const id = toast.loading(`Saving ${bookmark.domain}…`);
      try {
        const response = await api.requestSnapshot(bookmark.url);
        if (!response.ok) {
          toast.error(`Could not save ${bookmark.domain}`, { id });
          return false;
        }
        const type = response.headers.get("content-type") ?? "";
        if (type.includes("application/json")) {
          const detail = (await response.json()) as { error?: string };
          commit({
            label: "Offline copy failed",
            kind: "offline",
            next: [
              {
                ...bookmark,
                offline: {
                  assetKey: "",
                  capturedAt: Date.now(),
                  bytes: 0,
                  error: detail.error ?? "Could not be archived",
                },
              },
            ],
            undoable: false,
            reindex: false,
            silent: true,
          });
          toast.error(`Could not save ${bookmark.domain}`, { id, description: detail.error });
          return false;
        }

        const blob = await response.blob();
        const key = assetKey("image", `offline:${bookmark.id}`);
        if (!(await putAssetBlob(key, blob))) {
          toast.error("Storage refused the copy", { id });
          return false;
        }
        pinAsset(key);

        commit({
          label: "Saved an offline copy",
          kind: "offline",
          next: [
            {
              ...bookmark,
              offline: {
                assetKey: key,
                capturedAt: Date.now(),
                bytes: blob.size,
                inlined: Number(response.headers.get("x-snapshot-inlined") ?? 0),
              },
            },
          ],
          undoable: false,
          reindex: false,
          silent: true,
        });
        toast.success(`Saved ${bookmark.domain} for offline`, {
          id,
          description: `${Math.round(blob.size / 1024)} KB · opens without a connection`,
        });
        return true;
      } catch {
        toast.error(`Could not save ${bookmark.domain}`, { id });
        return false;
      }
    },
    [commit, requireServer],
  );

  /** Opens a stored offline copy in a new tab, from bytes rather than the network. */
  const openOfflineCopy = useCallback(async (bookmark: Bookmark): Promise<boolean> => {
    if (!bookmark.offline?.assetKey) return false;
    const blob = await getAssetBlob(bookmark.offline.assetKey);
    if (!blob) {
      toast.error("The saved copy is missing", { description: "Save it again from the detail panel." });
      return false;
    }
    // A blob URL puts the archive on its own opaque origin rather than on this one, so
    // third-party markup can never reach this app's storage. Revoked on a delay so the new
    // tab has time to claim it.
    const url = URL.createObjectURL(new Blob([blob], { type: "text/html" }));
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  }, []);

  /** Re-captures one page's screenshot on demand, bypassing the disk cache. */
  const refreshShot = useCallback(
    async (bookmark: Bookmark, deviceOverride?: DeviceName) => {
      const device = deviceOverride ?? settingsRef.current.previewDevice;
      const status = await api.getServerStatus();
      setServerStatus(status);
      if (!status.online) {
        toast.error("Capturing previews needs the local server");
        return false;
      }
      if (!status.screenshots) {
        toast.error("No Chrome or Edge installation found", {
          description: "Screenshots need a local Chrome/Edge. Set CHROME_PATH to point at one.",
        });
        return false;
      }

      const id = toast.loading(`Capturing ${bookmark.domain}…`);
      const ok = await api.renderScreenshot(bookmark.url, device);
      if (ok) {
        // Drop the stored bytes *before* the commit, so the re-render finds an empty key
        // and fetches the new picture rather than showing the old one.
        const key = assetKey("shot", bookmark.url, device);
        forgetPrefetch(key);
        await forgetAsset(key);
        commit({
          label: "Refreshed a preview",
          kind: "capture",
          next: [
            {
              ...bookmark,
              preview: { ...bookmark.preview, method: "screenshot", shotAt: Date.now(), shotDevice: device },
            },
          ],
          undoable: false,
          reindex: false,
          silent: true,
        });
        toast.success(`Fresh screenshot of ${bookmark.domain}`, { id });
      } else {
        toast.error(`Could not capture ${bookmark.domain}`, {
          id,
          description: "The page may block automated browsers or be slow to load.",
        });
      }
      return ok;
    },
    [commit],
  );

  const attachArchive = useCallback(
    async (bookmark: Bookmark) => {
      try {
        const { archiveUrl } = await api.fetchArchiveUrl(bookmark.url);
        if (!archiveUrl) {
          toast.error("No archived copy found");
          return;
        }
        commit({
          label: "Attached an archive snapshot",
          kind: "edit",
          next: [{ ...bookmark, health: { ...bookmark.health, archiveUrl } }],
          reindex: false,
        });
        toast.success("Attached a Wayback Machine snapshot");
      } catch {
        toast.error("Could not reach the archive");
      }
    },
    [commit],
  );

  /* ------------------------------------------------------------- pipeline -- */

  /**
   * Hand the background pipeline the five things it can do.
   *
   * The pipeline owns *when* and *in what order*; this owns *how*, and every one of these
   * is the same function the equivalent toolbar button calls. The alternative is a second,
   * quieter implementation of "capture a page" whose behaviour nobody ever verifies.
   */
  useEffect(() => {
    configurePipeline({
      capture: async (urls, device) => {
        const byUrl = new Map(bookmarksRef.current.map((row) => [row.url, row]));
        const rows = urls.map((url) => byUrl.get(url)).filter((row): row is Bookmark => Boolean(row));
        if (!rows.length) return [];
        return captureBatch(rows, device);
      },
      enrich: async (rows) => (await enrichBatch(rows, true)).recorded,
      check: async (rows) => (await checkBatch(rows)).updated,
      /**
       * Indexing reports *recorded*, not succeeded.
       *
       * A picture that will not decode is stamped with an empty index so it leaves the
       * queue — the alternative is retrying a corrupt file until it is abandoned, twice per
       * row, for every unreadable image in the library.
       */
      indexVisual: async (rows) => {
        const settled = await Promise.all(rows.map(indexVisual));
        const updates = settled.map(
          (result, position) => result ?? { ...rows[position], visual: { at: Date.now() } },
        );
        commit({
          label: "Picture index",
          kind: "enrich",
          next: updates,
          undoable: false,
          reindex: false,
          silent: true,
        });
        return updates.length;
      },
      offline: async (rows) => {
        let recorded = 0;
        for (const row of rows) {
          // Sequential on purpose: each call is a document plus up to a hundred and twenty
          // subresources, and two at once is a burst no site should receive from a
          // background pass nobody asked for.
          const ok = await saveOfflineCopy(row);
          recorded += 1;
          if (!ok) {
            commit({
              label: "Offline copy attempted",
              kind: "offline",
              next: [
                {
                  ...row,
                  offline: {
                    assetKey: row.offline?.assetKey ?? "",
                    capturedAt: Date.now(),
                    bytes: 0,
                    error: row.offline?.error ?? "Could not be archived",
                  },
                },
              ],
              undoable: false,
              reindex: false,
              silent: true,
            });
          }
        }
        return recorded;
      },
    });
  }, [captureBatch, checkBatch, enrichBatch, indexVisual, saveOfflineCopy, commit]);

  /**
   * Tell the pipeline what exists.
   *
   * This is the line that makes "as soon as a page appears in the app" literally true: any
   * change to the library reaches the pipeline in the same render that puts it on screen.
   */
  useEffect(() => {
    if (loading) return;
    observeLibrary(bookmarks);
  }, [bookmarks, loading]);

  useEffect(() => {
    setPipelineSettings({
      shots: settings.autoCapture && settings.showScreenshots,
      meta: settings.autoEnrich,
      health: settings.autoCheckLinks,
      visual: settings.autoIndexVisuals,
      offline: settings.autoOfflineCopy,
      device: settings.previewDevice,
    });
  }, [
    settings.autoCapture,
    settings.showScreenshots,
    settings.autoEnrich,
    settings.autoCheckLinks,
    settings.autoIndexVisuals,
    settings.autoOfflineCopy,
    settings.previewDevice,
  ]);

  useEffect(() => {
    setPipelineOnline(serverStatus.online);
  }, [serverStatus.online]);

  /**
   * Stand down while the user is watching something.
   *
   * A foreground capture and a background sweep drive the same single renderer. Letting
   * them interleave makes the job the user is waiting on take twice as long, for no
   * benefit they can see.
   */
  useEffect(() => {
    yieldPipeline(job.running);
  }, [job.running]);

  useEffect(() => {
    const onVisibility = () => setPipelineHidden(document.visibilityState === "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => subscribePipeline(setPipeline), []);

  useEffect(() => {
    setAssetBudget(settings.assetBudgetMb);
  }, [settings.assetBudgetMb]);

  /* ------------------------------------------------------------ housekeeping */

  const clearActivityLog = useCallback(async () => {
    await db.clearActivity();
    setActivity([]);
    toast.success("Activity log cleared");
  }, []);

  const resetLibrary = useCallback(async () => {
    await db.clearLibrary();
    await db.clearActivity();
    // The images are derived from the bookmarks, so keeping them would leave a storage
    // figure with nothing to explain it.
    await clearAssets();
    setBookmarks([]);
    bookmarksRef.current = [];
    setFolders([]);
    foldersRef.current = [];
    setBoards([]);
    setImports([]);
    setSources([]);
    setSmart([]);
    setActivity([]);
    undoRef.current = [];
    redoRef.current = [];
    syncStacks();
    textIndexRef.current = new TfIdfIndex([]);
    setIndexVersion((version) => version + 1);
    announceReplace();
    toast.success("Library cleared");
  }, [syncStacks]);

  return {
    /* data */
    bookmarks,
    folders,
    boards,
    imports: importList,
    sources: sourceList,
    smart,
    activity,
    settings,
    loading,
    hydrating,
    job,
    pipeline,
    serverStatus,
    folderPaths,
    /* derived */
    index,
    facets,
    textIndex,
    vocabulary,
    canUndo: stackSizes.undo > 0,
    canRedo: stackSizes.redo > 0,
    /* actions */
    undo,
    redo,
    updateSettings,
    deleteImport,
    renameImport,
    previewImport,
    importFile,
    setBrowserSync,
    exportLibrary,
    addBookmark,
    updateBookmark,
    removeBookmarks,
    trashBookmarks,
    restoreFromTrash,
    emptyTrash,
    dedupeLibrary,
    setArchived,
    toggleFavorite,
    setFavorites,
    addTags,
    removeTag,
    moveToFolder,
    recordVisit,
    setNote,
    setAltText,
    addHighlight,
    removeHighlight,
    createFolder,
    renameFolder,
    deleteFolder,
    createBoard,
    renameBoard,
    removeBoard,
    setBoardMembership,
    createSmart,
    updateSmart,
    deleteSmart,
    renameSource,
    forgetSource,
    uploadFiles,
    runHealthCheck,
    runCapture,
    runEnrichment,
    runVisualIndex,
    mergeLookalikes,
    saveOfflineCopy,
    openOfflineCopy,
    refreshShot,
    attachArchive,
    stopJob,
    clearActivityLog,
    resetLibrary,
  };
}

export type Library = ReturnType<typeof useLibrary>;
