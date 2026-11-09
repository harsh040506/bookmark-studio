/**
 * Everything a person does to bookmarks, folders, boards, smart collections and sources.
 */
import { useCallback } from "react";
import { toast } from "sonner";
import {
  type Board,
  type Bookmark,
  type Folder,
  type SmartCollection,
} from "../../../shared/types";
import {
  forgetAsset,
  
  
} from "../../lib/assets";
import {
  CHROME_SOURCE_ID,
  OTHER_BOOKMARKS_ID,
  createBookmarkNode,
  createFolderNode,
  isChromeBookmarksAvailable,
  moveBookmarkNode,
  removeBookmarkNode,
  removeFolderNode,
  renameFolderNode,
  updateBookmarkNode,
} from "../../lib/chrome-bookmarks";
import { classify, suggestTags } from "../../lib/classify";
import * as db from "../../lib/db";
import {
  folderSubtree,
  planDuplicateCleanup,
} from "../../lib/library";
import { canonicalUrl, getDomain } from "../../lib/text";
import { newId } from "../../lib/utils";
import { isVideoUrl, thumbnailUrl } from "../../lib/embeds";
import { normalizeUserUrl } from "../../lib/url-input";
import type { LibraryCore } from "./core";

export function useEditing(core: LibraryCore) {
  const {
    setFolders,
    setBoards,
    setSources,
    setSmart,
    bookmarksRef,
    foldersRef,
    folderPaths,
    logActivity,
    commit,
    undo,
    rowsFor,
  } = core;

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

  return {
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
    setBoardMembership,
    removeBoard,
    createSmart,
    updateSmart,
    deleteSmart,
    renameSource,
    forgetSource,
  };
}
