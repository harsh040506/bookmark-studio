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

/** Maps folder id to its full "Bookmarks bar / Design / Fonts" path. */
export function buildFolderPaths(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();

  const resolve = (id: string, seen: Set<string>): string => {
    const cached = paths.get(id);
    if (cached) return cached;
    const folder = byId.get(id);
    if (!folder || seen.has(id)) return "";
    seen.add(id);
    const parentPath = folder.parentId ? resolve(folder.parentId, seen) : "";
    const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
    paths.set(id, path);
    return path;
  };

  for (const folder of folders) resolve(folder.id, new Set());
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

export function folderChildren(folders: Folder[]): Map<string | null, Folder[]> {
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const list = children.get(folder.parentId) ?? [];
    list.push(folder);
    children.set(folder.parentId, list);
  }
  for (const list of children.values()) {
    list.sort(compareFolders);
  }
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
