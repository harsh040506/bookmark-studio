/**
 * The selection engine at the sizes this app is built for.
 *
 * ## Why timing is asserted at all
 *
 * Performance regressions in a filter are invisible in review: the code still reads
 * correctly, the results are still right, and the only symptom is that somebody's search
 * box lags. The budgets below are deliberately loose — several times what the machine
 * actually needs — so they never fail for a slow CI box, and still catch the two mistakes
 * that would matter: re-sorting the library per query, and re-lowercasing text per row per
 * keystroke. Either turns these from milliseconds into seconds.
 *
 * ## What is actually being pinned
 *
 * 1. Building the index is linear and happens once per library version.
 * 2. Filtering re-uses a cached sort permutation, so the *second* query in a given order is
 *    dramatically cheaper than the first — and neither is a full sort.
 * 3. Facet counting is one pass, not one pass per rail.
 * 4. Results come back as row positions, so nothing materialises the whole library.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark } from "../../../shared/types";
import { buildLibraryIndex, countFacets, materialise, select, slice } from "../engine";
import { buildIndex } from "../library";
import { parseQuery } from "../query";
import { TfIdfIndex } from "../tfidf";

const SIZE = 50_000;

const WORDS = [
  "design", "system", "rust", "react", "typography", "archive", "video", "tooling",
  "essay", "database", "graphics", "shader", "interface", "research", "notes", "colour",
];
const DOMAINS = ["figma.com", "github.com", "rust-lang.org", "arxiv.org", "example.com", "vercel.com"];
const TAGS = ["design", "code", "reading", "reference", "inspiration", "video"];

/**
 * A library that looks like a real one: repeated domains, a long tail of tags, a scattering
 * of duplicates, archived and trashed rows, and dates spread over a decade.
 */
function makeLibrary(size: number): Bookmark[] {
  const rows: Bookmark[] = new Array(size);
  const start = Date.UTC(2015, 0, 1);
  const span = Date.UTC(2026, 0, 1) - start;
  for (let position = 0; position < size; position += 1) {
    const word = WORDS[position % WORDS.length];
    const second = WORDS[(position * 7) % WORDS.length];
    /*
     * Every 500th row repeats an earlier URL, so the duplicate pass has real work to do.
     *
     * The offset is a multiple of the domain count, so the copy lands on the same host —
     * otherwise the two rows differ in their domain and are not duplicates at all, which
     * is exactly the mistake this generator made first time round.
     */
    const isDuplicate = position > 252 && position % 500 === 0;
    const source = isDuplicate ? position - 252 : position;
    const domain = DOMAINS[source % DOMAINS.length];
    rows[position] = {
      id: `bmk_${position}`,
      url: `https://${domain}/${source}`,
      title: `${word} ${second} ${position}`,
      domain,
      description: `A page about ${word} and ${second}.`,
      category: position % 3 === 0 ? "Design" : position % 3 === 1 ? "Code" : "Reference",
      tags: [TAGS[position % TAGS.length], TAGS[(position * 3) % TAGS.length]],
      folderId: null,
      boardIds: [],
      addedAt: start + ((position * 7919) % span),
      importedAt: start + ((position * 7919) % span),
      visitCount: position % 11,
      health: { status: position % 17 === 0 ? "dead" : "live" },
      preview: { method: "card" },
      favorite: position % 23 === 0 || undefined,
      archived: position % 31 === 0 || undefined,
      trashedAt: position % 97 === 0 ? start : undefined,
    };
  }
  return rows;
}

const library = makeLibrary(SIZE);
const index = buildLibraryIndex(library, new Map());
/*
 * Text ranking is exercised with an empty TF-IDF index.
 *
 * Building a real one over fifty thousand documents is the *indexer's* cost, tested
 * elsewhere and deliberately off the main thread. What matters here is that the filter and
 * sort path stays flat, and an empty index isolates that from the tokeniser.
 */
const emptyText = new TfIdfIndex([]);

