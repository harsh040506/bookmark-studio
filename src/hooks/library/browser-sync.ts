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
import { IS_EXTENSION } from "../../lib/env";
import { persistAndAnnounce, touched } from "./shared";
import type { LibraryCore } from "./core";

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
      const survivors = current.filter((row) => !removing.has(row.id)).map((row) => nextById.get(row.id) ?? row);
      const created = next.filter((row) => !current.some((existing) => existing.id === row.id));
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
  /** Whether listeners are attached, so a late-arriving extension starts sync exactly once. */
  const browserSyncRunning = useRef(false);

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
      browserSyncRunning.current = true;
      return true;
    } catch (error) {
      // Unreadable for some reason (permission not yet granted after an update, the
      // extension reloaded underneath the website) — the library keeps what it has.
      browserSyncRunning.current = false;
      log.warn("browser-sync.start-failed", { error });
      return false;
    }
  }, [reconcileAndReindex, applyChromeBookmarkChanges, applyChromeFolderChanges]);

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
