/**
 * "Background work must not undo what happened while it was running."
 *
 * A page read, a screenshot and a link check each take seconds, and each starts from a
 * copy of the bookmark. These are the things a person saw go wrong when finished work
 * was written back whole: the same pages captured over and over, a corrected title
 * reverting, a deleted bookmark coming back.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark } from "../../../shared/types";
import { rebaseRow } from "../rebase";

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: "b1",
    url: "https://example.com/",
    title: "Example",
    domain: "example.com",
    description: "",
    category: "Other",
    tags: [],
    folderId: null,
    boardIds: [],
    addedAt: 1,
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
    ...overrides,
  };
}

describe("two background passes finishing out of order", () => {
  it("keeps a screenshot that landed while the page was being read", () => {
    const start = bookmark();
    // The screenshot finished first and was saved.
    const now = bookmark({ preview: { method: "screenshot", shotAt: 100, shotDevice: "desktop" } });
    // Then the page read finished, built from the copy it started with.
    const read = bookmark({
      enriched: true,
      description: "From the page",
      preview: { method: "snapshot", imageUrl: "https://example.com/og.png", capturedAt: 200 },
    });
    const written = rebaseRow(start, read, now)!;
    expect(written.preview.shotAt).toBe(100); // the screenshot is still recorded…
    expect(written.preview.method).toBe("screenshot"); // …and not downgraded
    expect(written.preview.imageUrl).toBe("https://example.com/og.png"); // the read's own field lands
    expect(written.description).toBe("From the page");
    expect(written.enriched).toBe(true);
  });

  it("keeps a link check that landed while a screenshot was being taken", () => {
    const start = bookmark();
    const now = bookmark({ health: { status: "dead", httpCode: 404, checkedAt: 5 } });
    const shot = bookmark({ preview: { method: "screenshot", shotAt: 9, shotDevice: "desktop" } });
    const written = rebaseRow(start, shot, now)!;
    expect(written.health.status).toBe("dead");
    expect(written.preview.shotAt).toBe(9);
  });
});

describe("you edit a bookmark while it is being read", () => {
  it("keeps the title you typed", () => {
    const start = bookmark({ title: "" });
    const now = bookmark({ title: "My notes on design", editedAt: 50 });
    const read = bookmark({ title: "Home | Example Inc.", enriched: true });
    expect(rebaseRow(start, read, now)!.title).toBe("My notes on design");
  });

  it("keeps the tags you changed", () => {
    const start = bookmark({ tags: ["design"] });
    const now = bookmark({ tags: [] }); // you removed the tag
    const read = bookmark({ tags: ["design", "figma"], enriched: true });
    expect(rebaseRow(start, read, now)!.tags).toEqual([]);
  });

  it("still applies everything the read found that you did not touch", () => {
    const start = bookmark();
    const now = bookmark({ note: "remember this" });
    const read = bookmark({ description: "A page about things", enriched: true });
    const written = rebaseRow(start, read, now)!;
    expect(written.note).toBe("remember this");
    expect(written.description).toBe("A page about things");
  });
});

describe("you delete a bookmark while it is being worked on", () => {
  it("stays deleted when the work finishes", () => {
    const start = bookmark();
    const read = bookmark({ enriched: true });
    expect(rebaseRow(start, read, undefined)).toBeNull();
  });
});

describe("nothing else happened", () => {
  it("applies the result as it is", () => {
    const start = bookmark();
    const read = bookmark({ enriched: true, description: "d", meta: { fetchedAt: 3 } });
    expect(rebaseRow(start, read, start)).toEqual(read);
  });

  it("can clear a field the work removed", () => {
    const start = bookmark({ derivedTags: ["x"] });
    const read = bookmark({ derivedTags: undefined });
    expect("derivedTags" in rebaseRow(start, read, start)!).toBe(false);
  });
});

describe("the same page saved as several bookmarks", () => {
  it("marks every copy as captured when the screenshot lands, so none is captured again", async () => {
    const { captureResultPairs } = await import("../rebase");
    const library = [
      bookmark({ id: "a", url: "https://news.example/" }),
      bookmark({ id: "b", url: "https://news.example/" }),
      bookmark({ id: "c", url: "https://other.example/" }),
    ];
    const pairs = captureResultPairs(library, [{ url: "https://news.example/", ok: true, capturedAt: 7 }], "mobile");
    expect(pairs.map((pair) => pair.after.id).sort()).toEqual(["a", "b"]);
    expect(pairs.every((pair) => pair.after.preview.shotAt === 7 && pair.after.preview.shotDevice === "mobile")).toBe(true);
  });

  it("marks nothing for a capture that failed", async () => {
    const { captureResultPairs } = await import("../rebase");
    const library = [bookmark({ id: "a", url: "https://news.example/" })];
    expect(captureResultPairs(library, [{ url: "https://news.example/", ok: false }], "desktop")).toEqual([]);
  });
});
