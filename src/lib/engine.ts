/**
 * The selection engine.
 *
 * ## The problem this exists to solve
 *
 * Every view in this app is "the library, filtered and sorted". The obvious implementation
 * is `bookmarks.filter(…).sort(…)`, and it is what the app used to do — once per render,
 * per keystroke, over the whole library. At a thousand rows nobody notices. At fifty
 * thousand it is roughly forty milliseconds of string lowercasing and a full comparison
 * sort on the main thread *between every two characters typed*, which is a search box that
 * visibly lags behind the person using it.
 *
 * Three changes make it flat instead:
 *
 * 1. **Lower-case once, not per comparison.** A row's title, domain, tags and folder path
 *    are folded when the index is built. A filter pass then does no allocation at all —
 *    the single largest cost in the old path was creating a lower-cased copy of every
 *    title on every keystroke and throwing it away.
 *
 * 2. **Sort once per order, not once per query.** The comparison sorts live in
 *    {@link LibraryIndex} as permutations of row positions, built lazily and cached for
 *    the life of the index. Filtering then *walks* the chosen order and keeps what passes,
 *    so results come out sorted without a sort. Changing the filter is O(n) with a
 *    branch per row; changing the sort is a map lookup.
 *
 * 3. **Numbers, not objects.** State, format, flags and timestamps are typed arrays keyed
 *    by row position, so the hot loop touches contiguous memory and never dereferences a
 *    `Bookmark` unless a rarely-used filter demands it.
 *
 * ## What it deliberately does not do
 *
 * It does not window. The engine returns *every* matching row position, because the count
 * has to be honest — a view that says "142 results" while holding 60 is worse than one
 * that took a millisecond longer. Windowing is the grid's job, and the grid does it over
 * an `Int32Array` that costs four bytes a row.
 *
 * It also does not own the text index: free-text ranking is TF-IDF, which lives in
 * `lib/tfidf.ts` and is built incrementally elsewhere. This consumes its output.
 */
import {
  formatOf,
  itemKind,
  type Bookmark,
  type FormatFacet,
  type Folder,
  type SortMode,
} from "../../shared/types";
import { folderSubtree } from "./library";
import type { ParsedQuery } from "./query";
import { facetToKinds } from "./query";
import type { TfIdfIndex } from "./tfidf";
import { colorScore, findLookalikes, groupLookalikes, type MatchStrength } from "./visual";

/* --------------------------------------------------------------- the index */

/** The three mutually exclusive places a row can be, as a number. */
const STATE_LIVE = 0;
const STATE_ARCHIVE = 1;
const STATE_TRASH = 2;

/** Bit flags, packed so the hot loop reads one byte instead of six properties. */
const FLAG_FAVORITE = 1 << 0;
const FLAG_UNTAGGED = 1 << 1;
const FLAG_NEVER_VISITED = 1 << 2;
const FLAG_HAS_MEDIA = 1 << 3;
const FLAG_HAS_OFFLINE = 1 << 4;
const FLAG_HAS_PICTURE = 1 << 5;
const FLAG_NEEDS_REVIEW = 1 << 6;
const FLAG_UNCHECKED = 1 << 7;

const FORMATS: FormatFacet[] = ["links", "images", "videos", "notes"];
const HEALTHS = ["live", "redirected", "dead", "blocked", "unchecked"] as const;

export interface LibraryIndex {
  rows: Bookmark[];
  count: number;
  byId: Map<string, number>;

  /* Folded text, computed once. */
  title: string[];
  domain: string[];
  tags: string[][];
  category: string[];
  folderPath: string[];

  /* Numeric columns. */
  state: Uint8Array;
  format: Uint8Array;
  kindOf: Uint8Array;
  health: Uint8Array;
  flags: Uint8Array;
  addedAt: Float64Array;
  arrivedAt: Float64Array;
  visits: Int32Array;

  /* Identity columns, kept as parallel arrays so a filter never touches the row. */
  folderId: (string | null)[];
  boardIds: string[][];
  importId: (string | undefined)[];
  sourceId: (string | undefined)[];

