/**
 * Two-way sync with the browser's own Bookmarks Bar.
 *
 * The extension build has no import dialog: the library *is* whatever is in Chrome's
 * bookmarks, kept live in both directions. This module is the entire seam —
 * `hooks/useLibrary.ts` calls into it from the handful of places that already mutate
 * bookmarks and folders (`addBookmark`, `moveToFolder`, `createFolder`, …), and it calls
 * back into the hook for changes that originate on the Chrome side.
 *
 * ## Chrome's tree has no "no folder"
 *
 * Every bookmark and folder lives under one of three fixed roots — "Bookmarks Bar" (id
 * `"1"`), "Other Bookmarks" (id `"2"`) and, on a synced profile, "Mobile Bookmarks" (id
 * `"3"`) — themselves children of an invisible root (id `"0"`) that is never shown as a
 * folder. The app's own model allows `folderId: null` for "not filed anywhere"; when
 * mirrored to Chrome that has to land *somewhere*, so it becomes "Other Bookmarks",
 * exactly where an address-bar star with no folder chosen would put it in Chrome itself.
 *
 * ## Why writes are fire-and-forget
 *
 * A `chrome.bookmarks` call can fail — the target folder was deleted a moment ago in
 * another surface, sync is disabled, whatever — and none of those failures should ever
 * block or roll back the change the user just made *in this app*. The local write always
 * wins; the Chrome mirror is best-effort and, if it drifts, self-heals on the next
 * `reconcile()`.
 *
 * ## Echo suppression
 *
 * Every write this module makes to `chrome.bookmarks` fires the exact same events a
 * person editing their bookmarks bar by hand would produce. Without a guard, this app's
 * own `chrome.bookmarks.create` call would round-trip through `onCreated` and be applied
 * a second time. `pending` remembers which ids this module caused, for a few seconds —
 * long enough for the corresponding event to arrive and be recognised, never so long that
 * a genuine later edit to the same id is mistaken for an echo.
 */
import type { Bookmark, Folder } from "../../shared/types";
import { classify, suggestTags } from "./classify";
import { isVideoUrl, thumbnailUrl } from "./embeds";
import { bookmarksApi, type BookmarksApi } from "./bookmarks-api";
import { IS_EXTENSION } from "./env";
import { buildFolderPaths } from "./library";
import { log } from "./log";
import { getDomain } from "./text";

/**
 * The root folder ids. Chrome's are "0", "1" and "2" on every profile; Firefox names them
 * ("root________", "toolbar_____", "unfiled_____"). Learned from the tree on every
 * reconcile (`learnRootIds`), with Chrome's as the starting values, so the same code files
 * a new bookmark in the right place in either browser.
 */
export let BOOKMARKS_BAR_ID = "1";
export let OTHER_BOOKMARKS_ID = "2";
let INVISIBLE_ROOT_ID = "0";

const BAR_IDS = new Set(["1", "toolbar_____"]);
const OTHER_IDS = new Set(["2", "unfiled_____"]);

export function learnRootIds(root: chrome.bookmarks.BookmarkTreeNode): void {
  if (!root?.id) return;
  INVISIBLE_ROOT_ID = root.id;
  for (const child of root.children ?? []) {
    if (BAR_IDS.has(child.id)) BOOKMARKS_BAR_ID = child.id;
    if (OTHER_IDS.has(child.id)) OTHER_BOOKMARKS_ID = child.id;
  }
}

export const CHROME_SOURCE_ID = "chrome";

/**
 * Whether two-way sync with the browser's bookmarks is on.
 *
 * Always inside the extension — there the library *is* the browser's bookmarks. On the
 * website it follows the person's choice, and is on by default once the extension is
 * connected (`wantsBrowserSync` in `shared/types.ts`).
 */
let browserSyncAllowed = IS_EXTENSION;

export function allowBrowserSync(allowed: boolean): void {
  browserSyncAllowed = IS_EXTENSION || allowed;
}

/** Whether the browser's bookmarks can be reached at all from this page. */
export function canReachBrowserBookmarks(): boolean {
  return bookmarksApi() !== null;
}

export function isChromeBookmarksAvailable(): boolean {
  return browserSyncAllowed && bookmarksApi() !== null;
}

