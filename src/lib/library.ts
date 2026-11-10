/**
 * Library derivations that are not selection.
 *
 * Selection — which rows a view shows — lives in `lib/engine.ts`, which is index-backed
 * and runs per keystroke. What is left here is the pure, occasional work: folder-tree
 * arithmetic, the documents the search index is built from, and duplicate resolution.
 *
 * All pure functions. The React layer owns state; this module owns meaning.
 */
import type { Bookmark, Folder, SortMode } from "../../shared/types";
import type { RawDoc } from "./index.worker";
import { TfIdfIndex, type IndexDoc } from "./tfidf";
import { canonicalUrl, tokenize, tokenizeDomain } from "./text";

/** Re-exported so UI modules import sorting from one place. */
export type { SortMode };

/**
 * How deep a folder tree is followed by name.
 *
 * Real libraries nest five to ten levels. The limit is for the trees nobody made by hand: a
 * damaged backup or a hostile file can describe a chain thousands of folders long, and a
 * full path for each of those is quadratic in text. Imports stop creating folders below this
 * depth (see `import/normalize.ts`), and paths below it are shortened rather than grown.
 */
export const MAX_FOLDER_DEPTH = 32;

/**
 * Maps folder id to its full "Bookmarks bar / Design / Fonts" path.
 *
 * A loop, not recursion: the tree comes from storage, a backup, the browser or the other
 * copy of the library, and a chain deep enough to overflow the stack would crash every
 * page load. Each folder is visited once. A folder whose parent is missing, or that sits in
 * a loop of parents, is treated as top-level instead of being left without a path.
 */
export function buildFolderPaths(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  const depths = new Map<string, number>();
  /** For folders below the limit: the path of their ancestor at the limit. */
  const bases = new Map<string, string>();

  for (const start of folders) {
    if (paths.has(start.id)) continue;

    // Walk up to the nearest folder that already has a path (or to the top).
    const chain: Folder[] = [];
    const onChain = new Set<string>();
    let cursor: Folder | undefined = start;
    while (cursor && !paths.has(cursor.id) && !onChain.has(cursor.id)) {
      chain.push(cursor);
      onChain.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }

    const resolved = cursor && paths.has(cursor.id) ? cursor : undefined;
    let parentPath = resolved ? (paths.get(resolved.id) ?? "") : "";
    let depth = resolved ? (depths.get(resolved.id) ?? 0) : 0;
    let base = resolved ? (bases.get(resolved.id) ?? parentPath) : "";

    // Then back down, naming each folder from its parent.
    for (let position = chain.length - 1; position >= 0; position -= 1) {
      const folder = chain[position];
      depth += 1;
      let path: string;
      if (depth <= MAX_FOLDER_DEPTH) {
        path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
        base = path;
      } else {
        path = `${base} / … / ${folder.name}`;
        bases.set(folder.id, base);
      }
      paths.set(folder.id, path);
      depths.set(folder.id, depth);
      parentPath = path;
    }
  }
  return paths;
}

/**
 * Orders sibling folders the way the person who made them would expect.
 *
 * Four rules, applied in order:
 *   1. **The bookmarks bar first.** Every browser puts it first, every user thinks of it
 *      as first, and it is the folder they reach for most. Alphabetising it into the
 *      middle of the list is technically consistent and practically wrong.
 *   2. **Then the imported arrangement,** at every depth. A bookmark tree is hand-built
 *      over years; that sequence carries meaning no timestamp records. Because the
 *      ordinal is a single counter running through the whole file, comparing it sorts
 *      siblings correctly at the root and inside nested subfolders alike.
 *   3. **Then by creation date.** This is the fallback for folders that predate ordinal
 *      tracking, and it is chosen over the name deliberately: the order someone built
 *      their folders in is a far better guess at their mental model than the alphabet,
 *      which is an order nobody chose.
 *   4. **Then by name,** to keep the comparator total — without a final tiebreak, folders
 *      created in the same millisecond would sort unpredictably between renders.
 */