  /** Sort permutations, built on demand and cached. */
  orders: Map<SortMode, Int32Array>;
  /** Row positions that share a canonical URL with another row. */
  duplicates: Set<number> | null;
  /** Row positions whose picture matches another row's. */
  lookalikes: Set<number> | null;
}

const KIND_ORDER = ["link", "image", "video", "note", "clip", "code"] as const;

/**
 * Builds the index.
 *
 * Linear, single-pass, and the only place in the app that lower-cases a title. Called once
 * per library version — an import, a commit, an undo — and never during a render.
 */
export function buildLibraryIndex(
  bookmarks: Bookmark[],
  folderPaths: Map<string, string>,
): LibraryIndex {
  const count = bookmarks.length;
  const index: LibraryIndex = {
    rows: bookmarks,
    count,
    byId: new Map(),
    title: new Array<string>(count),
    domain: new Array<string>(count),
    tags: new Array<string[]>(count),
    category: new Array<string>(count),
    folderPath: new Array<string>(count),
    state: new Uint8Array(count),
    format: new Uint8Array(count),
    kindOf: new Uint8Array(count),
    health: new Uint8Array(count),
    flags: new Uint8Array(count),
    addedAt: new Float64Array(count),
    arrivedAt: new Float64Array(count),
    visits: new Int32Array(count),
    folderId: new Array<string | null>(count),
    boardIds: new Array<string[]>(count),
    importId: new Array<string | undefined>(count),
    sourceId: new Array<string | undefined>(count),
    orders: new Map(),
    duplicates: null,
    lookalikes: null,
  };

  for (let position = 0; position < count; position += 1) {
    const row = bookmarks[position];
    index.byId.set(row.id, position);
    index.title[position] = row.title.toLowerCase();
    index.domain[position] = row.domain.toLowerCase();
    index.tags[position] = row.tags.length ? row.tags.map((tag) => tag.toLowerCase()) : EMPTY_TAGS;
    index.category[position] = row.category.toLowerCase();
    index.folderPath[position] = row.folderId
      ? (folderPaths.get(row.folderId) ?? "").toLowerCase()
      : "";

    index.state[position] = row.trashedAt ? STATE_TRASH : row.archived ? STATE_ARCHIVE : STATE_LIVE;
    index.format[position] = FORMATS.indexOf(formatOf(row));
    index.kindOf[position] = KIND_ORDER.indexOf(itemKind(row));
    index.health[position] = Math.max(0, HEALTHS.indexOf(row.health.status));

    let flags = 0;
    if (row.favorite) flags |= FLAG_FAVORITE;
    if (!row.tags.length) flags |= FLAG_UNTAGGED;
    if (!row.visitCount) flags |= FLAG_NEVER_VISITED;
    if (row.media?.assetKey) flags |= FLAG_HAS_MEDIA;
    if (row.offline?.assetKey) flags |= FLAG_HAS_OFFLINE;
    if (row.media?.assetKey || row.preview.imageUrl || row.preview.shotAt) flags |= FLAG_HAS_PICTURE;
    if (row.health.status !== "live" && row.health.status !== "unchecked") flags |= FLAG_NEEDS_REVIEW;
    if (row.health.status === "unchecked") flags |= FLAG_UNCHECKED;
    index.flags[position] = flags;

    index.addedAt[position] = row.addedAt;
    index.arrivedAt[position] = row.importedAt ?? row.addedAt;
    index.visits[position] = row.visitCount;
    index.folderId[position] = row.folderId;
    index.boardIds[position] = row.boardIds.length ? row.boardIds : EMPTY_TAGS;
    index.importId[position] = row.importId;
    index.sourceId[position] = row.sourceId;
  }

  return index;
}

/** One shared empty array, so a hundred thousand untagged rows do not allocate. */
const EMPTY_TAGS: string[] = [];

/* ---------------------------------------------------------------- ordering */

/**
 * The permutation for one sort, built on first use.
 *
 * Every comparator here is *total*: a partial one leaves equal-ranked rows in whatever
 * order the previous filter emitted, which changes under an unrelated edit and makes the
 * grid appear to shuffle itself for no reason the user can see.
 */
