/**
 * The pieces that make one codebase run as a website, an extension and a local server:
 * which pages the extension bridge will serve, hash addresses, key chips, the sample library
 * going through the real importer, and the runtime descriptions shown in Settings.
 */
import { describe, expect, it } from "vitest";

import { isServedUrl, patternToRegExp } from "../../ext/bridge-host";
import { base64ToBytes, bytesToBase64 } from "../bridge";
import { SOURCE_BY_ID, runImport } from "../import";
import { HOME, parseLocation, routeToPath } from "../router";
import { describeRuntime, type RuntimeState } from "../runtime";
import { SAMPLE_LINK_COUNT, buildSampleBookmarksHtml } from "../sample";
import { shortcutParts } from "../utils";

describe("which sites the extension bridge serves", () => {
  const sites = ["http://localhost/*", "http://127.0.0.1/*", "https://someone.github.io/bookmark-studio/*"];

  it("serves localhost and 127.0.0.1 on any port, as Chrome match patterns do", () => {
    expect(isServedUrl("http://localhost:5173/", sites)).toBe(true);
    expect(isServedUrl("http://127.0.0.1:5174/#/folder/abc", sites)).toBe(true);
    expect(isServedUrl("http://localhost/", sites)).toBe(true);
  });

  it("serves the deployed site, but only under its own path", () => {
    expect(isServedUrl("https://someone.github.io/bookmark-studio/", sites)).toBe(true);
    expect(isServedUrl("https://someone.github.io/bookmark-studio/index.html#/recent", sites)).toBe(true);
    expect(isServedUrl("https://someone.github.io/another-project/", sites)).toBe(false);
    expect(isServedUrl("https://evil.github.io/bookmark-studio/", sites)).toBe(false);
  });

  it("refuses everything else, including lookalike hosts and other schemes", () => {
    expect(isServedUrl("https://localhost.evil.com/", sites)).toBe(false);
    expect(isServedUrl("https://localhost/", sites)).toBe(false);
    expect(isServedUrl("chrome-extension://abc/index.html", sites)).toBe(false);
    expect(isServedUrl(undefined, sites)).toBe(false);
    expect(isServedUrl("", sites)).toBe(false);
  });

  it("understands wildcard subdomains and schemes", () => {
    expect(patternToRegExp("*://*.example.com/*")?.test("https://app.example.com/x")).toBe(true);
    expect(patternToRegExp("*://*.example.com/*")?.test("http://example.com/")).toBe(true);
    expect(patternToRegExp("*://*.example.com/*")?.test("https://example.com.evil.net/")).toBe(false);
    expect(patternToRegExp("not a pattern")).toBeNull();
  });

  it("escapes dots, so a pattern cannot be satisfied by a different character", () => {
    expect(isServedUrl("https://someoneXgithub.io/bookmark-studio/", sites)).toBe(false);
  });
});

describe("bridge payload encoding", () => {
  it("round-trips arbitrary bytes through base64", () => {
    const bytes = new Uint8Array(70_000).map((_, index) => (index * 31) % 256);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});

describe("addresses in the URL fragment", () => {
  it("round-trips every kind of place through a path", () => {
    for (const route of [
      HOME,
      { kind: "scope", scope: "trash" } as const,
      { kind: "folder", id: "fld_1" } as const,
      { kind: "tag", tag: "design systems" } as const,
      { kind: "smart", id: "c/1" } as const,
    ]) {
      expect(parseLocation(routeToPath(route)).route).toEqual(route);
    }
  });
});

describe("keyboard chips", () => {
  it("splits a platform-neutral spec into keys", () => {
    const parts = shortcutParts("mod+shift+Z");
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe("Z");
  });

  it("keeps single keys and words whole", () => {
    expect(shortcutParts("?")).toEqual(["?"]);
    expect(shortcutParts("Esc")).toEqual(["Esc"]);
    expect(shortcutParts("Double-click")).toEqual(["Double-click"]);
  });

  it("reads an already-rendered Apple string", () => {
    expect(shortcutParts("⇧⌘Z")).toEqual(["⇧", "⌘", "Z"]);
  });
});

describe("the sample library", () => {
  it("is a valid bookmarks file the real importer reads in full", async () => {
    const html = buildSampleBookmarksHtml(Date.UTC(2026, 0, 1));
    const source = SOURCE_BY_ID.get("html");
    expect(source).toBeTruthy();
    const outcome = await runImport({
      file: new File([html], "Sample library.html", { type: "text/html" }),
      source: source!,
      existingUrls: [],
      folders: [],
      importId: "imp_sample",
      importedAt: Date.UTC(2026, 0, 1),
      sourceId: "src_sample",
      keepDuplicates: true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.total).toBe(SAMPLE_LINK_COUNT);
    expect(outcome.folderCount).toBeGreaterThanOrEqual(10);
    // Tags from the file carry over.
    expect(outcome.bookmarks.some((row) => row.tags.includes("design"))).toBe(true);
    // One link deliberately appears twice, so the Duplicates view has something to show.
    expect(new Set(outcome.bookmarks.map((row) => row.url)).size).toBeLessThan(outcome.total);
  });

  it("spreads dates across years, so date filters have something to find", () => {
    const html = buildSampleBookmarksHtml(Date.UTC(2026, 0, 1));
    const years = new Set([...html.matchAll(/ADD_DATE="(\d+)"/g)].map((match) => new Date(Number(match[1]) * 1000).getUTCFullYear()));
    expect(years.size).toBeGreaterThanOrEqual(3);
  });
});

describe("runtime descriptions", () => {
  const base: RuntimeState = {
    net: "offline",
    screenshots: false,
    browserBookmarks: false,
    extension: false,
    extensionVersion: null,
    extensionNeedsApproval: false,
    pageAccess: true,
    server: false,
    probed: true,
  };

  it("explains offline mode without calling it an error", () => {
    const text = describeRuntime(base);
    expect(text.title).toMatch(/offline/i);
    expect(text.detail).toMatch(/Import, search, organise and export all work/);
  });

  it("asks for approval when the extension is installed but this site is not allowed", () => {
    expect(describeRuntime({ ...base, extensionNeedsApproval: true }).title).toMatch(/allow this site/i);
  });

  it("names the backend that is answering", () => {
    expect(describeRuntime({ ...base, net: "bridge", extension: true }).title).toMatch(/extension/i);
    expect(describeRuntime({ ...base, net: "server", server: true, screenshots: true }).detail).toMatch(/headless Chrome/);
    expect(describeRuntime({ ...base, net: "server", server: true }).detail).toMatch(/Install Chrome or Edge/);
    expect(describeRuntime({ ...base, net: "extension" }).detail).toMatch(/two-way/);
  });
});