export function compareFolders(a: Folder, b: Folder): number {
  if (Boolean(a.toolbar) !== Boolean(b.toolbar)) return a.toolbar ? -1 : 1;
  const left = a.sourceOrder ?? Number.MAX_SAFE_INTEGER;
  const right = b.sourceOrder ?? Number.MAX_SAFE_INTEGER;
  if (left !== right) return left - right;
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
  return a.name.localeCompare(b.name);
}

/**
 * Children by parent, kept per folder list.
 *
 * The folder list is replaced, never edited in place, so the array itself is the version.
 * Without this the tree was regrouped and every sibling list re-sorted on each keystroke of
 * a search inside a folder, because selection asks for the subtree every time.
 */
const childrenCache = new WeakMap<Folder[], Map<string | null, Folder[]>>();

/** Sibling lists in display order, keyed by parent id. Shared: callers must not change them. */
export function folderChildren(folders: Folder[]): Map<string | null, Folder[]> {
  const cached = childrenCache.get(folders);
  if (cached) return cached;
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const list = children.get(folder.parentId) ?? [];
    list.push(folder);
    children.set(folder.parentId, list);
  }
  for (const list of children.values()) {
    list.sort(compareFolders);
  }
  childrenCache.set(folders, children);
  return children;
}

/** All descendant folder ids, inclusive — used so a folder view includes its subfolders. */
export function folderSubtree(folders: Folder[], rootId: string): Set<string> {
  const children = folderChildren(folders);
  const result = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const current = queue.pop() as string;
    for (const child of children.get(current) ?? []) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

/**
 * Bookmarks in each folder including everything nested under it.
 *
 * `counts` is what sits directly in each folder. One walk down from the top and one back up,
 * with no recursion, so the cost is the number of folders whatever their depth. A folder
 * that cannot be reached from the top (its parent is missing) is left out; `repairFolders`
 * moves those to the top level when the library is read.
 */
export function folderTotals(folders: Folder[], counts: Map<string, number>): Map<string, number> {
  const children = folderChildren(folders);
  const order: Folder[] = [];
  const seen = new Set<string>();
  const stack = [...(children.get(null) ?? [])];
  while (stack.length) {
    const folder = stack.pop() as Folder;
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    order.push(folder);
    for (const child of children.get(folder.id) ?? []) stack.push(child);
  }

  const totals = new Map<string, number>();
  for (const folder of order) totals.set(folder.id, counts.get(folder.id) ?? 0);
  // Parents come before their children in `order`, so walking it backwards finishes every
  // child before its total is added to the parent.
  for (let position = order.length - 1; position >= 0; position -= 1) {
    const folder = order[position];
    if (!folder.parentId) continue;
    const parentTotal = totals.get(folder.parentId);
    if (parentTotal !== undefined) totals.set(folder.parentId, parentTotal + (totals.get(folder.id) ?? 0));
  }
  return totals;
}

/** The folders above this one, nearest first. Stops at a missing parent or a loop. */
export function folderAncestors(folders: Folder[], id: string): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const ancestors: string[] = [];
  const seen = new Set<string>([id]);
  let cursor = byId.get(id)?.parentId ?? null;
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    ancestors.push(cursor);
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return ancestors;
}

/**
 * Why a folder cannot be moved under another, in words for the person, or `null` if it can.
 *
 * A folder moved into itself or into one of its own subfolders becomes a loop: it and
 * everything in it drop out of the tree. Checked here, once, for every way a move can be
 * asked for.
 *
 * @param parentId The folder to move into, or `null` for the top level.
 */
export function folderMoveProblem(folders: Folder[], id: string, parentId: string | null): string | null {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const folder = byId.get(id);
  if (!folder) return "That folder is no longer here.";
  if (parentId === null) return null;
  if (!byId.has(parentId)) return "The folder you chose is no longer here.";
  if (parentId === id) return "A folder cannot be moved into itself.";
  if (folderSubtree(folders, id).has(parentId)) return "A folder cannot be moved into one of its own subfolders.";

  // How deep the moved folder's lowest subfolder would end up.
  const below = (() => {
    const children = folderChildren(folders);
    let deepest = 1;
    const stack: { id: string; depth: number }[] = [{ id, depth: 1 }];
    const seen = new Set<string>();
    while (stack.length) {
      const current = stack.pop() as { id: string; depth: number };
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      deepest = Math.max(deepest, current.depth);
      for (const child of children.get(current.id) ?? []) stack.push({ id: child.id, depth: current.depth + 1 });
    }
    return deepest;
  })();
  const above = folderAncestors(folders, parentId).length + 1;
  if (above + below > MAX_FOLDER_DEPTH) return `Folders can be nested ${MAX_FOLDER_DEPTH} levels deep at most.`;
  return null;
}