function orderFor(index: LibraryIndex, sort: SortMode): Int32Array {
  const cached = index.orders.get(sort);
  if (cached) return cached;

  const order = new Int32Array(index.count);
  for (let position = 0; position < index.count; position += 1) order[position] = position;

  const { addedAt, arrivedAt, visits, title, domain, rows } = index;
  const byTitle = (a: number, b: number) => (title[a] < title[b] ? -1 : title[a] > title[b] ? 1 : a - b);

  // `Array.prototype.sort` on a typed array sorts numerically by default, so the
  // comparator is passed explicitly in every branch.
  const sorted = Array.from(order);
  switch (sort) {
    case "oldest":
      sorted.sort((a, b) => addedAt[a] - addedAt[b] || byTitle(a, b));
      break;
    case "title":
      sorted.sort(byTitle);
      break;
    case "visits":
      sorted.sort((a, b) => visits[b] - visits[a] || addedAt[b] - addedAt[a] || byTitle(a, b));
      break;
    case "domain":
      sorted.sort((a, b) =>
        domain[a] < domain[b] ? -1 : domain[a] > domain[b] ? 1 : byTitle(a, b),
      );
      break;
    case "custom":
      /*
       * Arrival first, then position within that arrival.
       *
       * The ordinal is only meaningful relative to the file it came from: two imports both
       * number their entries from zero, so comparing ordinals first interleaves them —
       * entry 3 of last year's export lands between entries 2 and 4 of today's.
       */
      sorted.sort(
        (a, b) =>
          arrivedAt[a] - arrivedAt[b] ||
          (rows[a].sourceOrder ?? Number.MAX_SAFE_INTEGER) -
            (rows[b].sourceOrder ?? Number.MAX_SAFE_INTEGER) ||
          byTitle(a, b),
      );
      break;
    case "relevance":
    // Relevance has no static order — it is imposed per query. Fall through to newest so
    // a relevance sort with no query is still a sensible list rather than insertion order.
    default:
      sorted.sort((a, b) => addedAt[b] - addedAt[a] || byTitle(a, b));
  }

  const permutation = Int32Array.from(sorted);
  index.orders.set(sort, permutation);
  return permutation;
}

/* -------------------------------------------------------------- duplicates */

/**
 * Row positions that share a canonical URL with at least one other row.
 *
 * Cached on the index rather than memoised by library version, because the index *is* the
 * version: a new index means a changed library, and a stale duplicate set cannot outlive
 * the array it indexes into.
 */
export function duplicatePositions(index: LibraryIndex): Set<number> {
  if (index.duplicates) return index.duplicates;
  const groups = new Map<string, number[]>();
  for (let position = 0; position < index.count; position += 1) {
    if (index.state[position] === STATE_TRASH) continue;
    const row = index.rows[position];
    if (!row.url) continue;
    const key = canonicalKey(row.url);
    const list = groups.get(key);
    if (list) list.push(position);
    else groups.set(key, [position]);
  }
  const duplicates = new Set<number>();
  for (const list of groups.values()) {
    if (list.length > 1) for (const position of list) duplicates.add(position);
  }
  index.duplicates = duplicates;
  return duplicates;
}

/**
 * A URL reduced to what makes it the same page.
 *
 * Inlined rather than calling `canonicalUrl` from `lib/text.ts` because this runs once per
 * row per library version and the shared helper builds a `URL` object — which is roughly
 * twenty times the cost of the string work actually needed here.
 */