function api(): BookmarksApi {
  const value = bookmarksApi();
  if (!value) throw new Error("The browser's bookmarks are not reachable from this page");
  return value;
}

/** Where a bookmark or folder with no chosen folder actually lives in Chrome. */
function toChromeParentId(folderId: string | null): string {
  return folderId ?? OTHER_BOOKMARKS_ID;
}

/* ------------------------------------------------------------- echo guard */

const PENDING_TTL_MS = 8_000;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function markPending(id: string): void {
  const existing = pending.get(id);
  if (existing) clearTimeout(existing);
  pending.set(
    id,
    setTimeout(() => pending.delete(id), PENDING_TTL_MS),
  );
}

/** Consumes a pending mark if present. Returns whether the event was our own echo. */
function consumePending(id: string): boolean {
  const timer = pending.get(id);
  if (!timer) return false;
  clearTimeout(timer);
  pending.delete(id);
  return true;
}

/* -------------------------------------------------------- node -> app row */

function isFolderNode(node: chrome.bookmarks.BookmarkTreeNode): boolean {
  return node.url === undefined;
}

/** Builds a fresh app-native bookmark from a Chrome node this library has never seen. */
function freshBookmark(
  node: chrome.bookmarks.BookmarkTreeNode,
  folderId: string | null,
  folderPath: string,
): Bookmark {
  const url = node.url ?? "";
  const title = node.title?.trim() || getDomain(url) || url;
  const derivedTags = suggestTags({ url, title, folderPath });
  return {
    id: node.id,
    url,
    title,
    domain: getDomain(url),
    description: "",
    category: classify({ url, title, folderPath }),
    tags: derivedTags,
    derivedTags: derivedTags.length ? derivedTags : undefined,
    folderId,
    boardIds: [],
    addedAt: node.dateAdded ?? Date.now(),
    importedAt: Date.now(),
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card", imageUrl: thumbnailUrl(url) ?? undefined },
    kind: isVideoUrl(url) ? "video" : undefined,
    sourceId: CHROME_SOURCE_ID,
    sourceOrder: node.index,
  };
}

/** Folds a Chrome node's structural fields into a row this library already has. */
function mergedBookmark(previous: Bookmark, node: chrome.bookmarks.BookmarkTreeNode, folderId: string | null): Bookmark {
  const url = node.url ?? previous.url;
  const next: Bookmark = {
    ...previous,
    folderId,
    sourceOrder: node.index,
  };
  // A title or URL edited by hand in this app must not be clobbered by a stale event —
  // matches the app's own rule that a background read never overwrites a hand-written
  // title. Chrome has no such concept, so the most recent write of either kind wins here.
  if (!previous.editedAt) {
    next.title = node.title?.trim() || previous.title;
    if (url !== previous.url) {
      next.url = url;
      next.domain = getDomain(url);
    }
  }
  return next;
}

function freshFolder(node: chrome.bookmarks.BookmarkTreeNode, parentId: string | null): Folder {
  const isBar = node.id === BOOKMARKS_BAR_ID;
  return {
    id: node.id,
    name: node.title || (isBar ? "Bookmarks Bar" : "Bookmarks"),
    parentId,
    addedAt: node.dateAdded ?? Date.now(),
    toolbar: isBar || undefined,
    sourceOrder: node.index,
  };
}

function mergedFolder(previous: Folder, node: chrome.bookmarks.BookmarkTreeNode, parentId: string | null): Folder {
  return {
    ...previous,
    name: node.title || previous.name,
    parentId,
    sourceOrder: node.index,
    lastModifiedAt: Date.now(),
  };
}

/* ---------------------------------------------------------- full reconcile */

export interface ReconcileResult {
  folders: Folder[];
  bookmarks: Bookmark[];
  /** Bookmarks this library had from Chrome that are no longer in the tree. */
  removedBookmarkIds: string[];
}

/**
 * Reads the whole Chrome bookmarks tree and reconciles it against what this library
 * already has.
 *
 * Run once on open (to catch up on anything that changed while this tab, or the
 * extension's service worker, was not running) — the live listeners in `startSync` take
 * over from there. Rows already known by id keep every app-only field (tags, notes,
 * health, screenshots); only structural fields — title, url, folder, position — move.
 */
