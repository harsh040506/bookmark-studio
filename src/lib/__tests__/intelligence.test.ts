/**
 * Tests for the non-AI intelligence layer: rules, query parsing, similarity, dedupe.
 */
import { describe, expect, it } from "vitest";
import { categoryFromFolder, classify, suggestTags } from "../classify";
import { parseQuery } from "../query";
import { canonicalUrl, extractSummary, getDomain, tokenizeForDisplay } from "../text";
import { TfIdfIndex } from "../tfidf";

describe("classify", () => {
  it("trusts the domain first", () => {
    expect(classify({ url: "https://github.com/foo/bar", title: "Some repo" })).toBe("Repository");
    expect(classify({ url: "https://fonts.google.com/", title: "Browse" })).toBe("Typography");
    expect(classify({ url: "https://arxiv.org/abs/1234", title: "A paper" })).toBe("Research");
  });

  it("matches subdomains of a known host", () => {
    expect(classify({ url: "https://gist.github.com/x", title: "Snippet" })).toBe("Repository");
  });

  it("falls back to keywords when the domain is unknown", () => {
    expect(
      classify({ url: "https://unknown-site.xyz/", title: "A free colour palette generator" }),
    ).toBe("Colour");
  });

  it("uses the user's folder name when no rule matches", () => {
    expect(
      classify({
        url: "https://obscure-startup.xyz/",
        title: "Home",
        folderPath: "Bookmarks bar / Hottest AI Companies & Startups",
      }),
    ).toBe("AI Tool");

    expect(
      classify({
        url: "https://another-unknown.xyz/",
        title: "Landing",
        folderPath: "Bookmarks bar / Woodworking Jigs",
      }),
    ).toBe("Woodworking Jigs");
  });

  it("ignores generic container folders", () => {
    expect(categoryFromFolder("Bookmarks bar")).toBeNull();
    expect(categoryFromFolder("Other bookmarks / Favorites")).toBeNull();
  });

  it("drops parentheticals rather than truncating mid-phrase", () => {
    expect(categoryFromFolder("Bookmarks bar / OCR (Optical Character Recognition)")).toBe("OCR");
  });
});

describe("suggestTags", () => {
  it("returns readable words, not stems", () => {
    const tags = suggestTags({
      url: "https://example.com/",
      title: "Vibecoding platforms and resources for designers",
      folderPath: "Bookmarks bar / Design Resources",
    });
    expect(tags.every((tag) => /^[a-z0-9+#]+$/.test(tag))).toBe(true);
    expect(tags).not.toContain("resourc");
    expect(tags.some((tag) => tag === "resources" || tag === "design")).toBe(true);
  });

  it("weights the folder the user chose above the title", () => {
    const tags = suggestTags({
      url: "https://example.com/",
      title: "Home",
      folderPath: "Bookmarks bar / Typography",
    });
    expect(tags).toContain("typography");
  });
});

describe("parseQuery", () => {
  it("reads operator syntax", () => {
    const query = parseQuery("tag:react site:github.com is:dead");
    expect(query.filters.tags).toEqual(["react"]);
    expect(query.filters.domains).toEqual(["github.com"]);
    expect(query.filters.health).toEqual(["dead"]);
    expect(query.text).toBe("");
  });

  it("understands plain-English time ranges", () => {
    const now = new Date("2026-06-15T12:00:00Z").getTime();
    const query = parseQuery("ai tools saved last month", now);
    expect(query.filters.addedAfter).toBeLessThan(now);
    expect(query.terms.length).toBeGreaterThan(0);
    expect(query.text).toContain("ai");
  });

  it("extracts an explicit year", () => {
    const query = parseQuery("design inspiration from 2024");
    expect(new Date(query.filters.addedAfter!).getFullYear()).toBe(2024);
    expect(new Date(query.filters.addedBefore!).getFullYear()).toBe(2025);
  });

  it("maps casual words onto health filters", () => {
    expect(parseQuery("broken links").filters.health).toContain("dead");
    expect(parseQuery("show me redirected bookmarks").filters.health).toContain("redirected");
  });

  it("strips conversational filler from the ranked text", () => {
    const query = parseQuery("show me my bookmarks about typography");
    expect(query.text.trim()).toBe("about typography");
  });

  it("reports what it understood for the UI", () => {
    const query = parseQuery("tag:react last 7 days");
    expect(query.chips.map((chip) => chip.kind)).toContain("tags");
    expect(query.chips.map((chip) => chip.kind)).toContain("addedAfter");
  });
});

describe("TfIdfIndex", () => {
  const index = new TfIdfIndex([
    { id: "a", terms: tokenizeForDisplay("react component library tailwind ui") },
    { id: "b", terms: tokenizeForDisplay("react components tailwind design system") },
    { id: "c", terms: tokenizeForDisplay("sourdough bread baking recipe") },
    { id: "d", terms: tokenizeForDisplay("pasta recipe italian cooking") },
  ]);

  it("ranks documents containing the query terms", () => {
    const hits = index.search(tokenizeForDisplay("react tailwind"));
    expect(hits.length).toBeGreaterThan(0);
    expect(["a", "b"]).toContain(hits[0].id);
  });

  it("finds topical neighbours without embeddings", () => {
    const similar = index.similar("a", 3);
    expect(similar[0].id).toBe("b");
    expect(similar.map((hit) => hit.id)).not.toContain("a");
  });

  it("keeps unrelated documents apart", () => {
    const similar = index.similar("c", 3);
    expect(similar[0].id).toBe("d");
  });

  it("returns nothing for an unknown document", () => {
    expect(index.similar("missing")).toEqual([]);
  });
});

describe("url handling", () => {
  it("strips tracking parameters when comparing for duplicates", () => {
    expect(canonicalUrl("https://example.com/page?utm_source=x&id=7")).toBe(
      canonicalUrl("https://www.example.com/page/?id=7"),
    );
  });

  it("treats http and https as the same resource", () => {
    expect(canonicalUrl("http://example.com/a")).toBe(canonicalUrl("https://example.com/a"));
  });

  it("keeps genuinely different URLs distinct", () => {
    expect(canonicalUrl("https://example.com/a")).not.toBe(canonicalUrl("https://example.com/b"));
  });

  it("extracts the registrable host", () => {
    expect(getDomain("https://www.ui.shadcn.com/docs")).toBe("ui.shadcn.com");
  });
});

describe("extractSummary", () => {
  it("returns whole sentences from the source text", () => {
    const text = "First sentence here. Second sentence follows. Third one is longer than the rest.";
    const summary = extractSummary(text, 40);
    expect(text).toContain(summary);
    expect(summary.length).toBeLessThanOrEqual(41);
  });

  it("passes short text through unchanged", () => {
    expect(extractSummary("Short.", 100)).toBe("Short.");
  });
});