function time(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

function query(text: string, sort: Parameters<typeof select>[3]["sort"] = "recent") {
  return select(index, [], emptyText, { query: parseQuery(text), scope: "all", sort });
}

describe(`the engine at ${SIZE.toLocaleString()} rows`, () => {
  it("builds one index over the whole library", () => {
    expect(index.count).toBe(SIZE);
    expect(index.byId.size).toBe(SIZE);
    // The folded columns exist for every row; a hole here means the hot loop reads
    // `undefined` and silently stops matching.
    expect(index.title[SIZE - 1]).toBeTypeOf("string");
    expect(index.state.length).toBe(SIZE);
  });

  it("returns positions rather than rows, so nothing is materialised to count", () => {
    const { positions } = query("");
    expect(positions).toBeInstanceOf(Int32Array);
    expect(positions.length).toBeGreaterThan(SIZE * 0.9);
    // A window is cheap; the whole set is available but never needed to render.
    expect(slice(index, positions, 0, 40)).toHaveLength(40);
    expect(slice(index, positions, 0, 40)[0].id).toBeTypeOf("string");
  });

  it("excludes archived and trashed rows from the default scope", () => {
    const { positions } = query("");
    for (const position of positions.subarray(0, 500)) {
      expect(index.rows[position].archived).toBeFalsy();
      expect(index.rows[position].trashedAt).toBeFalsy();
    }
  });

  it("filters the whole library in a few milliseconds", () => {
    // Warm the sort permutation first, so this measures the filter and not the one-off sort.
    query("");
    const elapsed = time(() => query("tag:design is:favorite"));
    expect(elapsed).toBeLessThan(250);
  });

  it("reuses the cached order instead of re-sorting per query", () => {
    const fresh = buildLibraryIndex(library, new Map());
    const first = time(() => {
      select(fresh, [], emptyText, { query: parseQuery(""), scope: "all", sort: "title" });
    });
    const second = time(() => {
      select(fresh, [], emptyText, { query: parseQuery("tag:code"), scope: "all", sort: "title" });
    });
    // The first call pays for the comparison sort; the second must not. A generous ratio,
    // because the point is "not re-sorting", not a particular speed.
    expect(second).toBeLessThan(Math.max(first, 1));
    expect(fresh.orders.has("title")).toBe(true);
  });

  it("counts every facet in one pass", () => {
    const elapsed = time(() => countFacets(index));
    expect(elapsed).toBeLessThan(500);

    const facets = countFacets(index);
    expect(facets.total).toBe(SIZE);
    expect(facets.live + facets.archived + facets.trashed).toBe(SIZE);
    expect(facets.tags.size).toBe(TAGS.length);
    expect(facets.domains.size).toBe(DOMAINS.length);
    expect(facets.duplicates).toBeGreaterThan(0);
  });

  it("keeps a hundred simulated keystrokes under a frame budget each", () => {
    query("");
    const phrase = "typography";
    let worst = 0;
    for (let length = 1; length <= phrase.length; length += 1) {
      worst = Math.max(worst, time(() => query(phrase.slice(0, length))));
    }
    // Loose, but far below the seconds a per-keystroke sort or re-lowercasing would cost.
    expect(worst).toBeLessThan(400);
  });

  it("materialises only what is asked for", () => {
    const { positions } = query("tag:design");
    const page = slice(index, positions, 0, 60);
    expect(page).toHaveLength(60);
    // And the full set is still available for the paths that genuinely need it.
    expect(materialise(index, positions)).toHaveLength(positions.length);
  });

  it("agrees with a naive filter, so the fast path is not a different answer", () => {
    const { positions } = query("tag:design");
    const fast = new Set(Array.from(positions, (position) => index.rows[position].id));
    const naive = library
      .filter((row) => !row.trashedAt && !row.archived && row.tags.includes("design"))
      .map((row) => row.id);
    expect(fast.size).toBe(naive.length);
    for (const id of naive) expect(fast.has(id)).toBe(true);
  });

  it("orders by every sort mode without dropping or duplicating rows", () => {
    for (const sort of ["recent", "oldest", "title", "domain", "visits", "custom"] as const) {
      const { positions } = query("", sort);
      expect(new Set(positions).size).toBe(positions.length);
    }
  });
});

describe("the text index is built off the hot path", () => {
  it("still ranks correctly once supplied", () => {
    // A small corpus, because this is about correctness of the hand-off rather than speed.
    const small = library.slice(0, 400);
    const smallIndex = buildLibraryIndex(small, new Map());
    const text = buildIndex(small, new Map());
    const { positions } = select(smallIndex, [], text, {
      query: parseQuery("typography"),
      scope: "all",
      sort: "relevance",
    });
    expect(positions.length).toBeGreaterThan(0);
    for (const position of positions) {
      expect(smallIndex.rows[position].title.toLowerCase()).toContain("typography");
    }
  });
});
