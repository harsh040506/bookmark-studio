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
import { MAX_FOLDER_DEPTH, buildFolderPaths } from "./library";
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

/**
 * Folds a Chrome node's structural fields into a row this library already has.
 *
 * Returns the row itself when nothing differs. That matters more than it looks: the whole
 * tree is compared on every open, and a new object for every row meant every bookmark was
 * written to storage again, sent to the other copy of the library again, and stamped as
 * "changed by the person just now", which let an untouched copy overrule a real edit made
 * on the other side.
 */
function mergedBookmark(previous: Bookmark, node: chrome.bookmarks.BookmarkTreeNode, folderId: string | null): Bookmark {
  // A title or URL edited by hand in this app must not be clobbered by a stale event —
  // matches the app's own rule that a background read never overwrites a hand-written
  // title. Chrome has no such concept, so the most recent write of either kind wins here.
  const title = previous.editedAt ? previous.title : node.title?.trim() || previous.title;
  const url = previous.editedAt ? previous.url : (node.url ?? previous.url);
  if (
    previous.folderId === folderId &&
    previous.sourceOrder === node.index &&
    previous.title === title &&
    previous.url === url
  ) {
    return previous;
  }
  const next: Bookmark = { ...previous, folderId, sourceOrder: node.index, title };
  if (url !== previous.url) {
    next.url = url;
    next.domain = getDomain(url);
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

/** The folder itself when nothing differs, for the same reason as `mergedBookmark`. */
function mergedFolder(previous: Folder, node: chrome.bookmarks.BookmarkTreeNode, parentId: string | null): Folder {
  const name = node.title || previous.name;
  if (previous.name === name && previous.parentId === parentId && previous.sourceOrder === node.index) {
    return previous;
  }
  return {
    ...previous,
    name,
    parentId,
    sourceOrder: node.index,
    lastModifiedAt: Date.now(),
  };
}

/* ---------------------------------------------------------- full reconcile */

export interface ReconcileResult {
  /** Every folder and bookmark in the browser's tree, as this library should hold them. */
  folders: Folder[];
  bookmarks: Bookmark[];
  /** Only the ones that are new or differ from what the library has: what needs writing. */
  changedFolders: Folder[];
  changedBookmarks: Bookmark[];
  /** Bookmarks this library had from Chrome that are no longer in the tree. */
  removedBookmarkIds: string[];
  /** Folders of the browser's that are gone from its tree and hold nothing here any more. */
  removedFolderIds: string[];
}

/** A folder this young may have been made here a moment ago, after the tree was read. */
const NEW_FOLDER_GRACE_MS = 60_000;

/**
 * The browser's folders that were deleted there while the app was closed.
 *
 * Deleted bookmarks were noticed on the next open; their folders were not, and stayed in
 * the sidebar for good as empty folders nobody had made. A folder is removed only when all
 * of this holds: it is one of the browser's (not made here or by an import), the browser's
 * tree no longer has it, and after this sync nothing is left in it or beneath it. A folder
 * that still holds something, such as imported bookmarks filed there, is kept as it is.
 */
export function vanishedBrowserFolders(
  folders: Folder[],
  inTree: ReadonlySet<string>,
  occupied: ReadonlySet<string>,
  now = Date.now(),
): string[] {
  const candidate = (folder: Folder) =>
    !folder.id.startsWith("fld_") &&
    !folder.importId &&
    !inTree.has(folder.id) &&
    !occupied.has(folder.id) &&
    now - (folder.addedAt || 0) > NEW_FOLDER_GRACE_MS;

  const childrenOf = new Map<string, Folder[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const list = childrenOf.get(folder.parentId) ?? [];
    list.push(folder);
    childrenOf.set(folder.parentId, list);
  }

  // Deepest first, so a folder is judged after everything under it has been.
  const removable = new Set<string>();
  const kept = new Set<string>();
  for (const start of folders) {
    const stack: { folder: Folder; expanded: boolean }[] = [{ folder: start, expanded: false }];
    const onStack = new Set<string>();
    while (stack.length) {
      const top = stack[stack.length - 1];
      const { folder } = top;
      if (removable.has(folder.id) || kept.has(folder.id)) {
        stack.pop();
        continue;
      }
      if (!top.expanded) {
        top.expanded = true;
        onStack.add(folder.id);
        for (const child of childrenOf.get(folder.id) ?? []) {
          // A loop of parents is never removed; `repairFolders` deals with those.
          if (onStack.has(child.id)) kept.add(folder.id);
          else if (!removable.has(child.id) && !kept.has(child.id)) stack.push({ folder: child, expanded: false });
        }
        continue;
      }
      stack.pop();
      onStack.delete(folder.id);
      if (kept.has(folder.id)) continue;
      const emptyBelow = (childrenOf.get(folder.id) ?? []).every((child) => removable.has(child.id));
      if (candidate(folder) && emptyBelow) removable.add(folder.id);
      else kept.add(folder.id);
    }
  }
  return [...removable];
}

type TreeNode = chrome.bookmarks.BookmarkTreeNode;

/** How long reconcile works before letting the page draw and respond. */
const SLICE_MS = 12;

/**
 * Lets the page handle input and paint, then carries on.
 *
 * A message, not a timer: browsers slow a hidden tab's timers to one a second, which would
 * turn a first sync in a background tab into minutes.
 */
function breathe(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === "undefined") {
      setTimeout(resolve, 0);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Walks a bookmarks tree without recursion.
 *
 * The browser's tree is as deep as the person made it, and other tools can write to it. A
 * function that calls itself per level would overflow on a deep enough chain, which here
 * means sync failing on every open.
 */
function walkTree(root: TreeNode, visit: (node: TreeNode, parent: TreeNode | null) => void): void {
  const stack: { node: TreeNode; parent: TreeNode | null }[] = [{ node: root, parent: null }];
  while (stack.length) {
    const { node, parent } = stack.pop() as { node: TreeNode; parent: TreeNode | null };
    if (!node || typeof node !== "object" || typeof node.id !== "string") continue;
    visit(node, parent);
    const children = Array.isArray(node.children) ? node.children : [];
    // Pushed in reverse so they come off in the browser's own order.
    for (let position = children.length - 1; position >= 0; position -= 1) {
      stack.push({ node: children[position], parent: node });
    }
  }
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
  current: () => { bookmarks: Bookmark[]; folders: Folder[] },
): Promise<ReconcileResult> {
  const tree = await api().getTree();
  const root = Array.isArray(tree) ? tree[0] : undefined;
  if (!root || typeof root !== "object" || typeof root.id !== "string") {
    throw new Error("The browser returned no bookmarks tree");
  }
  learnRootIds(root);
  // Read after the tree arrives, not before: reading the tree can take a while over the
  // bridge, and comparing it with an older copy of the library would undo edits made meanwhile.
  const { bookmarks: existingBookmarks, folders: existingFolders } = current();
  const existingFolderById = new Map(existingFolders.map((folder) => [folder.id, folder]));
  const existingBookmarkById = new Map(existingBookmarks.map((bookmark) => [bookmark.id, bookmark]));
  const isRoot = (node: TreeNode | null) => !node || node.id === INVISIBLE_ROOT_ID;

  const folders: Folder[] = [];
  const changedFolders: Folder[] = [];
  const seenFolderIds = new Set<string>();
  walkTree(root, (node, parent) => {
    if (!isFolderNode(node) || isRoot(node) || seenFolderIds.has(node.id)) return;
    seenFolderIds.add(node.id);
    const parentId = isRoot(parent) ? null : (parent as TreeNode).id;
    const previous = existingFolderById.get(node.id);
    const folder = previous ? mergedFolder(previous, node, parentId) : freshFolder(node, parentId);
    folders.push(folder);
    if (folder !== previous) changedFolders.push(folder);
  });

  const folderPaths = buildFolderPaths(folders);
  const bookmarks: Bookmark[] = [];
  const changedBookmarks: Bookmark[] = [];
  const seenBookmarkIds = new Set<string>();
  const unseen: { node: TreeNode; folderId: string | null }[] = [];
  walkTree(root, (node, parent) => {
    if (isFolderNode(node) || seenBookmarkIds.has(node.id)) return;
    seenBookmarkIds.add(node.id);
    const folderId = isRoot(parent) ? null : (parent as TreeNode).id;
    const previous = existingBookmarkById.get(node.id);
    if (!previous) {
      unseen.push({ node, folderId });
      return;
    }
    const bookmark = mergedBookmark(previous, node, folderId);
    bookmarks.push(bookmark);
    if (bookmark !== previous) changedBookmarks.push(bookmark);
  });

  /*
    Bookmarks this library has never seen each need a category and tags worked out, which is
    most of the cost of a first sync: over a second for ten thousand, with the page frozen.
    They are done in short slices with a pause between. Rows the library already has were
    compared above in one go, so nothing here is working from a copy that can go stale.
  */
  let sliceStarted = Date.now();
  let paused = false;
  for (const { node, folderId } of unseen) {
    const path = folderId ? (folderPaths.get(folderId) ?? "") : "";
    const bookmark = freshBookmark(node, folderId, path);
    bookmarks.push(bookmark);
    changedBookmarks.push(bookmark);
    if (Date.now() - sliceStarted > SLICE_MS) {
      await breathe();
      paused = true;
      sliceStarted = Date.now();
    }
  }
  if (paused) {
    // A bookmark can have arrived another way during a pause (from the other copy of the
    // library). The row that is here, with its tags and notes, is the one to keep.
    const arrived = new Map(current().bookmarks.map((bookmark) => [bookmark.id, bookmark]));
    for (let position = changedBookmarks.length - 1; position >= 0; position -= 1) {
      const candidate = changedBookmarks[position];
      if (!existingBookmarkById.has(candidate.id) && arrived.has(candidate.id)) changedBookmarks.splice(position, 1);
    }
  }

  const removedBookmarkIds = existingBookmarks
    .filter((bookmark) => bookmark.sourceId === CHROME_SOURCE_ID && !seenBookmarkIds.has(bookmark.id))
    .map((bookmark) => bookmark.id);

  // What is still filed where, once this sync's removals are counted, read as it is now.
  const removedBookmarks = new Set(removedBookmarkIds);
  const latest = current();
  const occupied = new Set<string>();
  for (const bookmark of latest.bookmarks) {
    if (bookmark.folderId && !removedBookmarks.has(bookmark.id)) occupied.add(bookmark.folderId);
  }
  for (const bookmark of bookmarks) if (bookmark.folderId) occupied.add(bookmark.folderId);
  const removedFolderIds = vanishedBrowserFolders(latest.folders, seenFolderIds, occupied);

  return { folders, bookmarks, changedFolders, changedBookmarks, removedBookmarkIds, removedFolderIds };
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
 * How many changes are sent to the browser at once.
 *
 * Moving or deleting thousands of bookmarks used to send every request in the same instant.
 * Besides flooding the extension, that started every echo mark's eight seconds at once: the
 * browser needs longer than that to work through ten thousand moves, so the later echoes
 * were mistaken for the person's own changes, and a late "removed" echo deleted a bookmark
 * that had only been moved to the trash. A short queue sends a few at a time and marks each
 * one as it is actually sent.
 */
const WRITE_CONCURRENCY = 6;
let writing = 0;
const writeQueue: (() => void)[] = [];

/** Sends one change to the browser. Resolves whether the browser now agrees; never rejects. */
function writeBack(id: string, operation: MirrorOperation, send: (target: BookmarksApi) => Promise<unknown>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const run = () => {
      writing += 1;
      let request: Promise<unknown>;
      try {
        markPending(id);
        request = send(api());
      } catch (error) {
        request = Promise.reject(error);
      }
      request
        .then(
          () => true,
          (error: unknown) => {
            mirrorFailed(operation, error);
            // Nothing to change on a bookmark the browser does not hold (an imported one).
            return isMissingNode(error);
          },
        )
        .then((agreed) => {
          writing -= 1;
          resolve(agreed);
          writeQueue.shift()?.();
        });
    };
    if (writing < WRITE_CONCURRENCY) run();
    else writeQueue.push(run);
  });
}

/**
 * Every write-back function below is `async` and never rejects — a caller that only
 * needs "fire and forget" can call it without `await` or a `.catch`, and a caller that
 * needs one write to land before the next starts (see `deleteFolder` in
 * `hooks/useLibrary.ts`) can `await` the exact same function.
 */
export async function updateBookmarkNode(id: string, changes: { title?: string; url?: string }): Promise<void> {
  if (!isChromeBookmarksAvailable()) return;
  await writeBack(id, "update", (target) => target.update(id, changes));
}

/**
 * Resolves `false` only when the browser was asked and refused. A caller about to remove
 * the folder the bookmark was in (`deleteFolder`) has to know, or the browser deletes the
 * bookmark along with the folder.
 */
export async function moveBookmarkNode(id: string, folderId: string | null): Promise<boolean> {
  if (!isChromeBookmarksAvailable()) return true;
  return writeBack(id, "move", (target) => target.move(id, { parentId: toChromeParentId(folderId) }));
}

/**
 * Moves a folder in the browser. Resolves `false` when the browser refused (its fixed
 * top-level folders cannot be moved), so the caller can leave the folder where it is.
 */
export async function moveFolderNode(id: string, parentId: string | null): Promise<boolean> {
  if (!isChromeBookmarksAvailable()) return true;
  return writeBack(id, "move", (target) => target.move(id, { parentId: toChromeParentId(parentId) }));
}

/**
 * Whether the browser holds a folder under this id.
 *
 * Folders made here or by an import carry this app's own ids; the browser's are its own
 * (numbers in Chrome, short codes in Firefox). There is no mapping table, so the id is the
 * only thing that says which kind a folder is.
 */
export function isBrowserFolderId(id: string): boolean {
  return isChromeBookmarksAvailable() && !id.startsWith("fld_");
}

export async function removeBookmarkNode(id: string): Promise<void> {
  if (!isChromeBookmarksAvailable()) return;
  await writeBack(id, "remove", (target) => target.remove(id));
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
  await writeBack(id, "rename-folder", (target) => target.update(id, { title }));
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
  await writeBack(id, "remove-folder", (target) => target.removeTree(id));
}

/* ---------------------------------------------------------------- live sync */

/**
 * What the library does with changes made on the browser's side.
 *
 * Changes arrive as *what changed*, not as whole rows. The library applies them a moment
 * later, in batches (the browser's own sync can deliver thousands of events in a burst), and
 * a whole row built when the event arrived would overwrite anything the person did to that
 * bookmark in between.
 */
export interface ChromeSyncHandlers {
  /** A bookmark this library has not seen appeared in the browser. */
  onBookmarkCreated: (bookmark: Bookmark) => void;
  /** Fields of a known bookmark changed in the browser. */
  onBookmarkPatched: (id: string, patch: Partial<Bookmark>) => void;
  onBookmarkRemoved: (ids: string[]) => void;
  onFolderCreated: (folder: Folder) => void;
  onFolderPatched: (id: string, patch: Partial<Folder>) => void;
  onFolderRemoved: (ids: string[]) => void;
  /** A bulk change (Chrome's own bookmark import, or a large paste) landed all at once. */
  onBulkChange: () => void;
  /** One row as the library holds it now, including changes not applied yet. */
  findBookmark: (id: string) => Bookmark | undefined;
  findFolder: (id: string) => Folder | undefined;
}

function collectSubtreeIds(node: TreeNode): { bookmarkIds: string[]; folderIds: string[] } {
  const bookmarkIds: string[] = [];
  const folderIds: string[] = [];
  walkTree(node, (current) => {
    if (isFolderNode(current)) folderIds.push(current.id);
    else bookmarkIds.push(current.id);
  });
  return { bookmarkIds, folderIds };
}

/** One folder's path, by walking up from it. Naming every folder for one event was the cost of the whole tree per bookmark. */
function folderPathOf(findFolder: (id: string) => Folder | undefined, folderId: string | null): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor = folderId;
  while (cursor && !seen.has(cursor) && names.length < MAX_FOLDER_DEPTH) {
    seen.add(cursor);
    const folder = findFolder(cursor);
    if (!folder) break;
    names.unshift(folder.name);
    cursor = folder.parentId;
  }
  return names.join(" / ");
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

  /*
    Every listener below runs inside the browser's event dispatch. One that throws on an
    unexpected payload would surface as an unhandled error per event, so each is contained
    and logged; the next full reconcile corrects whatever it missed.
  */
  const contained =
    <A extends unknown[]>(event: string, listener: (...args: A) => void) =>
    (...args: A) => {
      try {
        listener(...args);
      } catch (error) {
        log.warn("chrome-sync.event-failed", { event, error });
      }
    };

  const onCreated = contained("created", (id: string, node: TreeNode) => {
    if (importing || consumePending(id)) return;
    if (!node || typeof node.id !== "string") return;
    const parentId = typeof node.parentId === "string" && node.parentId !== INVISIBLE_ROOT_ID ? node.parentId : null;
    if (isFolderNode(node)) {
      handlers.onFolderCreated(freshFolder(node, parentId));
    } else {
      handlers.onBookmarkCreated(freshBookmark(node, parentId, folderPathOf(handlers.findFolder, parentId)));
    }
  });

  const onRemoved = contained("removed", (id: string, removeInfo: chrome.bookmarks.BookmarkRemoveInfo) => {
    if (importing || consumePending(id)) return;
    const node = removeInfo?.node;
    if (node && isFolderNode(node)) {
      const { bookmarkIds, folderIds } = collectSubtreeIds(node);
      if (bookmarkIds.length) handlers.onBookmarkRemoved(bookmarkIds);
      handlers.onFolderRemoved(folderIds.includes(id) ? folderIds : [id, ...folderIds]);
    } else {
      // In the trash here means this app removed it from the browser itself. Whatever the
      // echo mark says, that must never delete the copy the person can still restore.
      if (handlers.findBookmark(id)?.trashedAt) return;
      handlers.onBookmarkRemoved([id]);
    }
  });

  const onChanged = contained("changed", (id: string, changeInfo: chrome.bookmarks.BookmarkChangeInfo) => {
    if (importing || consumePending(id) || !changeInfo) return;
    const bookmark = handlers.findBookmark(id);
    if (bookmark) {
      if (bookmark.editedAt) return; // hand-edited locally; Chrome's title/url loses.
      const patch: Partial<Bookmark> = {};
      const title = typeof changeInfo.title === "string" ? changeInfo.title.trim() : "";
      if (title && title !== bookmark.title) patch.title = title;
      if (typeof changeInfo.url === "string" && changeInfo.url !== bookmark.url) {
        patch.url = changeInfo.url;
        patch.domain = getDomain(changeInfo.url);
      }
      if (Object.keys(patch).length) handlers.onBookmarkPatched(id, patch);
      return;
    }
    const folder = handlers.findFolder(id);
    if (folder && typeof changeInfo.title === "string" && changeInfo.title && changeInfo.title !== folder.name) {
      handlers.onFolderPatched(id, { name: changeInfo.title, lastModifiedAt: Date.now() });
    }
  });

  const onMoved = contained("moved", (id: string, moveInfo: chrome.bookmarks.BookmarkMoveInfo) => {
    if (importing || consumePending(id) || !moveInfo || typeof moveInfo.parentId !== "string") return;
    const bookmark = handlers.findBookmark(id);
    if (bookmark) {
      if (bookmark.folderId === moveInfo.parentId && bookmark.sourceOrder === moveInfo.index) return;
      handlers.onBookmarkPatched(id, { folderId: moveInfo.parentId, sourceOrder: moveInfo.index });
      return;
    }
    // A folder named as its own parent would vanish from the tree along with its contents.
    if (handlers.findFolder(id) && moveInfo.parentId !== id) {
      handlers.onFolderPatched(id, { parentId: moveInfo.parentId, sourceOrder: moveInfo.index });
    }
  });

  const onReordered = contained("reordered", (_id: string, reorderInfo: chrome.bookmarks.BookmarkReorderInfo) => {
    if (importing || !Array.isArray(reorderInfo?.childIds)) return;
    reorderInfo.childIds.forEach((childId, index) => {
      const bookmark = handlers.findBookmark(childId);
      if (bookmark) {
        if (bookmark.sourceOrder !== index) handlers.onBookmarkPatched(childId, { sourceOrder: index });
        return;
      }
      const folder = handlers.findFolder(childId);
      if (folder && folder.sourceOrder !== index) handlers.onFolderPatched(childId, { sourceOrder: index });
    });
  });

  const onImportBegan = () => {
    importing = true;
  };
  const onImportEnded = contained("import-ended", () => {
    importing = false;
    handlers.onBulkChange();
  });

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