export async function reconcile(
  existingBookmarks: Bookmark[],
  existingFolders: Folder[],
): Promise<ReconcileResult> {
  const [root] = await api().getTree();
  if (!root) throw new Error("The browser returned no bookmarks tree");
  learnRootIds(root);
  const existingFolderById = new Map(existingFolders.map((folder) => [folder.id, folder]));
  const existingBookmarkById = new Map(existingBookmarks.map((bookmark) => [bookmark.id, bookmark]));

  const folders: Folder[] = [];
  const seenFolderIds = new Set<string>();

  const walkFolders = (node: chrome.bookmarks.BookmarkTreeNode, parentId: string | null) => {
    if (node.id !== INVISIBLE_ROOT_ID) {
      const previous = existingFolderById.get(node.id);
      folders.push(previous ? mergedFolder(previous, node, parentId) : freshFolder(node, parentId));
      seenFolderIds.add(node.id);
    }
    const nextParent = node.id === INVISIBLE_ROOT_ID ? null : node.id;
    for (const child of node.children ?? []) {
      if (isFolderNode(child)) walkFolders(child, nextParent);
    }
  };
  walkFolders(root, null);

  const folderPaths = buildFolderPaths(folders);
  const bookmarks: Bookmark[] = [];
  const seenBookmarkIds = new Set<string>();

  const walkBookmarks = (node: chrome.bookmarks.BookmarkTreeNode, folderId: string | null) => {
    for (const child of node.children ?? []) {
      if (isFolderNode(child)) {
        walkBookmarks(child, child.id);
      } else {
        const previous = existingBookmarkById.get(child.id);
        const path = folderId ? (folderPaths.get(folderId) ?? "") : "";
        bookmarks.push(previous ? mergedBookmark(previous, child, folderId) : freshBookmark(child, folderId, path));
        seenBookmarkIds.add(child.id);
      }
    }
  };
  walkBookmarks(root, null);

  const removedBookmarkIds = existingBookmarks
    .filter((bookmark) => bookmark.sourceId === CHROME_SOURCE_ID && !seenBookmarkIds.has(bookmark.id))
    .map((bookmark) => bookmark.id);

  return { folders, bookmarks, removedBookmarkIds };
}

/* ------------------------------------------------------------- write-back */

export type MirrorOperation = "create" | "update" | "move" | "remove" | "create-folder" | "rename-folder" | "remove-folder";

const mirrorListeners = new Set<(operation: MirrorOperation) => void>();

/**
 * Hears about changes that could not be copied to Chrome's bookmarks.
 *
 * They matter more than they look: a delete that never reached Chrome is undone by the next
 * sync, which reads to the person as the app bringing a bookmark back on its own.
 */
export function onMirrorFailure(listener: (operation: MirrorOperation) => void): () => void {
  mirrorListeners.add(listener);
  return () => {
    mirrorListeners.delete(listener);
  };
}

/** "Can't find bookmark for id": the node is already gone, which is what a removal wanted. */
const isMissingNode = (error: unknown) => /can.?t find|not found|no node/i.test(String((error as Error)?.message ?? error));

function mirrorFailed(operation: MirrorOperation, error: unknown): void {
  if ((operation === "remove" || operation === "remove-folder") && isMissingNode(error)) return;
  log.warn("chrome-sync.write-back-failed", { operation, error });
  for (const listener of mirrorListeners) {
    try {
      listener(operation);
    } catch {
      // A listener's bug must not break sync.
    }
  }
}

/**
 * Creates a bookmark in Chrome and returns its real id, or `null` if Chrome bookmarks are
 * unavailable or the call failed — callers fall back to a locally-generated id, so a
 * bookmark can still be added while sync is unavailable.
 */
export async function createBookmarkNode(
  folderId: string | null,
  title: string,
  url: string,
): Promise<string | null> {
  if (!isChromeBookmarksAvailable()) return null;
  try {
    const node = await api().create({ parentId: toChromeParentId(folderId), title, url });
    markPending(node.id);
    return node.id;
  } catch (error) {
    mirrorFailed("create", error);
    return null;
  }
}

