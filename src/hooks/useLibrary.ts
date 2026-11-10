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
 *
 * ## Where the code lives
 *
 * This file puts the pieces together and opens the library. `library/core.ts` holds the
 * state, `commit` and undo; `library/browser-sync.ts`, `library/import-export.ts`,
 * `library/editing.ts` and `library/background-work.ts` each take that core and add their
 * actions. `library/shared.ts` has the helpers they share.
 */
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  
  type Bookmark,
  
  
  
  wantsBrowserSync,
} from "../../shared/types";
import * as api from "../lib/api";
import {
  clearAssets,
  initAssets,
  pinAsset,
  setAssetBudget,
} from "../lib/assets";
import {
  allowBrowserSync,
  
  
  
} from "../lib/chrome-bookmarks";
import { isTopicTag, suggestTags } from "../lib/classify";
import * as db from "../lib/db";
import {
  buildFolderPaths,
  retagDerived,
} from "../lib/library";
import { startExtensionChangeNotices, startReplication } from "../lib/replication";
import { announceReplace } from "../lib/sync";
import { TfIdfIndex } from "../lib/tfidf";
import { IS_EXTENSION } from "../lib/env";
import { useBackgroundWork } from "./library/background-work";
import { useBrowserSync } from "./library/browser-sync";
import { useLibraryCore } from "./library/core";
import { useEditing } from "./library/editing";
import { useImportExport } from "./library/import-export";
import { FIRST_PAINT_ROWS, TOPIC_TAGS_MIGRATION } from "./library/shared";
export type { ImportRunOptions, JobState } from "./library/shared";
export function useLibrary() {
  const core = useLibraryCore();
  const {
    bookmarks,
    setBookmarks,
    folders,
    setFolders,
    boards,
    setBoards,
    setImports,
    setSources,
    smart,
    setSmart,
    activity,
    setActivity,
    settings,
    setSettings,
    runtime,
    loading,
    setLoading,
    hydrating,
    setHydrating,
    job,
    serverStatus,
    setServerStatus,
    pipeline,
    undoRef,
    redoRef,
    stackSizes,
    syncStacks,
    textIndexRef,
    setIndexVersion,
    bookmarksRef,
    foldersRef,
    rebuildTextIndex,
    folderPaths,
    index,
    facets,
    textIndex,
    vocabulary,
    sourceList,
    importList,
    undo,
    redo,
    updateSettings,
  } = core;
  const { chromeSyncCleanupRef, startBrowserSync, setBrowserSync } = useBrowserSync(core);
  const { deleteImport, renameImport, previewImport, importFile, exportLibrary, uploadFiles } = useImportExport(core);
  const {
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
    moveFolder,
    deleteFolder,
    createBoard,
    renameBoard,
    setBoardMembership,
    removeBoard,
    createSmart,
    updateSmart,
    deleteSmart,
    renameSource,
    forgetSource,
  } = useEditing(core);
  const {
    stopJob,
    runHealthCheck,
    runCapture,
    runEnrichment,
    runVisualIndex,
    mergeLookalikes,
    saveOfflineCopy,
    openOfflineCopy,
    refreshShot,
    attachArchive,
  } = useBackgroundWork(core);

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
      allowBrowserSync(wantsBrowserSync(stored));
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

  /*
    One library across the website and the extension (see lib/replication.ts). Starts
    after the whole library is in memory, so rows arriving from the extension merge into
    the complete list rather than a first page.
  */
  const shareLibrary = !loading && !hydrating && !IS_EXTENSION && runtime.extension && settings.shareWithExtension;
  useEffect(() => (shareLibrary ? startReplication() : undefined), [shareLibrary]);
  useEffect(() => (IS_EXTENSION ? startExtensionChangeNotices() : undefined), []);

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
    moveFolder,
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
