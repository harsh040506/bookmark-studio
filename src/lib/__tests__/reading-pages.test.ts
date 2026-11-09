/**
 * "Reading a page should add to my bookmark, never overrule me."
 *
 * The rules for what a page read may change, and how it behaves when a page sends back
 * garbage. Pages are written by strangers; a malformed one must not break the bookmark
 * or the queue.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark, PageMetadata } from "../../../shared/types";
import { applyPageMetadata } from "../enrich";
import { friendlyFailure } from "../failure";
import { inertHtml } from "../inert-html";

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: "b1",
    url: "https://figma.com/file/x",
    title: "Files",
    domain: "figma.com",
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

function page(overrides: Partial<PageMetadata> = {}): PageMetadata {
  return {
    url: "https://figma.com/file/x",
    title: "Figma: the collaborative interface design tool",
    description: "Design, prototype and collaborate.",
    keywords: ["design", "prototyping"],
    text: "Figma is a collaborative design tool for teams building products together.",
    ...overrides,
  };
}

describe("a bookmark titled with a vague word", () => {
  it("becomes findable by what the page is about", () => {
    const read = applyPageMetadata(bookmark(), page(), 10);
    expect(read.description).toBe("Design, prototype and collaborate.");
    expect(read.meta?.text).toContain("collaborative design");
    expect(read.enriched).toBe(true);
    expect(read.meta?.fetchedAt).toBe(10);
  });

  it("keeps the title the person saved it with", () => {
    expect(applyPageMetadata(bookmark(), page(), 10).title).toBe("Files");
  });
});

describe("a bookmark the person has edited", () => {
  it("keeps their description", () => {
    const mine = bookmark({ editedAt: 5, description: "Our team's design system" });
    expect(applyPageMetadata(mine, page(), 10).description).toBe("Our team's design system");
  });

  it("does not bring back tags they removed", () => {
    const mine = bookmark({ editedAt: 5, tags: ["work"] });
    expect(applyPageMetadata(mine, page(), 10).tags).toEqual(["work"]);
  });
});

describe("a bookmark that already has a real screenshot", () => {
  it("keeps the screenshot as its preview", () => {
    const shot = bookmark({ preview: { method: "screenshot", shotAt: 3 } });
    const read = applyPageMetadata(shot, page({ image: "https://figma.com/og.png" }), 10);
    expect(read.preview.method).toBe("screenshot");
    expect(read.preview.imageUrl).toBe("https://figma.com/og.png");
  });
});

describe("a page that sends back malformed details", () => {
  it("does not crash on keywords, headings or tech that are not text", () => {
    const hostile = page({
      keywords: [42, null, "design"] as unknown as string[],
      headings: [{}, "Pricing"] as unknown as string[],
      tech: [7] as unknown as string[],
    });
    expect(() => applyPageMetadata(bookmark(), hostile, 10)).not.toThrow();
  });

  it("does not crash when keyword lists are missing entirely", () => {
    const bare = { url: "https://x.example/" } as unknown as PageMetadata;
    expect(() => applyPageMetadata(bookmark(), bare, 10)).not.toThrow();
  });
});

describe("what a person is told when a page cannot be read", () => {
  it.each([
    ["connect ECONNREFUSED 10.0.0.4:443", "Could not connect to the site"],
    ["TypeError: Failed to fetch", "Could not connect to the site"],
    ["The operation was aborted due to timeout", "The site took too long to answer"],
    ["getaddrinfo ENOTFOUND gone.example", "This site's name could not be found"],
    ["Resolves to a private address", "Skipped: this address points inside your own network"],
    ["HTTP 404", "The page no longer exists"],
    ["Response exceeded the 2000000 byte ceiling", "The page is too large to read"],
  ])("turns %j into plain words", (raw, expected) => {
    expect(friendlyFailure(raw)).toBe(expected);
  });

  it("never repeats an address from the person's network", () => {
    expect(friendlyFailure("connect ECONNREFUSED 192.168.0.10:8080")).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("has a calm fallback for anything unrecognised, including non-errors", () => {
    expect(friendlyFailure({ weird: true })).toBe("This page could not be read");
    expect(friendlyFailure(undefined)).toBe("This page could not be read");
  });
});

describe("reading a page full of inline handlers in the extension", () => {
  // Chrome logged a CSP error for every handler attribute it parsed, even though none run.
  it("hands the parser no handler attributes, however they are written", () => {
    const page = `<body onload="x()"><img src=a.png onerror=alert(1)><svg/onload=y()><a href="#" ONCLICK='z'>go</a></body>`;
    expect(inertHtml(page)).not.toMatch(/[\s/"']on[a-z]+\s*=/i);
  });

  it("leaves the words on the page alone", () => {
    const page = `<p>Set onclick="save()" on the button.</p>`;
    expect(inertHtml(page)).toBe(page);
  });

  it("keeps every attribute a title, description or preview image is read from", () => {
    const head = `<meta property="og:title" content="Turn on=off"><meta name="description" content="x"><link rel="icon" href="/on.png">`;
    expect(inertHtml(head)).toBe(head);
  });
});