function canonicalKey(url: string): string {
  let value = url.toLowerCase();
  const hash = value.indexOf("#");
  if (hash !== -1) value = value.slice(0, hash);
  value = value.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

/* ---------------------------------------------------------------- criteria */

export type Scope =
  | "all"
  | "recent"
  | "review"
  | "favorites"
  | "duplicates"
  | "untagged"
  | "archived"
  | "cleanup"
  | "trash";

export interface SelectionCriteria {
  query: ParsedQuery;
  /** A smart collection's own rule, intersected with the query. */
  rule?: ParsedQuery | null;
  scope: Scope;
  folderId?: string | null;
  tag?: string | null;
  category?: string | null;
  boardId?: string | null;
  importId?: string | null;
  sourceId?: string | null;
  format?: FormatFacet;
  sort: SortMode;
  /** Only rows that look like this one, ranked by resemblance. */
  lookalikeOf?: Bookmark | null;
  lookalikeStrength?: MatchStrength;
  lookalikeColor?: boolean;
}

/**
 * How recent "recently added" means: two days, measured against arrival *here*.
 *
 * A fortnight against `addedAt` meant importing a ten-year-old export produced an empty
 * "Recently added" — the one moment the view is most obviously useful.
 */
const RECENT_WINDOW = 2 * 24 * 60 * 60 * 1000;

export interface SelectionResult {
  /** Matching row positions, in sort order. */
  positions: Int32Array;
  /** Resemblance scores, when a "looks like" view asked for them. */
  scores?: Map<number, number>;
}

/**
 * Applies scope, navigation and every query filter, then orders the survivors.
 *
 * The shape is: build a boolean mask in one linear pass, then walk the cached sort
 * permutation and collect what passed. Two passes over `n` numbers, no allocation per row,
 * and no comparison sort at all unless the sort order is being seen for the first time.
 */
export function select(
  index: LibraryIndex,
  folders: Folder[],
  textIndex: TfIdfIndex,
  criteria: SelectionCriteria,
): SelectionResult {
  const { query, scope, sort } = criteria;
  const filters = query.filters;
  const now = Date.now();

  const duplicates =
    scope === "duplicates" || scope === "cleanup" || filters.duplicates
      ? duplicatePositions(index)
      : null;
  const lookalikes =
    scope === "cleanup" || filters.lookalikes ? lookalikePositions(index) : null;

  /* "Looks like" resolves its own membership and its own ordering. */
  let likeness: Map<number, number> | null = null;
  if (criteria.lookalikeOf) {
    likeness = new Map();
    for (const match of findLookalikes(criteria.lookalikeOf, index.rows, {
      strength: criteria.lookalikeStrength,
      refineColor: criteria.lookalikeColor,
      limit: 500,
    })) {
      const position = index.byId.get(match.id);
      if (position !== undefined) likeness.set(position, match.score);
    }
  }

  /*
   * A smart collection's rule is answered by this same function.
   *
   * Recursion rather than a second filter implementation: the rule is a query, and what
   * answers a query correctly is this. The recursive call passes no rule of its own, so it
   * cannot loop.
   */
  let ruleMembers: Set<number> | null = null;
  if (criteria.rule) {
    ruleMembers = new Set<number>();
    const inner = select(index, folders, textIndex, {
      query: criteria.rule,
      scope: "all",
      sort: "recent",
    });
    for (const position of inner.positions) ruleMembers.add(position);
  }

  const wantedKinds = new Set([...facetToKinds(criteria.format ?? "all"), ...filters.kinds]);
  const wantedKindBits = wantedKinds.size
    ? new Set([...wantedKinds].map((kind) => KIND_ORDER.indexOf(kind)))
    : null;

  const subtree = criteria.folderId ? folderSubtree(folders, criteria.folderId) : null;
  const wantsArchived = scope === "archived" || filters.archived === true;
  const wantedState = scope === "trash" ? STATE_TRASH : wantsArchived ? STATE_ARCHIVE : STATE_LIVE;

  const activeTag = criteria.tag?.toLowerCase() ?? null;
  const activeCategory = criteria.category?.toLowerCase() ?? null;
  const filterTags = filters.tags.map((tag) => tag.toLowerCase());
  const filterCategories = filters.categories.map((entry) => entry.toLowerCase());
  const filterDomains = filters.domains.map((entry) => entry.toLowerCase());
  const filterFolders = filters.folders.map((entry) => entry.toLowerCase());
  const filterHealth = filters.health.length
    ? new Set(filters.health.map((status) => HEALTHS.indexOf(status)))
    : null;
  const filterSources = filters.sourceIds.length ? new Set(filters.sourceIds) : null;

  const mask = new Uint8Array(index.count);
  let matched = 0;

  for (let position = 0; position < index.count; position += 1) {
    if (index.state[position] !== wantedState) continue;

    if (wantedKindBits && !wantedKindBits.has(index.kindOf[position])) continue;
    if (ruleMembers && !ruleMembers.has(position)) continue;
    if (likeness && !likeness.has(position)) continue;

    switch (scope) {
      case "recent":
        if (now - index.arrivedAt[position] > RECENT_WINDOW) continue;
        break;
      case "review":
        if (!(index.flags[position] & FLAG_NEEDS_REVIEW)) continue;
        break;
      case "favorites":
        if (!(index.flags[position] & FLAG_FAVORITE)) continue;
        break;
      case "duplicates":
        if (!duplicates!.has(position)) continue;
        break;
      case "cleanup":
        if (!duplicates!.has(position) && !lookalikes!.has(position)) continue;
        break;
      case "untagged":
        if (!(index.flags[position] & FLAG_UNTAGGED)) continue;
        break;
      default:
        break;
    }

    if (subtree) {
      const folderId = index.folderId[position];
      if (!folderId || !subtree.has(folderId)) continue;
    }
    if (criteria.sourceId && index.sourceId[position] !== criteria.sourceId) continue;
    if (criteria.importId && index.importId[position] !== criteria.importId) continue;
    if (activeCategory && index.category[position] !== activeCategory) continue;
    if (activeTag && !index.tags[position].includes(activeTag)) continue;
    if (criteria.boardId && !index.boardIds[position].includes(criteria.boardId)) continue;

    const flags = index.flags[position];
    if (filters.duplicates && !duplicates!.has(position)) continue;
    if (filters.lookalikes && !lookalikes!.has(position)) continue;
    if (filters.offline && !(flags & FLAG_HAS_OFFLINE)) continue;
    if (filters.media && !(flags & FLAG_HAS_MEDIA)) continue;
    if (filters.favorite && !(flags & FLAG_FAVORITE)) continue;
    if (filters.untagged && !(flags & FLAG_UNTAGGED)) continue;
    if (filters.neverVisited && !(flags & FLAG_NEVER_VISITED)) continue;
    if (filterHealth && !filterHealth.has(index.health[position])) continue;
    if (filterSources && !filterSources.has(index.sourceId[position] ?? "")) continue;
    if (filters.addedAfter !== undefined && index.addedAt[position] < filters.addedAfter) continue;
    if (filters.addedBefore !== undefined && index.addedAt[position] > filters.addedBefore) continue;

    if (filterTags.length) {
      const rowTags = index.tags[position];
      let ok = true;
      for (const tag of filterTags) {
        if (!rowTags.includes(tag)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    if (filterCategories.length && !filterCategories.includes(index.category[position])) continue;
    if (filterDomains.length) {
      const domain = index.domain[position];
      if (!filterDomains.some((candidate) => domain.endsWith(candidate))) continue;
    }
    if (filterFolders.length) {
      const path = index.folderPath[position];
      if (!filterFolders.some((candidate) => path.includes(candidate))) continue;
    }
    /*
     * A colour query keeps anything carrying a meaningful share of that hue.
     *
     * The threshold is low on purpose: an image is rarely *mostly* one colour, and a
     * strict cut returns only flat graphics while excluding every photograph somebody
     * would describe with that word. Left on the row rather than precomputed because a
     * colour query is rare and the histogram is twelve floats per row.
     */
    if (filters.colors.length) {
      const row = index.rows[position];
      let best = 0;
      for (const bin of filters.colors) best = Math.max(best, colorScore(row, bin));
      if (best < 0.08) continue;
    }

    mask[position] = 1;
    matched += 1;
  }

  /* ------------------------------------------------------ ordering the mask */

  if (likeness) {
    const positions = collect(mask, matched);
    positions.sort((a, b) => (likeness!.get(b) ?? 0) - (likeness!.get(a) ?? 0));
    return { positions, scores: likeness };
  }

  if (filters.colors.length && !query.terms.length && !query.text) {
    const positions = collect(mask, matched);
    const scoreOf = (position: number) => {
      let best = 0;
      for (const bin of filters.colors) best = Math.max(best, colorScore(index.rows[position], bin));
      return best;
    };
    const scores = new Map<number, number>();
    for (const position of positions) scores.set(position, scoreOf(position));
    positions.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
    return { positions, scores };
  }

  if (query.terms.length || query.text) {
    return rankByText(index, textIndex, query, mask, matched, sort);
  }

  /*
   * The ordinary path: walk the cached permutation, keep what passed.
   *
   * This is the whole point of the design. There is no sort here — the order was computed
   * once when this sort mode was first asked for, and every subsequent filter reuses it.
   */
  const order = orderFor(index, sort);
  const positions = new Int32Array(matched);
  let cursor = 0;
  for (let step = 0; step < order.length && cursor < matched; step += 1) {
    const position = order[step];
    if (mask[position]) positions[cursor++] = position;
  }
  return { positions };
}

function collect(mask: Uint8Array, matched: number): Int32Array {
  const positions = new Int32Array(matched);
  let cursor = 0;
  for (let position = 0; position < mask.length && cursor < matched; position += 1) {
    if (mask[position]) positions[cursor++] = position;
  }
  return positions;
}

/**
 * Free-text ranking, applied over the already-filtered mask.
 *
 * TF-IDF supplies the scores and a substring pass supplies the rest: an exact fragment
 * ("shadcn", part of a URL) is not an indexed term and would otherwise miss entirely. The
 * band at the end is what keeps a three-word query from dragging in every document that
 * happened to share its weakest word.
 */
function rankByText(
  index: LibraryIndex,
  textIndex: TfIdfIndex,
  query: ParsedQuery,
  mask: Uint8Array,
  matched: number,
  sort: SortMode,
): SelectionResult {
  const ranked = new Map<string, number>();
  for (const hit of textIndex.search(query.terms, index.count)) ranked.set(hit.id, hit.score);

  const needle = query.text.toLowerCase();
  const scored: { position: number; score: number }[] = [];

  for (let position = 0; position < index.count; position += 1) {
    if (!mask[position]) continue;
    const row = index.rows[position];
    let score = ranked.get(row.id) ?? 0;
    if (needle) {
      if (
        index.title[position].includes(needle) ||
        row.url.toLowerCase().includes(needle) ||
        index.domain[position].includes(needle) ||
        (row.description && row.description.toLowerCase().includes(needle)) ||
        (row.text && row.text.toLowerCase().includes(needle))
      ) {
        score += 0.35;
      }
      if (index.title[position].startsWith(needle)) score += 0.25;
    }
    if (score > 0) scored.push({ position, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  const floor = best * 0.22;
  const kept = scored.filter((entry) => entry.score >= floor);

  if (sort === "relevance" || sort === "recent" || sort === "custom") {
    // Relevance is the only order that makes sense for a query, and it is what people
    // expect from a search box regardless of what the sort control was left on. The
    // explicit sorts below are honoured because choosing one is a deliberate act.
    if (sort === "relevance" || !query.terms.length) {
      return { positions: Int32Array.from(kept, (entry) => entry.position) };
    }
  }

  const keptSet = new Uint8Array(index.count);
  for (const entry of kept) keptSet[entry.position] = 1;
  const order = orderFor(index, sort);
  const positions = new Int32Array(kept.length);
  let cursor = 0;
  for (let step = 0; step < order.length && cursor < kept.length; step += 1) {
    const position = order[step];
    if (keptSet[position]) positions[cursor++] = position;
  }
  void matched;
  return { positions };
}

/* -------------------------------------------------------------- lookalikes */

/**
 * Row positions whose picture matches another row's.
 *
 * Deferred to `lib/visual.ts`, which owns the clustering and memoises it. Translated to
 * positions here so the hot loop compares numbers rather than looking up strings.
 */
function lookalikePositions(index: LibraryIndex): Set<number> {
  if (index.lookalikes) return index.lookalikes;
  const positions = new Set<number>();
  for (const group of groupLookalikes(index.rows)) {
    for (const member of [group.keep, ...group.rest]) {
      const position = index.byId.get(member.id);
      if (position !== undefined) positions.add(position);
    }
  }
  index.lookalikes = positions;
  return positions;
}

/* ------------------------------------------------------------------ facets */

export interface FacetCounts {
  total: number;
  live: number;
  archived: number;
  trashed: number;
  favorites: number;
  untagged: number;
  needsReview: number;
  unchecked: number;
  recent: number;
  duplicates: number;
  withPicture: number;
  tags: Map<string, number>;
  domains: Map<string, number>;
  categories: Map<string, number>;
  folders: Map<string, number>;
  sources: Map<string, number>;
  imports: Map<string, number>;
  boards: Map<string, number>;
  formats: Record<FormatFacet, number>;
}

/**
 * Every count the sidebar and the filter bar show, in one pass.
 *
 * One pass rather than fourteen: each rail used to `filter().length` the whole library for
 * its own badge, so opening the app counted fifty thousand rows fourteen times. They are
 * all derived from the same scan here and handed out as maps.
 */
export function countFacets(index: LibraryIndex): FacetCounts {
  const counts: FacetCounts = {
    total: 0,
    live: 0,
    archived: 0,
    trashed: 0,
    favorites: 0,
    untagged: 0,
    needsReview: 0,
    unchecked: 0,
    recent: 0,
    duplicates: duplicatePositions(index).size,
    withPicture: 0,
    tags: new Map(),
    domains: new Map(),
    categories: new Map(),
    folders: new Map(),
    sources: new Map(),
    imports: new Map(),
    boards: new Map(),
    formats: { all: 0, links: 0, images: 0, videos: 0, notes: 0 },
  };

  const now = Date.now();
  const bump = (map: Map<string, number>, key: string | null | undefined) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  for (let position = 0; position < index.count; position += 1) {
    const state = index.state[position];
    counts.total += 1;
    if (state === STATE_TRASH) {
      counts.trashed += 1;
      continue;
    }
    if (state === STATE_ARCHIVE) {
      counts.archived += 1;
      continue;
    }

    counts.live += 1;
    const flags = index.flags[position];
    if (flags & FLAG_FAVORITE) counts.favorites += 1;
    if (flags & FLAG_UNTAGGED) counts.untagged += 1;
    if (flags & FLAG_NEEDS_REVIEW) counts.needsReview += 1;
    if (flags & FLAG_UNCHECKED) counts.unchecked += 1;
    if (flags & FLAG_HAS_PICTURE) counts.withPicture += 1;
    if (now - index.arrivedAt[position] <= RECENT_WINDOW) counts.recent += 1;

    counts.formats.all += 1;
    const format = FORMATS[index.format[position]];
    if (format) counts.formats[format] += 1;

    for (const tag of index.tags[position]) bump(counts.tags, tag);
    bump(counts.domains, index.domain[position]);
    bump(counts.categories, index.rows[position].category);
    bump(counts.folders, index.folderId[position]);
    bump(counts.sources, index.sourceId[position]);
    bump(counts.imports, index.importId[position]);
    for (const boardId of index.boardIds[position]) bump(counts.boards, boardId);
  }

  return counts;
}

/** Materialises a window of results. The only place row objects are touched for render. */
export function slice(index: LibraryIndex, positions: Int32Array, from: number, to: number): Bookmark[] {
  const start = Math.max(0, from);
  const end = Math.min(positions.length, to);
  const rows: Bookmark[] = new Array(Math.max(0, end - start));
  for (let cursor = start; cursor < end; cursor += 1) rows[cursor - start] = index.rows[positions[cursor]];
  return rows;
}

/** All of them, for the paths that genuinely need every row (export, bulk actions). */
export function materialise(index: LibraryIndex, positions: Int32Array): Bookmark[] {
  const rows: Bookmark[] = new Array(positions.length);
  for (let cursor = 0; cursor < positions.length; cursor += 1) rows[cursor] = index.rows[positions[cursor]];
  return rows;
}
