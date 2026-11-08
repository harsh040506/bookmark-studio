/**
 * Smart collections, and the promise that makes them worth having.
 *
 * ## The property under test
 *
 * A smart collection is a *saved search*, and the entire design rests on that being
 * literally true — the same string, run through the same pipeline, producing the same rows.
 * The moment a rule and the search box that created it can disagree, "save this search"
 * becomes a lie and every collection in the rail is suspect.
 *
 * So these tests assert equivalence with the selection engine rather than asserting particular
 * results: the point is not that `tag:design` finds two things, it is that it finds exactly
 * what typing `tag:design` finds.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark } from "../../../shared/types";
import { buildIndex } from "../library";
import { buildLibraryIndex, select } from "../engine";
import { parseQuery } from "../query";
import { smartCounts, smartMembers, suggestName } from "../smart";

function row(overrides: Partial<Bookmark> & { id: string }): Bookmark {
  return {
    url: `https://example.com/${overrides.id}`,
    title: overrides.id,
    domain: "example.com",
    description: "",
    category: "Unsorted",
    tags: [],
    folderId: null,
    boardIds: [],
    addedAt: Date.UTC(2026, 0, 1),
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
    ...overrides,
  };
}

const library: Bookmark[] = [
  row({ id: "a", title: "Figma design system", tags: ["design", "figma"] }),
  row({ id: "b", title: "Rust book", tags: ["rust"] }),
  row({ id: "c", title: "Design tokens", tags: ["design"], health: { status: "dead" } }),
  row({ id: "d", title: "Trashed design", tags: ["design"], trashedAt: Date.now() }),
];

const context = () => ({
  index: buildLibraryIndex(library, new Map()),
  folders: [],
  textIndex: buildIndex(library, new Map()),
});

/** The same query, asked of the search pipeline directly. */
function viaSearch(query: string): string[] {
  const input = context();
  const { positions } = select(input.index, input.folders, input.textIndex, {
    query: parseQuery(query),
    scope: "all",
    sort: "recent",
  });
  return Array.from(positions, (position) => input.index.rows[position].id);
}

describe("a smart collection is a saved search", () => {
  it("holds exactly what the same query finds", () => {
    for (const query of ["tag:design", "is:dead", "tag:design is:dead", "rust"]) {
      const members = smartMembers(
        { id: "s", name: "s", query, createdAt: 0 },
        context(),
      ).map((entry) => entry.id);
      expect(members).toEqual(viaSearch(query));
    }
  });

  it("never includes trashed rows", () => {
    // `d` carries the tag and is in the trash. A collection that surfaced it would be
    // showing something the user believes they deleted, from a rail row that never
    // mentions the trash.
    const members = smartMembers(
      { id: "s", name: "s", query: "tag:design", createdAt: 0 },
      context(),
    ).map((entry) => entry.id);
    expect(members).not.toContain("d");
    expect(members).toContain("a");
    expect(members).toContain("c");
  });

  it("counts every collection in one pass and reuses the answer", () => {
    const collections = [
      { id: "one", name: "Design", query: "tag:design", createdAt: 0 },
      { id: "two", name: "Broken", query: "is:dead", createdAt: 0 },
    ];
    const input = context();
    const first = smartCounts(collections, input);
    expect(first.get("one")).toBe(2);
    expect(first.get("two")).toBe(1);

    // Same array identity, so the cache must answer without recomputing. Asserting the
    // values match is the observable half; the point is that it does not diverge.
    const second = smartCounts(collections, input);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("recounts when a rule is edited, without touching its neighbours", () => {
    const input = context();
    const before = smartCounts([{ id: "one", name: "x", query: "tag:design", createdAt: 0 }], input);
    expect(before.get("one")).toBe(2);

    // Same id, different rule. Keying the cache on the id alone would return the stale 2.
    const after = smartCounts([{ id: "one", name: "x", query: "tag:rust", createdAt: 0 }], input);
    expect(after.get("one")).toBe(1);
  });
});

describe("naming a rule", () => {
  it("describes what was understood rather than echoing the operator", () => {
    // The `tag:` prefix is stripped: the name is what the rule *means*, not how it was
    // typed. Capitalised, because it is a name — this is the label on a rail row, not an
    // echo of the query.
    expect(suggestName("tag:design")).toBe("Design");
    expect(suggestName("is:dead")).toBe("Dead");
  });

  it("combines several understood parts", () => {
    const name = suggestName("tag:design is:dead");
    expect(name.toLowerCase()).toContain("design");
    expect(name.toLowerCase()).toContain("dead");
  });

  it("falls back to the query's own words when nothing structural was parsed", () => {
    expect(suggestName("some free text").toLowerCase()).toContain("free text");
  });

  it("never returns an empty name", () => {
    // An unnamed row in the rail is unclickable in practice, so this has to hold even for
    // the degenerate input the dialog will not normally allow through.
    expect(suggestName("").length).toBeGreaterThan(0);
    expect(suggestName("   ").length).toBeGreaterThan(0);
  });
});