/** One folder prepared for searching: its path, and both texts folded once. */
export interface FolderEntry {
  folder: Folder;
  path: string;
  name: string;
  folded: string;
}

/** Every folder that may be chosen, in path order. Built when the tree changes, not per keystroke. */
export function folderEntries(
  folders: Folder[],
  folderPaths: Map<string, string>,
  exclude?: ReadonlySet<string>,
): FolderEntry[] {
  const entries: FolderEntry[] = [];
  for (const folder of folders) {
    if (exclude?.has(folder.id)) continue;
    const path = folderPaths.get(folder.id) ?? folder.name;
    entries.push({ folder, path, name: folder.name.toLowerCase(), folded: path.toLowerCase() });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Folders that match what was typed, best first.
 *
 * A folder whose own name starts with the text outranks one whose name merely contains it,
 * which outranks one matched only through a parent's name. Without that order, typing
 * "design" in a deep tree lists every folder *under* Design before Design itself.
 * `exact` says whether some folder already has exactly this name or path, which is what
 * decides whether "create a folder called…" is offered.
 */
export function rankFolders(entries: FolderEntry[], query: string): { matches: FolderEntry[]; exact: boolean } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { matches: entries, exact: false };
  const starts: FolderEntry[] = [];
  const inName: FolderEntry[] = [];
  const inPath: FolderEntry[] = [];
  let exact = false;
  for (const entry of entries) {
    if (entry.name === needle || entry.folded === needle) exact = true;
    if (entry.name.startsWith(needle)) starts.push(entry);
    else if (entry.name.includes(needle)) inName.push(entry);
    else if (entry.folded.includes(needle)) inPath.push(entry);
  }
  return { matches: [...starts, ...inName, ...inPath], exact };
}

export function documentSource(bookmark: Bookmark, folderPath: string): RawDoc {
  return {
    id: bookmark.id,
    texts: [
      // Twice: the title is the strongest single signal a bookmark carries.
      bookmark.title,
      bookmark.title,
      bookmark.description,
      bookmark.summary ?? "",
      bookmark.category,
      ...bookmark.tags,
      folderPath,
      bookmark.note ?? "",
      // Alt text is written to describe the picture, which makes it the best single
      // sentence about an image the library holds — and the only one for an upload.
      bookmark.alt ?? "",
      // A post's own words are the only thing it has to be found by, so they carry the
      // same weight as a page's title rather than the weight of its body text.
      bookmark.text ?? "",
      bookmark.author ?? "",
      bookmark.language ?? "",
      ...(bookmark.highlights ?? []).map((highlight) => highlight.text),
      // Scraped signal: headings and keywords describe the page in its own words,
      // and the site name catches "figma" for a bookmark titled only "Files".
      ...(bookmark.meta?.headings ?? []),
      ...(bookmark.meta?.keywords ?? []),
      ...(bookmark.meta?.tech ?? []),
      ...(bookmark.meta?.fonts ?? []),
      bookmark.meta?.siteName ?? "",
      bookmark.meta?.author ?? "",
      bookmark.meta?.text ?? "",
    ],
    // Twice, for the same reason as the title: the host is how people remember a link.
    domains: [bookmark.domain, bookmark.domain],
  };
}

/** The same document, already split into stemmed terms, for the synchronous path. */
export function documentTerms(bookmark: Bookmark, folderPath: string): string[] {
  const source = documentSource(bookmark, folderPath);
  const terms: string[] = [];
  for (const text of source.texts) {
    if (text) terms.push(...tokenize(text));
  }
  for (const domain of source.domains) {
    if (domain) terms.push(...tokenizeDomain(domain));
  }
  return terms;
}

/** The folder path a bookmark sits at, or the empty string when it is filed nowhere. */
export function pathOf(bookmark: Bookmark, folderPaths: Map<string, string>): string {
  return bookmark.folderId ? (folderPaths.get(bookmark.folderId) ?? "") : "";
}

/** One bookmark as an index document. */
export function toIndexDoc(bookmark: Bookmark, folderPaths: Map<string, string>): IndexDoc {
  return { id: bookmark.id, terms: documentTerms(bookmark, pathOf(bookmark, folderPaths)) };
}

/** Documents fed to TF-IDF. Title terms are repeated so they outweigh body text. */
export function buildIndex(bookmarks: Bookmark[], folderPaths: Map<string, string>): TfIdfIndex {
  return new TfIdfIndex(bookmarks.map((bookmark) => toIndexDoc(bookmark, folderPaths)));
}

/**
 * Duplicate groups, keyed by the array they were computed from.
 *
 * The same reasoning as the look-alike cache in `lib/visual.ts`: the library array is
 * replaced on every commit, so its identity is the library's version, and a WeakMap on it
 * gives per-version memoisation with no counter to keep in step and no invalidation call
 * to forget. A superseded entry is collected along with the array it describes.
 *
 * This runs inside `selectBookmarks` for the Duplicates and Cleanup scopes — so on every
 * keystroke of a search in those views — and again inside `computeStats`. It canonicalises
 * every URL in the library each time, which is a `new URL` and a parameter sweep per row.
 */
const duplicateCache = new WeakMap<Bookmark[], Map<string, Bookmark[]>>();

/** Groups bookmarks that point at the same canonical URL. */
export function findDuplicates(bookmarks: Bookmark[]): Map<string, Bookmark[]> {
  const cached = duplicateCache.get(bookmarks);
  if (cached) return cached;

  const groups = new Map<string, Bookmark[]>();
  for (const bookmark of bookmarks) {
    const key = canonicalUrl(bookmark.url);
    const list = groups.get(key) ?? [];
    list.push(bookmark);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    if (list.length < 2) groups.delete(key);
  }
  duplicateCache.set(bookmarks, groups);
  return groups;
}

export interface DuplicatePlan {
  /** Survivors, already merged with everything their copies knew. */
  keep: Bookmark[];
  /** Ids to delete once the survivors are written. */
  remove: string[];
  /** How many groups were collapsed, for the confirmation copy. */
  groups: number;
}

/**
 * Works out how to collapse duplicate bookmarks without losing anything.
 *
 * Finding duplicates is easy; resolving them safely is the part that matters. A naive
 * "keep the first, delete the rest" throws away real work — the copy filed in a folder,
 * the one someone tagged, the one with a note — because duplicates in a browser export
 * are rarely identical records. So one survivor is elected per group and then *enriched*
 * from its siblings before they are removed.
 *
 * Election order, strongest signal first:
 *   1. a favourite, because someone deliberately marked it;
 *   2. a hand-edited record, for the same reason;
 *   3. the one whose page has actually been read, which carries the description,
 *      summary and search text;
 *   4. the most-visited;
 *   5. the oldest, which is the original save and holds the truest `addedAt`.
 *
 * Merging is strictly additive: tags and board memberships are unioned, and a missing
 * field on the survivor is filled from the first sibling that has one. Nothing already
 * present on the survivor is overwritten, so the election result is never undone by the
 * merge.
 *
 * @param bookmarks The full library; archived entries take part, because a duplicate
 *   hiding in the archive is still a duplicate.
 * @returns A plan the caller commits as one undoable mutation. Empty when nothing is
 *   duplicated.
 */
export function planDuplicateCleanup(bookmarks: Bookmark[]): DuplicatePlan {
  const keep: Bookmark[] = [];
  const remove: string[] = [];
  let groups = 0;

  const rank = (bookmark: Bookmark): number[] => [
    bookmark.favorite ? 1 : 0,
    bookmark.editedAt ? 1 : 0,
    bookmark.enriched && !bookmark.meta?.error ? 1 : 0,
    bookmark.visitCount,
    // Negated so a smaller timestamp — an older save — sorts as the stronger candidate.
    -bookmark.addedAt,
  ];

  for (const group of findDuplicates(bookmarks).values()) {
    groups += 1;
    const [survivor, ...losers] = [...group].sort((a, b) => {
      const left = rank(a);
      const right = rank(b);
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return right[index] - left[index];
      }
      return 0;
    });

    const merged: Bookmark = {
      ...survivor,
      tags: [...new Set([...survivor.tags, ...losers.flatMap((row) => row.tags)])].slice(0, 24),
      boardIds: [...new Set([...survivor.boardIds, ...losers.flatMap((row) => row.boardIds)])],
      // Visits are a count of intent across every copy, so they add rather than compete.
      visitCount: group.reduce((sum, row) => sum + row.visitCount, 0),
      lastVisitedAt: group.reduce<number | undefined>(
        (latest, row) => (row.lastVisitedAt && (!latest || row.lastVisitedAt > latest) ? row.lastVisitedAt : latest),
        survivor.lastVisitedAt,
      ),
      /**
       * The earliest save is the truthful "added" date for the merged record.
       *
       * Reduced rather than spread into `Math.min`. A group is every bookmark sharing one
       * canonical URL, and a library that has had the same export merged repeatedly can
       * hold tens of thousands of copies of a single link — past the engine's argument
       * limit, where the spread stops being a number and becomes a RangeError thrown in
       * the middle of a merge the user has already confirmed.
       */
      addedAt: group.reduce((earliest, row) => Math.min(earliest, row.addedAt), Infinity),
      description: survivor.description || losers.find((row) => row.description)?.description || "",
      note: survivor.note ?? losers.find((row) => row.note)?.note,
      folderId: survivor.folderId ?? losers.find((row) => row.folderId)?.folderId ?? null,
      icon: survivor.icon ?? losers.find((row) => row.icon)?.icon,
      // A merged record is only archived if every copy was; otherwise something active
      // would silently disappear from the default view.
      archived: group.every((row) => row.archived) ? true : undefined,
      favorite: group.some((row) => row.favorite) || undefined,
    };

    keep.push(merged);
    for (const loser of losers) remove.push(loser.id);
  }

  return { keep, remove, groups };
}

