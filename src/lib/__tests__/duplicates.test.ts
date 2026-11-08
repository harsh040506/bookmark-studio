/**
 * Duplicate resolution.
 *
 * The merge is destructive by design — it deletes bookmarks — so what it keeps has to be
 * pinned down precisely. These tests encode the two promises made in the UI copy: exactly
 * one survivor per link, and nothing the user put on a copy by hand is lost with it.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark } from "../../../shared/types";
import { planDuplicateCleanup } from "../library";
import { buildLibraryIndex, countFacets } from "../engine";
import { canonicalUrl } from "../text";

function bookmark(overrides: Partial<Bookmark> & { id: string; url: string }): Bookmark {
  return {
    title: "Untitled",
    domain: "example.com",
    description: "",
    category: "Reference",
    tags: [],
    folderId: null,
    boardIds: [],
    addedAt: 1_700_000_000_000,
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
    ...overrides,
  };
}

describe("planDuplicateCleanup", () => {
  it("leaves a library with no duplicates completely alone", () => {
    const plan = planDuplicateCleanup([
      bookmark({ id: "a", url: "https://one.com/" }),
      bookmark({ id: "b", url: "https://two.com/" }),
    ]);
    expect(plan.remove).toEqual([]);
    expect(plan.groups).toBe(0);
  });

  it("treats tracking parameters and trailing slashes as the same link", () => {
    const plan = planDuplicateCleanup([
      bookmark({ id: "a", url: "https://example.com/post/" }),
      bookmark({ id: "b", url: "https://www.example.com/post?utm_source=twitter" }),
    ]);
    expect(plan.groups).toBe(1);
    expect(plan.remove).toHaveLength(1);
    expect(plan.keep).toHaveLength(1);
  });

  it("elects the favourite as survivor over an older plain copy", () => {
    const plan = planDuplicateCleanup([
      bookmark({ id: "old", url: "https://x.com/", addedAt: 1 }),
      bookmark({ id: "starred", url: "https://x.com/", addedAt: 999, favorite: true }),
    ]);
    expect(plan.keep[0].id).toBe("starred");
    expect(plan.remove).toEqual(["old"]);
  });

  it("prefers a hand-edited copy over one that was merely enriched", () => {
    const plan = planDuplicateCleanup([
      bookmark({ id: "scraped", url: "https://x.com/", enriched: true }),
      bookmark({ id: "edited", url: "https://x.com/", editedAt: 5 }),
    ]);
    expect(plan.keep[0].id).toBe("edited");
  });

  it("falls back to the oldest save, which holds the truest added date", () => {
    const plan = planDuplicateCleanup([
      bookmark({ id: "newer", url: "https://x.com/", addedAt: 200 }),
      bookmark({ id: "older", url: "https://x.com/", addedAt: 100 }),
    ]);
    expect(plan.keep[0].id).toBe("older");
  });

  it("unions tags and boards from every copy onto the survivor", () => {
    const plan = planDuplicateCleanup([
      bookmark({ id: "a", url: "https://x.com/", favorite: true, tags: ["react"], boardIds: ["b1"] }),
      bookmark({ id: "b", url: "https://x.com/", tags: ["docs", "react"], boardIds: ["b2"] }),
    ]);
    expect(plan.keep[0].tags.sort()).toEqual(["docs", "react"]);
    expect(plan.keep[0].boardIds.sort()).toEqual(["b1", "b2"]);
  });

  it("rescues a note, folder and description that only a losing copy had", () => {
    const plan = planDuplicateCleanup([
      bookmark({ id: "winner", url: "https://x.com/", favorite: true }),
      bookmark({
        id: "loser",
        url: "https://x.com/",
        note: "read this",
        folderId: "f1",
        description: "The real description",
      }),
    ]);
    expect(plan.keep[0].id).toBe("winner");
    expect(plan.keep[0].note).toBe("read this");
    expect(plan.keep[0].folderId).toBe("f1");
    expect(plan.keep[0].description).toBe("The real description");
  });

  it("sums visit counts and keeps the earliest added date", () => {
    const plan = planDuplicateCleanup([
      bookmark({ id: "a", url: "https://x.com/", visitCount: 3, addedAt: 500, favorite: true }),
      bookmark({ id: "b", url: "https://x.com/", visitCount: 4, addedAt: 100 }),
    ]);
    expect(plan.keep[0].visitCount).toBe(7);
    expect(plan.keep[0].addedAt).toBe(100);
  });

  it("keeps the merged record visible unless every copy was archived", () => {
    const partly = planDuplicateCleanup([
      bookmark({ id: "a", url: "https://x.com/", archived: true }),
      bookmark({ id: "b", url: "https://x.com/" }),
    ]);
    expect(partly.keep[0].archived).toBeUndefined();

    const fully = planDuplicateCleanup([
      bookmark({ id: "a", url: "https://x.com/", archived: true }),
      bookmark({ id: "b", url: "https://x.com/", archived: true }),
    ]);
    expect(fully.keep[0].archived).toBe(true);
  });

  it("collapses a group of three to exactly one survivor", () => {
    const plan = planDuplicateCleanup([
      bookmark({ id: "a", url: "https://x.com/" }),
      bookmark({ id: "b", url: "https://x.com/?utm_medium=email" }),
      bookmark({ id: "c", url: "https://www.x.com" }),
    ]);
    expect(plan.keep).toHaveLength(1);
    expect(plan.remove).toHaveLength(2);
  });
});

describe("facet counting", () => {
  /** Counts come from one pass over the index, so nothing is tallied twice or missed. */
  const tally = (rows: Bookmark[]) => countFacets(buildLibraryIndex(rows, new Map()));

  it("counts every live bookmark, whatever its category", () => {
    const facets = tally([
      bookmark({ id: "a", url: "https://a.com/", category: "" }),
      bookmark({ id: "b", url: "https://b.com/", category: "" }),
      bookmark({ id: "c", url: "https://c.com/", category: "" }),
    ]);
    expect(facets.live).toBe(3);
  });

  it("tallies named categories correctly", () => {
    const facets = tally([
      bookmark({ id: "a", url: "https://a.com/", category: "Design" }),
      bookmark({ id: "b", url: "https://b.com/", category: "Design" }),
      bookmark({ id: "c", url: "https://c.com/", category: "Code" }),
    ]);
    expect(facets.categories.get("Design")).toBe(2);
    expect(facets.categories.get("Code")).toBe(1);
  });

  it("keeps trashed and archived rows out of the live count", () => {
    const facets = tally([
      bookmark({ id: "a", url: "https://a.com/" }),
      bookmark({ id: "b", url: "https://b.com/", archived: true }),
      bookmark({ id: "c", url: "https://c.com/", trashedAt: Date.now() }),
    ]);
    expect(facets.live).toBe(1);
    expect(facets.archived).toBe(1);
    expect(facets.trashed).toBe(1);
  });

  it("reports duplicate rows once the group is bigger than one", () => {
    const facets = tally([
      bookmark({ id: "a", url: "https://x.com/" }),
      bookmark({ id: "b", url: "https://www.x.com" }),
      bookmark({ id: "c", url: "https://other.com/" }),
    ]);
    expect(facets.duplicates).toBe(2);
  });
});

