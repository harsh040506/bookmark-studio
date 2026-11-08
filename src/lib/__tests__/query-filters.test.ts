/**
 * Query filters added alongside the review workflows.
 *
 * The parser is the app's most user-facing piece of logic — whatever it fails to
 * understand simply does not exist as a capability — so each supported phrasing is
 * pinned to a test rather than left to be rediscovered by accident.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark } from "../../../shared/types";
import { hasActiveFilters, parseQuery } from "../query";
import { buildFolderPaths, buildIndex } from "../library";
import { buildLibraryIndex, select as engineSelect } from "../engine";

function bookmark(overrides: Partial<Bookmark> & { id: string }): Bookmark {
  return {
    url: `https://example.com/${overrides.id}`,
    title: "Untitled",
    domain: "example.com",
    description: "",
    category: "Reference",
    tags: [],
    folderId: null,
    boardIds: [],
    addedAt: Date.now(),
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
    ...overrides,
  };
}

function select(bookmarks: Bookmark[], search: string): Bookmark[] {
  const folderPaths = buildFolderPaths([]);
  const index = buildLibraryIndex(bookmarks, folderPaths);
  const { positions } = engineSelect(index, [], buildIndex(bookmarks, folderPaths), {
    query: parseQuery(search),
    scope: "all",
    sort: "recent",
  });
  return Array.from(positions, (position) => index.rows[position]);
}

describe("never-opened filter", () => {
  it("understands the is: operator and its synonyms", () => {
    for (const phrase of ["is:unopened", "is:unread", "is:unvisited"]) {
      expect(parseQuery(phrase).filters.neverVisited).toBe(true);
    }
  });

  it("understands the plain-English phrasing", () => {
    expect(parseQuery("never opened").filters.neverVisited).toBe(true);
    expect(parseQuery("never visited").filters.neverVisited).toBe(true);
  });

  it("is not set by an ordinary query", () => {
    expect(parseQuery("react documentation").filters.neverVisited).toBeUndefined();
  });

  it("shows a chip so the behaviour is visible rather than implicit", () => {
    const chips = parseQuery("never opened").chips.map((chip) => chip.label);
    expect(chips).toContain("never opened");
  });

  it("counts towards hasActiveFilters", () => {
    expect(hasActiveFilters(parseQuery("never opened").filters)).toBe(true);
  });

  it("keeps only bookmarks with no recorded visits", () => {
    const results = select(
      [
        bookmark({ id: "fresh", visitCount: 0 }),
        bookmark({ id: "used", visitCount: 4 }),
      ],
      "never opened",
    );
    expect(results.map((entry) => entry.id)).toEqual(["fresh"]);
  });

  it("combines with a relative date, which is how the dashboard uses it", () => {
    const now = Date.now();
    const year = 365 * 24 * 60 * 60 * 1000;
    const results = select(
      [
        bookmark({ id: "old-unread", visitCount: 0, addedAt: now - 2 * year }),
        bookmark({ id: "old-read", visitCount: 3, addedAt: now - 2 * year }),
        bookmark({ id: "new-unread", visitCount: 0, addedAt: now }),
      ],
      "never opened older than 12 months",
    );
    expect(results.map((entry) => entry.id)).toEqual(["old-unread"]);
  });
});
