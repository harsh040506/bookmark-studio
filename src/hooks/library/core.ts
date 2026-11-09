/**
 * The library's state and the one way it changes.
 *
 * Holds every row, folder and setting in memory, the undo history, the search index, and
 * `commit`, through which every change is saved, announced to other tabs and recorded for
 * undo. The feature hooks beside it (browser sync, import and export, editing, background
 * work) each take this core and add their own actions; `useLibrary` puts them together.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_SETTINGS,
  type ActivityEntry,
  type Board,
  type Bookmark,
  type Folder,
  type ImportBatch,
  type Settings,
  type SmartCollection,
  type Source,
} from "../../../shared/types";
import { useRuntime } from "../useRuntime";
import * as api from "../../lib/api";
import { log } from "../../lib/log";
import * as db from "../../lib/db";
import { buildLibraryIndex, countFacets, type LibraryIndex } from "../../lib/engine";
import { Vocabulary } from "../../lib/fuzzy";
import { buildIndexAsync } from "../../lib/indexer";
import {
  buildFolderPaths,
  toIndexDoc,
} from "../../lib/library";
import {
  pipelineState,
  
  
  type PipelineState,
} from "../../lib/pipeline";
import {
  sourcesWithCounts,
  type SourceWithCount,
} from "../../lib/sources";
import { subscribeSync } from "../../lib/sync";
import { rebaseRow } from "../../lib/rebase";
import { TfIdfIndex } from "../../lib/tfidf";
import { newId } from "../../lib/utils";
import { IDLE_JOB, JobState, Mutation, Patch, UNDO_LIMIT, applyPatch, diffRow, persistAndAnnounce, touched } from "./shared";

export function useLibraryCore() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [imports, setImports] = useState<ImportBatch[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [smart, setSmart] = useState<SmartCollection[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const runtime = useRuntime();
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
          void db.loadSnapshot().catch((error: unknown) => {
            log.warn("sync.replace-failed", { error });
            return null;
          }).then((snapshot) => {
            if (!snapshot) return;
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

        if (notice.shell) {
          // Folders, boards and the like are small; read them whole.
          void db
            .loadShell()
            .then((shell) => {
              setFolders(shell.folders);
              foldersRef.current = shell.folders;
              setBoards(shell.boards);
              setImports(shell.imports);
              setSources(shell.sources);
              setSmart(shell.smart);
            })
            .catch((error: unknown) => log.warn("sync.shell-failed", { error }));
        }
        if (!notice.changed.length && !notice.removed.length) return;

        void db
          .getBookmarks(notice.changed)
          .then((changedRows) => {
            const fresh = new Map(changedRows.map((row) => [row.id, row]));
            const removed = new Set(notice.removed);
            const current = bookmarksRef.current;
            const merged: Bookmark[] = [];
            for (const row of current) {
              if (removed.has(row.id)) continue;
              merged.push(fresh.get(row.id) ?? row);
            }
            // A row that exists in the database and in no tab's memory is the one case where
            // "trust the database" means adding rather than replacing. New rows go first, as
            // a local add would put them.
            const known = new Set(current.map((row) => row.id));
            const added = changedRows.filter((row) => !known.has(row.id) && !removed.has(row.id));
            const next = added.length ? [...added, ...merged] : merged;
            setBookmarks(next);
            bookmarksRef.current = next;
            reindexRows(changedRows, notice.removed);
          })
          .catch((error: unknown) => log.warn("sync.apply-failed", { error }));
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
      // The activity log is a convenience; failing to record one entry must never be
      // reported as if the library itself were at risk.
      void db.appendActivity(entry).catch((error: unknown) => log.warn("activity.write-failed", { error }));
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
      const { label, kind, remove = [], undoable = true, reindex = true, silent } = options;
      // Undoable commits are the person's own actions; background results are not.
      const next = undoable ? touched(options.next) : options.next;
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
      persistAndAnnounce(next, remove);

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

  /**
   * Writes the results of slow background work without overwriting what happened since.
   *
   * Every pair is the copy the work started from and what it produced; see `rebaseRow`.
   * Rows deleted in the meantime are dropped rather than recreated. Returns the rows
   * actually written.
   */
  const commitDerived = useCallback(
    (options: {
      label: string;
      kind: ActivityEntry["kind"];
      pairs: { before: Bookmark; after: Bookmark }[];
      reindex?: boolean;
    }): Bookmark[] => {
      const byId = new Map(bookmarksRef.current.map((row) => [row.id, row]));
      const next: Bookmark[] = [];
      for (const { before, after } of options.pairs) {
        const merged = rebaseRow(before, after, byId.get(after.id));
        if (!merged) continue;
        byId.set(merged.id, merged);
        next.push(merged);
      }
      commit({
        label: options.label,
        kind: options.kind,
        next,
        undoable: false,
        reindex: options.reindex ?? false,
        silent: true,
      });
      return next;
    },
    [commit],
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
      // Undo is a new decision, so it must outrank the change it reverses on the other copy.
      restored.splice(0, restored.length, ...touched(restored));

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
      persistAndAnnounce(restored, mutation.createdIds);

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

  return {
    bookmarks,
    setBookmarks,
    folders,
    setFolders,
    boards,
    setBoards,
    imports,
    setImports,
    sources,
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
    setJob,
    serverStatus,
    setServerStatus,
    pipeline,
    setPipeline,
    undoRef,
    redoRef,
    stackSizes,
    setStackSizes,
    syncStacks,
    cancelJob,
    textIndexRef,
    indexVersion,
    setIndexVersion,
    bookmarksRef,
    foldersRef,
    smartRef,
    folderPathsRef,
    settingsRef,
    rebuildToken,
    rebuildTextIndex,
    reindexRows,
    folderPaths,
    index,
    facets,
    textIndex,
    vocabulary,
    sourceList,
    importList,
    logActivity,
    commit,
    commitDerived,
    applyMutation,
    undo,
    redo,
    updateSettings,
    rowsFor,
  };
}

export type LibraryCore = ReturnType<typeof useLibraryCore>;