/**
 * Fragments, and why only some of them count.
 *
 * The duplicate merge deletes rows. So a canonical form that is too aggressive does not
 * produce a wrong number on a screen — it produces a bookmark that is gone.
 */
describe("canonicalUrl and fragments", () => {
  it("keeps two routes of a single-page app apart", () => {
    expect(canonicalUrl("https://app.example/#/projects")).not.toBe(
      canonicalUrl("https://app.example/#/settings"),
    );
  });

  it("still treats an anchor on one page as the same page", () => {
    expect(canonicalUrl("https://docs.example/guide#introduction")).toBe(
      canonicalUrl("https://docs.example/guide#appendix"),
    );
  });

  it("treats a bare hash as no hash at all", () => {
    expect(canonicalUrl("https://example.com/page#")).toBe(canonicalUrl("https://example.com/page"));
  });

  it("still collapses tracking parameters around a routed fragment", () => {
    expect(canonicalUrl("https://app.example/?utm_source=x#/projects")).toBe(
      canonicalUrl("https://app.example/#/projects"),
    );
  });

  it("does not merge distinct app routes", () => {
    const rows = [
      bookmark({ id: "a", url: "https://app.example/#/inbox" }),
      bookmark({ id: "b", url: "https://app.example/#/archive" }),
    ];
    expect(planDuplicateCleanup(rows).remove).toEqual([]);
  });
});
