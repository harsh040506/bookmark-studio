/**
 * Collections that populate themselves.
 *
 * ## Why this is a stored query and not a second filter model
 *
 * The temptation is to build a rule editor — field, operator, value, compiled to a
 * predicate — and that is the wrong shape twice over.
 *
 * First, this app already has a query language people use every day, with operators,
 * plain-English dates, colours, formats and typo correction. A second, weaker language
 * with its own semantics would mean two things called "filtering" that disagree, and every
 * feature added to one would have to be added to the other or quietly not work here.
 *
 * Second, a rule builder can only express what its authors anticipated. `parseQuery`
 * already understands `tag:design is:dead site:figma.com last month`, and a smart
 * collection that stores that string gets all of it for nothing — including everything the
 * query language learns later.
 *
 * So a smart collection is a *name and a query*. Making one is "save this search", which
 * is also the moment people actually want one: they have just typed something useful.
 *
 * ## What it costs, and why that is bounded
 *
 * Counting a collection means running the whole selection pass for it, and the sidebar
 * shows a count per row. Done naively that is one full library pass per collection on
 * every render. Counts are therefore memoised against the {@link LibraryIndex}, whose
 * identity *is* the version of the library — so the cache needs no invalidation and cannot
 * go stale.
 */
import type { Bookmark, Folder, SmartCollection } from "../../shared/types";
import { select, type LibraryIndex } from "./engine";
import { parseQuery } from "./query";
import type { TfIdfIndex } from "./tfidf";

/** A colour per collection, so the rail can tell them apart at a glance. */
export const SMART_COLORS = ["#2a78d6", "#7c5cd6", "#2f8f5b", "#b8791f", "#d03b3b", "#2e8f82"];

let sequence = 0;

export function createSmartCollection(
  name: string,
  query: string,
  color?: string,
): SmartCollection {
  sequence += 1;
  return {
    id: `smt_${Date.now().toString(36)}_${sequence.toString(36)}`,
    name: name.trim() || "Untitled collection",
    query: query.trim(),
    color: color ?? SMART_COLORS[sequence % SMART_COLORS.length],
    createdAt: Date.now(),
  };
}

export interface SmartInput {
  index: LibraryIndex;
  folders: Folder[];
  textIndex: TfIdfIndex;
}

/**
 * The row positions one smart collection currently holds.
 *
 * Routed through the selection engine rather than through a bespoke filter so a smart
 * collection and the search box that defined it can never disagree — the single property
 * that makes "save this search" an honest description of what the button does.
 *
 * The scope is always `all`: a saved query describes the whole library, and inheriting
 * whatever scope happened to be active when it was saved would make a collection whose
 * contents depend on where the user was standing at the time.
 */
export function smartPositions(collection: SmartCollection, input: SmartInput): Int32Array {
  return select(input.index, input.folders, input.textIndex, {
    query: parseQuery(collection.query),
    scope: "all",
    sort: "recent",
  }).positions;
}

export function smartMembers(collection: SmartCollection, input: SmartInput): Bookmark[] {
  const positions = smartPositions(collection, input);
  const rows: Bookmark[] = new Array(positions.length);
  for (let cursor = 0; cursor < positions.length; cursor += 1) {
    rows[cursor] = input.index.rows[positions[cursor]];
  }
  return rows;
}

/**
 * Counts for every collection, computed once per library version.
 *
 * The inner key is the collection id plus its query, so editing a rule recounts that rule
 * without recounting the others — keying on id alone would show the old count against the
 * new rule until something unrelated invalidated the whole library.
 */
const countCache = new WeakMap<LibraryIndex, Map<string, number>>();

export function smartCounts(
  collections: SmartCollection[],
  input: SmartInput,
): Map<string, number> {
  let cache = countCache.get(input.index);
  if (!cache) {
    cache = new Map();
    countCache.set(input.index, cache);
  }

  const counts = new Map<string, number>();
  for (const collection of collections) {
    const key = `${collection.id}:${collection.query}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      counts.set(collection.id, cached);
      continue;
    }
    const total = smartPositions(collection, input).length;
    cache.set(key, total);
    counts.set(collection.id, total);
  }
  return counts;
}

/**
 * A name proposed for a query, when the user has not typed one.
 *
 * Built from what the parser *understood* rather than from the raw string, so
 * `tag:design is:dead` is offered as "Design · dead" instead of as itself. A query that
 * resolved to nothing recognisable falls back to its own text, which is at least
 * something the person wrote.
 */
export function suggestName(query: string): string {
  const parsed = parseQuery(query);
  const parts = parsed.chips
    .map((chip) => chip.label.replace(/^[a-z]+:\s*/i, ""))
    .filter(Boolean);
  if (!parts.length) return query.trim() || "Saved search";
  const name = parts.slice(0, 3).join(" · ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}
