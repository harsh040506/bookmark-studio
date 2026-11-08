/**
 * The public pages are generated, so their promises are tested here: unique metadata, safe
 * markup, a sitemap with only canonical pages, an llms.txt in the published shape, and a
 * build that writes every file the host and the crawlers ask for.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ES modules shared with the build scripts
import { NOT_FOUND, PAGES, SITE } from "../content.mjs";
// @ts-expect-error plain ES modules shared with the build scripts
import { inlineHtml, llmsTxt, pageToMarkdown, robotsTxt, sitemapXml } from "../render.mjs";
// @ts-expect-error plain ES modules shared with the build scripts
import { buildIco, buildSite, pngSize, resolveSiteUrl } from "../../scripts/build-site.mjs";

const SITE_URL = "https://example.test/";
const ROOT = path.resolve(import.meta.dirname, "..", "..");

interface Page {
  id: string;
  path: string;
  title: string;
  description: string;
  app?: boolean;
  og: { image: string; alt: string };
}

describe("page metadata", () => {
  const pages = PAGES as Page[];

  it("gives every page a unique title and description of a sensible length", () => {
    expect(new Set(pages.map((page) => page.title)).size).toBe(pages.length);
    expect(new Set(pages.map((page) => page.description)).size).toBe(pages.length);
    for (const page of pages) {
      expect(page.title.length, page.id).toBeLessThanOrEqual(65);
      expect(page.description.length, page.id).toBeGreaterThanOrEqual(70);
      expect(page.description.length, page.id).toBeLessThanOrEqual(170);
    }
  });

  it("names a versioned social image for every page", () => {
    for (const page of pages) {
      expect(page.og.image).toMatch(/^og\/[a-z]+-\d+\.png$/);
      expect(page.og.alt.length).toBeGreaterThan(10);
      expect(existsSync(path.join(ROOT, "public", page.og.image)), page.og.image).toBe(true);
      expect(pngSize(readFileSync(path.join(ROOT, "public", page.og.image)))).toEqual({ width: 1200, height: 630 });
    }
  });
});

describe("inline markup", () => {
  it("escapes everything that is not markup", () => {
    expect(inlineHtml('<script>alert("x")</script> & co')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co");
  });

  it("renders bold, code and links", () => {
    expect(inlineHtml("**a** `b` [c](https://d.test/)")).toBe('<strong>a</strong> <code>b</code> <a href="https://d.test/" rel="noreferrer">c</a>');
    expect(inlineHtml("[home](/)")).toBe('<a href="/">home</a>');
  });

  it("refuses links that are not https or a site path", () => {
    expect(() => inlineHtml("[x](javascript:alert(1))")).toThrow();
    expect(() => inlineHtml("[x](http://plain.test/)")).toThrow();
  });
});

describe("machine-readable files", () => {
  it("lists only the canonical pages in the sitemap", () => {
    const xml = sitemapXml(PAGES, SITE_URL, "2026-01-01");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs).toEqual((PAGES as Page[]).map((page) => new URL(page.path.slice(1), SITE_URL).href));
    expect(xml).not.toContain("404");
  });

  it("points robots.txt at the sitemap and blocks nothing", () => {
    const robots = robotsTxt(SITE_URL);
    expect(robots).toContain("Sitemap: https://example.test/sitemap.xml");
    expect(robots).not.toMatch(/Disallow:\s*\/\s*$/m);
  });

  it("writes llms.txt in the llmstxt.org shape", () => {
    const text = llmsTxt(SITE, PAGES, SITE_URL);
    expect(text).toMatch(/^# Bookmark Studio\n\n> .+\n/);
    expect(text).toContain("## Pages");
    expect(text).toContain("## Optional");
    for (const page of PAGES as Page[]) {
      expect(text).toContain(new URL(page.path === "/" ? "index.md" : `${page.path.slice(1)}.md`, SITE_URL).href);
    }
  });

  it("makes site links absolute in the Markdown copies", () => {
    const about = (PAGES as Page[]).find((page) => page.id === "about");
    const markdown = pageToMarkdown(about, SITE, SITE_URL);
    expect(markdown).toContain("](https://example.test/privacy)");
    expect(markdown).not.toMatch(/\]\(\/[a-z]/);
  });

  it("packs PNGs into a valid icon file", () => {
    const png = readFileSync(path.join(ROOT, "public", "icons", "icon16.png"));
    const ico = buildIco([{ size: 16, data: png }]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(1);
    expect(ico.readUInt32LE(6 + 8)).toBe(png.length);
    expect(ico.subarray(22).equals(png)).toBe(true);
  });
});

describe("site address", () => {
  it("prefers SITE_URL, then Vercel's production address, then the default", () => {
    expect(resolveSiteUrl({ SITE_URL: "https://mine.test" })).toBe("https://mine.test/");
    expect(resolveSiteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "app.vercel.test" })).toBe("https://app.vercel.test/");
    expect(resolveSiteUrl({})).toBe(`${SITE.defaultUrl}/`);
  });

  it("refuses a plain-http public address", () => {
    expect(() => resolveSiteUrl({ SITE_URL: "http://mine.test" })).toThrow();
    expect(resolveSiteUrl({ SITE_URL: "http://localhost:5174" })).toBe("http://localhost:5174/");
  });
});

describe("buildSite", () => {
  const out = mkdtempSync(path.join(tmpdir(), "bs-site-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("writes every page and file the host and crawlers ask for", () => {
    writeFileSync(
      path.join(out, "index.html"),
      '<!doctype html><html lang="en"><head><title>x</title><!-- site:head --><link rel="stylesheet" crossorigin href="./assets/index-abc.css"></head><body><div id="root"><!-- site:shell --></div><!-- site:noscript --></body></html>',
    );
    cpSync(path.join(ROOT, "public", "og"), path.join(out, "og"), { recursive: true });
    cpSync(path.join(ROOT, "public", "media"), path.join(out, "media"), { recursive: true });
    const { written } = buildSite(out, { siteUrl: SITE_URL, now: new Date("2026-01-01T00:00:00Z") });

    for (const file of ["about.html", "privacy.html", "404.html", "index.md", "about.md", "llms.txt", "llms-full.txt", "sitemap.xml", "robots.txt", "favicon.ico", ".well-known/security.txt"]) {
      expect(existsSync(path.join(out, file)), file).toBe(true);
      expect(written).toContain(file);
    }
    expect(written).not.toContain("index.html");

    const index = readFileSync(path.join(out, "index.html"), "utf8");
    expect(index).toContain('<link rel="canonical" href="https://example.test/" />');
    expect(index).toContain('<div class="boot">');
    expect(index.match(/<title>/g)).toHaveLength(1);
    // The app's stylesheet must not hold back the shell's first paint.
    expect(index).toContain('href="./assets/index-abc.css" media="print" data-app-css');

    const notFound = readFileSync(path.join(out, NOT_FOUND.file), "utf8");
    expect(notFound).toContain('content="noindex"');
    expect(notFound).not.toContain('rel="canonical"');

    const security = readFileSync(path.join(out, ".well-known/security.txt"), "utf8");
    expect(security).toContain("Expires: 2027-01-01T00:00:00Z");
  });
});