export function formatRelative(timestamp?: number): string {
  if (!timestamp) return "never";
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Replaces automatically added tags made by the old word-splitting rule.
 *
 * Earlier versions tagged an import with the loose words of its title and folder, so a
 * folder called "Everything Else & Stuff" put `everything`, `else` and `stuff` on every
 * bookmark inside it. This keeps every tag the person added themselves, keeps derived tags
 * that name a real topic, and re-suggests from the topic vocabulary. Returns only the rows
 * that changed, so a library that is already clean costs one pass and no writes.
 */
export function retagDerived(
  bookmarks: Bookmark[],
  folderPaths: Map<string, string>,
  suggest: (input: { url: string; title: string; folderPath: string; description?: string }) => string[],
  isTopic: (tag: string) => boolean,
): Bookmark[] {
  const changed: Bookmark[] = [];
  for (const bookmark of bookmarks) {
    const derived = bookmark.derivedTags;
    if (!derived?.length || !bookmark.url) continue;
    const own = bookmark.tags.filter((tag) => !derived.includes(tag));
    const kept = derived.filter((tag) => isTopic(tag) && bookmark.tags.includes(tag));
    const fresh = suggest({
      url: bookmark.url,
      title: bookmark.title,
      folderPath: pathOf(bookmark, folderPaths),
      description: bookmark.description,
    }).filter((tag) => !own.includes(tag));
    const nextDerived = [...new Set([...kept, ...fresh])].slice(0, 4);
    const nextTags = [...own, ...nextDerived].slice(0, 24);
    const same =
      nextTags.length === bookmark.tags.length && nextTags.every((tag, index) => tag === bookmark.tags[index]);
    if (same) continue;
    changed.push({ ...bookmark, tags: nextTags, derivedTags: nextDerived.length ? nextDerived : undefined });
  }
  return changed;
}