/**
 * Every write-back function below is `async` and never rejects — a caller that only
 * needs "fire and forget" can call it without `await` or a `.catch`, and a caller that
 * needs one write to land before the next starts (see `deleteFolder` in
 * `hooks/useLibrary.ts`) can `await` the exact same function.
 */
export async function updateBookmarkNode(id: string, changes: { title?: string; url?: string }): Promise<void> {
  if (!isChromeBookmarksAvailable()) return;
  markPending(id);
  await api().update(id, changes).catch((error: unknown) => mirrorFailed("update", error));
}

export async function moveBookmarkNode(id: string, folderId: string | null): Promise<void> {
  if (!isChromeBookmarksAvailable()) return;
  markPending(id);
  await api()
    .move(id, { parentId: toChromeParentId(folderId) })
    .catch((error: unknown) => mirrorFailed("move", error));
}

export async function removeBookmarkNode(id: string): Promise<void> {
  if (!isChromeBookmarksAvailable()) return;
  markPending(id);
  await api().remove(id).catch((error: unknown) => mirrorFailed("remove", error));
}

export async function createFolderNode(parentId: string | null, title: string): Promise<string | null> {
  if (!isChromeBookmarksAvailable()) return null;
  try {
    const node = await api().create({ parentId: toChromeParentId(parentId), title });
    markPending(node.id);
    return node.id;
  } catch (error) {
    mirrorFailed("create-folder", error);
    return null;
  }
}

export async function renameFolderNode(id: string, title: string): Promise<void> {
  if (!isChromeBookmarksAvailable()) return;
  markPending(id);
  await api().update(id, { title }).catch((error: unknown) => mirrorFailed("rename-folder", error));
}

/**
 * Removes a folder and everything still under it.
 *
 * Callers that reparent contained bookmarks before deleting the folder (the app's own
 * "deleting a folder moves its bookmarks up a level" rule) must `await` those moves
 * first — by the time this runs, the folder should contain only the subfolders that are
 * genuinely meant to go with it.
 */
export async function removeFolderNode(id: string): Promise<void> {
  if (!isChromeBookmarksAvailable()) return;
  markPending(id);
  await api().removeTree(id).catch((error: unknown) => mirrorFailed("remove-folder", error));
}

/* ---------------------------------------------------------------- live sync */

export interface ChromeSyncHandlers {
  /** A bookmark was created or structurally changed on the Chrome side. */
  onBookmarkUpserted: (bookmark: Bookmark) => void;
  onBookmarkRemoved: (ids: string[]) => void;
  onFolderUpserted: (folder: Folder) => void;
  onFolderRemoved: (ids: string[]) => void;
  /** A bulk change (Chrome's own bookmark import, or a large paste) landed all at once. */
  onBulkChange: () => void;
  /** Current snapshots, read fresh each time a handler needs to look something up. */
  getBookmarks: () => Bookmark[];
  getFolders: () => Folder[];
}

function collectSubtreeIds(node: chrome.bookmarks.BookmarkTreeNode): { bookmarkIds: string[]; folderIds: string[] } {
  const bookmarkIds: string[] = [];
  const folderIds: string[] = [];
  const walk = (current: chrome.bookmarks.BookmarkTreeNode) => {
    if (isFolderNode(current)) {
      folderIds.push(current.id);
      for (const child of current.children ?? []) walk(child);
    } else {
      bookmarkIds.push(current.id);
    }
  };
  walk(node);
  return { bookmarkIds, folderIds };
}

/**
 * Attaches the live listeners and returns a function that removes them.
 *
 * A bulk Chrome-side import suppresses individual events between `onImportBegan` and
 * `onImportEnded` and triggers one `onBulkChange` instead — reconciling row by row for a
 * multi-thousand-bookmark import would mean that many separate commits.
 */
