/**
 * Two-way sync with the browser's own bookmarks, through the extension.
 */
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  
  type Bookmark,
  type Folder,
  type Source,
  wantsBrowserSync,
} from "../../../shared/types";
import {
  CHROME_SOURCE_ID,
  allowBrowserSync,
  canReachBrowserBookmarks,
  isChromeBookmarksAvailable,
  reconcile as reconcileChromeBookmarks,
  startSync as startChromeSync,
} from "../../lib/chrome-bookmarks";
import { log } from "../../lib/log";
import * as db from "../../lib/db";
import {
  buildFolderPaths,
  
} from "../../lib/library";
import { BROWSER_NAME, IS_EXTENSION } from "../../lib/env";
import { PendingChanges } from "../../lib/pending-changes";
import { persistAndAnnounce, touched } from "./shared";
import type { LibraryCore } from "./core";

/** Long enough to gather a burst, short enough that one starred page appears at once. */
const EVENT_BATCH_MS = 80;

export function useBrowserSync(core: LibraryCore) {
  const {
    setBookmarks,
    setFolders,
    setSources,
    setSettings,
    runtime,
    loading,
    bookmarksRef,
    foldersRef,
    settingsRef,
    rebuildTextIndex,
    reindexRows,
  } = core;

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
    (changes: Bookmark[], remove: string[] = []) => {
      // A change made in Chrome's own bookmark manager is still the person's decision.
      const next = touched(changes);
      if (!next.length && !remove.length) return;
      const current = bookmarksRef.current;
      const nextById = new Map(next.map((row) => [row.id, row]));
      const removing = new Set(remove);
      // A set, not a search of the list per row: reconciling ten thousand bookmarks against
      // ten thousand was a hundred million comparisons on the main thread.
      const known = new Set(current.map((row) => row.id));
      const survivors = current.filter((row) => !removing.has(row.id)).map((row) => nextById.get(row.id) ?? row);
      const created = next.filter((row) => !known.has(row.id) && !removing.has(row.id));
      const updated = created.length ? [...created, ...survivors] : survivors;

      setBookmarks(updated);
      bookmarksRef.current = updated;
      reindexRows(next, remove);
      persistAndAnnounce(next, remove);
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
    const known = new Set(current.map((row) => row.id));
    const survivors = current.filter((row) => !removing.has(row.id)).map((row) => nextById.get(row.id) ?? row);
    const created = next.filter((row) => !known.has(row.id) && !removing.has(row.id));
    const updated = created.length ? [...survivors, ...created] : survivors;

    setFolders(updated);
    foldersRef.current = updated;
    // A failed write is tracked and retried by the storage layer, which also tells the person.
    if (next.length) void db.putFolders(next).catch(() => undefined);
    if (remove.length) void db.deleteFolders(remove).catch(() => undefined);
  }, []);

  /** Detaches the Chrome bookmarks listeners on unmount. A no-op until sync starts. */
  const chromeSyncCleanupRef = useRef<() => void>(() => undefined);
  /** Whether listeners are attached, so a late-arriving extension starts sync exactly once. */
  const browserSyncRunning = useRef(false);

  /* --------------------------------------------- events, applied in batches -- */

  /**
   * Changes from the browser that have arrived but are not in the library yet, applied
   * together a moment later instead of one at a time (see `lib/pending-changes.ts`).
   */
  const pendingRowsRef = useRef(new PendingChanges<Bookmark>());
  const pendingFoldersRef = useRef(new PendingChanges<Folder>());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Rows by id for the library as it is now, rebuilt only when the list is replaced. */
  const rowLookupRef = useRef<{ rows: Bookmark[]; byId: Map<string, Bookmark> } | null>(null);
  const folderLookupRef = useRef<{ rows: Folder[]; byId: Map<string, Folder> } | null>(null);

  const storedRow = useCallback((id: string): Bookmark | undefined => {
    const rows = bookmarksRef.current;
    if (rowLookupRef.current?.rows !== rows) {
      rowLookupRef.current = { rows, byId: new Map(rows.map((row) => [row.id, row])) };
    }
    return rowLookupRef.current.byId.get(id);
  }, []);

  const storedFolder = useCallback((id: string): Folder | undefined => {
    const rows = foldersRef.current;
    if (folderLookupRef.current?.rows !== rows) {
      folderLookupRef.current = { rows, byId: new Map(rows.map((row) => [row.id, row])) };
    }
    return folderLookupRef.current.byId.get(id);
  }, []);

  const flushChromeEvents = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (pendingRowsRef.current.empty && pendingFoldersRef.current.empty) return;
    try {
      // Folders first, so a bookmark never arrives ahead of the folder it is filed in.
      const folders = pendingFoldersRef.current.take(storedFolder);
      applyChromeFolderChanges(folders.upserts, folders.removals);
      const rows = pendingRowsRef.current.take(storedRow);
      applyChromeBookmarkChanges(rows.upserts, rows.removals);
    } catch (error) {
      // Nothing is lost for good: the next open compares the whole tree again.
      log.warn("browser-sync.apply-failed", { error });
    }
  }, [applyChromeBookmarkChanges, applyChromeFolderChanges, storedFolder, storedRow]);

  const scheduleFlush = useCallback(() => {
    // Counted from the first event, not the last: a steady stream must not postpone it forever.
    flushTimerRef.current ??= setTimeout(flushChromeEvents, EVENT_BATCH_MS);
  }, [flushChromeEvents]);

  /**
   * Reads the whole Chrome tree and folds it in, then (re)builds the text index over the
   * result. Used both on first open and after a bulk change on the Chrome side (its own
   * "import bookmarks" dialog, for instance) that would be wasteful to apply event by
   * event.
   *
   * Only what differs is written. An unchanged library costs one read of the tree and
   * nothing else: no storage writes, nothing sent to the other copy, no index rebuild.
   */
  const reconcileAndReindex = useCallback(async () => {
    // Anything still waiting belongs to the tree as it was; apply it before comparing.
    flushChromeEvents();
    const result = await reconcileChromeBookmarks(() => ({
      bookmarks: bookmarksRef.current,
      folders: foldersRef.current,
    }));
    applyChromeFolderChanges(result.changedFolders, result.removedFolderIds);
    applyChromeBookmarkChanges(result.changedBookmarks, result.removedBookmarkIds);

    if (
      result.changedFolders.length ||
      result.changedBookmarks.length ||
      result.removedBookmarkIds.length ||
      result.removedFolderIds.length
    ) {
      // A renamed or moved folder changes the searchable path of rows that did not change.
      void rebuildTextIndex(bookmarksRef.current, buildFolderPaths(foldersRef.current));
    }
    return result;
  }, [applyChromeBookmarkChanges, applyChromeFolderChanges, flushChromeEvents, rebuildTextIndex]);

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
          name: IS_EXTENSION ? BROWSER_NAME : "This browser",
          browser: BROWSER_NAME,
          createdAt: Date.now(),
          syncedAt: Date.now(),
          resyncable: false,
        };
        void db.putSources([chromeSource]);
        return [...current, chromeSource];
      });

      const queue = <A extends unknown[]>(change: (...args: A) => void) => (...args: A) => {
        change(...args);
        scheduleFlush();
      };
      const stopListening = startChromeSync({
        onBookmarkCreated: queue((bookmark: Bookmark) => pendingRowsRef.current.create(bookmark)),
        onBookmarkPatched: queue((id: string, patch: Partial<Bookmark>) => pendingRowsRef.current.patch(id, patch)),
        onBookmarkRemoved: queue((ids: string[]) => pendingRowsRef.current.remove(ids)),
        onFolderCreated: queue((folder: Folder) => pendingFoldersRef.current.create(folder)),
        onFolderPatched: queue((id: string, patch: Partial<Folder>) => pendingFoldersRef.current.patch(id, patch)),
        onFolderRemoved: queue((ids: string[]) => pendingFoldersRef.current.remove(ids)),
        onBulkChange: () =>
          void reconcileAndReindex().catch((error: unknown) => log.warn("browser-sync.bulk-change-failed", { error })),
        findBookmark: (id) => pendingRowsRef.current.find(id, storedRow),
        findFolder: (id) => pendingFoldersRef.current.find(id, storedFolder),
      });
      chromeSyncCleanupRef.current = () => {
        stopListening();
        // Whatever has arrived is still true; write it before going quiet.
        flushChromeEvents();
      };
      browserSyncRunning.current = true;
      return true;
    } catch (error) {
      // Unreadable for some reason (permission not yet granted after an update, the
      // extension reloaded underneath the website) — the library keeps what it has.
      browserSyncRunning.current = false;
      log.warn("browser-sync.start-failed", { error });
      return false;
    }
  }, [reconcileAndReindex, flushChromeEvents, scheduleFlush, storedFolder, storedRow]);

  /** Switches browser-bookmark sync on or off (the website's opt-in; always on in the extension). */
  const setBrowserSync = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      allowBrowserSync(enabled);
      const next = { ...settingsRef.current, browserSync: enabled, browserSyncChosen: true };
      setSettings(next);
      void db.saveSettings(next);
      if (!enabled) {
        chromeSyncCleanupRef.current();
        chromeSyncCleanupRef.current = () => undefined;
        browserSyncRunning.current = false;
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

  /*
    Start browser sync when the extension turns up after the library opened: it was
    installed or allowed while the tab was open, or its bridge answered after the first
    probe. Sync used to be attempted once, on mount, and a late extension meant new
    bookmarks only appeared after a reload.
  */
  useEffect(() => {
    if (loading || IS_EXTENSION) return;
    if (!runtime.browserBookmarks || browserSyncRunning.current) return;
    if (!wantsBrowserSync(settingsRef.current)) return;
    allowBrowserSync(true);
    void startBrowserSync().then((ok) => {
      if (!ok) log.warn("browser-sync.late-start-failed");
    });
  }, [loading, runtime.browserBookmarks, startBrowserSync]);

  return {
    applyChromeBookmarkChanges,
    applyChromeFolderChanges,
    chromeSyncCleanupRef,
    browserSyncRunning,
    reconcileAndReindex,
    startBrowserSync,
    setBrowserSync,
  };
}
