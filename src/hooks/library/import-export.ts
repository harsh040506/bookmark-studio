/**
 * Getting bookmarks in and out: imports, backups, exports and uploaded files.
 */
import { useCallback } from "react";
import { toast } from "sonner";
import {
  
  type Bookmark,
  type ImportBatch,
  type Source,
} from "../../../shared/types";
import {
  assetKey,
  
  
  pinAsset,
  putAssetBlob,
} from "../../lib/assets";
import * as db from "../../lib/db";
import {
  buildFolderPaths,
  
} from "../../lib/library";
import { serializeNetscapeBookmarks } from "../../lib/netscape";
import {
  createSource,
  matchSource,
} from "../../lib/sources";
import { downloadFile, newId } from "../../lib/utils";
import { mergeBackup, parseBackupFile } from "../../lib/backup";
import { runImport, type ImportOutcome } from "../../lib/import";
import { IDLE_JOB, ImportRunOptions, keptOnReplace, previewBackup } from "./shared";
import type { LibraryCore } from "./core";

export function useImportExport(core: LibraryCore) {
  const {
    folders,
    setFolders,
    boards,
    setBoards,
    imports,
    setImports,
    sources,
    setSources,
    setJob,
    cancelJob,
    bookmarksRef,
    foldersRef,
    rebuildTextIndex,
    folderPaths,
    logActivity,
    commit,
    undo,
  } = core;

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

  return { deleteImport, renameImport, previewImport, restoreBackup, importFile, exportLibrary, uploadFiles };
}