export function startSync(handlers: ChromeSyncHandlers): () => void {
  if (!isChromeBookmarksAvailable()) return () => undefined;

  const bookmarks = api();
  let importing = false;

  const onCreated = (id: string, node: chrome.bookmarks.BookmarkTreeNode) => {
    if (importing || consumePending(id)) return;
    if (isFolderNode(node)) {
      handlers.onFolderUpserted(freshFolder(node, node.parentId ?? null));
    } else {
      const folderId = node.parentId ?? null;
      const folders = handlers.getFolders();
      const path = folderId ? (buildFolderPaths(folders).get(folderId) ?? "") : "";
      handlers.onBookmarkUpserted(freshBookmark(node, folderId, path));
    }
  };

  const onRemoved = (
    id: string,
    removeInfo: chrome.bookmarks.BookmarkRemoveInfo,
  ) => {
    if (importing || consumePending(id)) return;
    const node = removeInfo.node;
    if (node && isFolderNode(node)) {
      const { bookmarkIds, folderIds } = collectSubtreeIds(node);
      if (bookmarkIds.length) handlers.onBookmarkRemoved(bookmarkIds);
      handlers.onFolderRemoved(folderIds);
    } else {
      handlers.onBookmarkRemoved([id]);
    }
  };

  const onChanged = (id: string, changeInfo: chrome.bookmarks.BookmarkChangeInfo) => {
    if (importing || consumePending(id)) return;
    const bookmark = handlers.getBookmarks().find((row) => row.id === id);
    if (bookmark) {
      if (bookmark.editedAt) return; // hand-edited locally; Chrome's title/url loses.
      const url = changeInfo.url ?? bookmark.url;
      handlers.onBookmarkUpserted({
        ...bookmark,
        title: changeInfo.title?.trim() || bookmark.title,
        url,
        domain: url !== bookmark.url ? getDomain(url) : bookmark.domain,
      });
      return;
    }
    const folder = handlers.getFolders().find((row) => row.id === id);
    if (folder && changeInfo.title) {
      handlers.onFolderUpserted({ ...folder, name: changeInfo.title, lastModifiedAt: Date.now() });
    }
  };

  const onMoved = (id: string, moveInfo: chrome.bookmarks.BookmarkMoveInfo) => {
    if (importing || consumePending(id)) return;
    const bookmark = handlers.getBookmarks().find((row) => row.id === id);
    if (bookmark) {
      handlers.onBookmarkUpserted({ ...bookmark, folderId: moveInfo.parentId, sourceOrder: moveInfo.index });
      return;
    }
    const folder = handlers.getFolders().find((row) => row.id === id);
    if (folder) {
      handlers.onFolderUpserted({ ...folder, parentId: moveInfo.parentId, sourceOrder: moveInfo.index });
    }
  };

  const onReordered = (id: string, reorderInfo: chrome.bookmarks.BookmarkReorderInfo) => {
    if (importing) return;
    const bookmarksById = new Map(handlers.getBookmarks().map((row) => [row.id, row]));
    const foldersById = new Map(handlers.getFolders().map((row) => [row.id, row]));
    reorderInfo.childIds.forEach((childId, index) => {
      const bookmark = bookmarksById.get(childId);
      if (bookmark) {
        if (bookmark.sourceOrder !== index) handlers.onBookmarkUpserted({ ...bookmark, sourceOrder: index });
        return;
      }
      const folder = foldersById.get(childId);
      if (folder && folder.sourceOrder !== index) handlers.onFolderUpserted({ ...folder, sourceOrder: index });
    });
    void id;
  };

  const onImportBegan = () => {
    importing = true;
  };
  const onImportEnded = () => {
    importing = false;
    handlers.onBulkChange();
  };

  bookmarks.onCreated.addListener(onCreated);
  bookmarks.onRemoved.addListener(onRemoved);
  bookmarks.onChanged.addListener(onChanged);
  bookmarks.onMoved.addListener(onMoved);
  // Firefox has neither reorder nor import events; their absence must not stop sync.
  bookmarks.onChildrenReordered?.addListener(onReordered);
  bookmarks.onImportBegan?.addListener(onImportBegan);
  bookmarks.onImportEnded?.addListener(onImportEnded);

  return () => {
    bookmarks.onCreated.removeListener(onCreated);
    bookmarks.onRemoved.removeListener(onRemoved);
    bookmarks.onChanged.removeListener(onChanged);
    bookmarks.onMoved.removeListener(onMoved);
    bookmarks.onChildrenReordered?.removeListener(onReordered);
    bookmarks.onImportBegan?.removeListener(onImportBegan);
    bookmarks.onImportEnded?.removeListener(onImportEnded);
  };
}
