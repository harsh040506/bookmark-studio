/**
 * The source catalogue and its detection.
 *
 * ## What is worth pinning here
 *
 * Detection is a *hint* — the user can always override it in the picker — so these tests do
 * not assert that every file is identified perfectly, which would be impossible: a Netscape
 * export from Brave is byte-identical to one from Chrome. What they do assert is that the
 * catalogue is internally coherent (every source names a real parser, every group is
 * reachable, nothing is duplicated), and that the handful of files which *are*
 * distinguishable are distinguished — because those are the ones where a wrong guess would
 * silently import nothing.
 */
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_EXTENSIONS,
  bestSource,
  detectInput,
  detectSources,
  SOURCE_BY_ID,
  SOURCE_GROUPS,
  SOURCES,
} from "../import/catalog";
import { parseWith } from "../import/parsers";
import type { ParserId } from "../import/types";

const PARSERS: ParserId[] = [
  "netscape",
  "chromium-json",
  "firefox-json",
  "safari-plist",
  "enex",
  "csv",
  "json",
  "x-archive",
  "text-urls",
  "backup",
];

const detect = (fileName: string, head = "") =>
  detectInput(fileName, head, head.length);

describe("the catalogue", () => {
  it("covers at least the twenty-five sources the app advertises", () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(25);
  });

  it("names every browser and service the import dialog claims", () => {
    const names = SOURCES.map((source) => source.name.toLowerCase());
    for (const expected of [
      "chrome",
      "microsoft edge",
      "brave",
      "opera",
      "firefox",
      "safari",
      "arc",
      "vivaldi",
      "chromium",
      "duckduckgo",
      "samsung internet",
      "icloud bookmarks",
      "raindrop.io",
      "pocket",
      "notion",
      "evernote",
      "readwise reader",
      "instapaper",
      "pinboard",
      "delicious",
      "diigo",
      "google bookmarks",
      "bookmarks html",
      "csv",
      "json",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("gives every source a unique id and at least one parser", () => {
    const ids = new Set<string>();
    for (const source of SOURCES) {
      expect(ids.has(source.id)).toBe(false);
      ids.add(source.id);
      expect(source.parsers.length).toBeGreaterThan(0);
      for (const parser of source.parsers) expect(PARSERS).toContain(parser);
      expect(source.accept.length).toBeGreaterThan(0);
      // The hint is the only thing telling somebody where to find their export, so an
      // empty one is a source nobody can actually use.
      expect(source.hint.length).toBeGreaterThan(10);
    }
    expect(SOURCE_BY_ID.size).toBe(SOURCES.length);
  });

  it("files every source under a group the picker renders", () => {
    for (const source of SOURCES) expect(SOURCE_GROUPS).toContain(source.group);
    for (const group of SOURCE_GROUPS) {
      expect(SOURCES.some((source) => source.group === group)).toBe(true);
    }
  });

  it("advertises every accepted extension exactly once", () => {
    expect(new Set(ACCEPTED_EXTENSIONS).size).toBe(ACCEPTED_EXTENSIONS.length);
    for (const extension of ACCEPTED_EXTENSIONS) expect(extension.startsWith(".")).toBe(true);
  });

  it("gives every CSV source a preset that names a URL column", () => {
    for (const source of SOURCES) {
      if (!source.csv) continue;
      expect(source.csv.url.length).toBeGreaterThan(0);
    }
  });
});

describe("detection", () => {
  it("recognises a source named in the file name", () => {
    expect(bestSource(detect("brave_bookmarks_2026.html", "<!DOCTYPE NETSCAPE-Bookmark-file-1>")).id).toBe(
      "brave",
    );
    expect(bestSource(detect("raindrop.csv", "url,title,excerpt,folder")).id).toBe("raindrop");
    expect(bestSource(detect("instapaper-export.csv", "URL,Title,Selection,Folder,Timestamp")).id).toBe(
      "instapaper",
    );
  });

  it("recognises a Firefox places backup by its structure, not its name", () => {
    const head = '{"guid":"root________","type":"text/x-moz-place-container","children":[]}';
    expect(bestSource(detect("bookmarks-2026-01-01.json", head)).id).toBe("firefox");
  });

  it("recognises this app's own backup and keeps it away from the generic JSON path", () => {
    const head = '{"exportedAt":1767225600000,"folders":[],"boards":[],"bookmarks":[]}';
    expect(bestSource(detect("bookmarks-2026-01-01.json", head)).id).toBe("backup");
  });

  it("recognises an X archive from its assignment prefix", () => {
    expect(bestSource(detect("bookmark.js", "window.YTD.bookmark.part0 = [")).id).toBe("x");
  });

  it("recognises a Pinboard export by its inverted column names", () => {
    const head = '[{"href":"https://a.example/","description":"A","extended":"note","tags":"x"}]';
    expect(bestSource(detect("export.json", head)).id).toBe("pinboard");
  });

  it("falls back to Chrome for an anonymous Netscape file, and says so is only a guess", () => {
    const head = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p><DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bar</H3>';
    const input = detect("bookmarks.html", head);
    expect(bestSource(input).id).toBe("chrome");
    // Runners-up are offered too, because the guess is genuinely ambiguous.
    const ranked = detectSources(input);
    expect(ranked[0].confidence).toBeLessThan(0.8);
    expect(ranked.length).toBeGreaterThan(1);
  });

  it("falls back to a generic source rather than refusing an unknown file", () => {
    expect(bestSource(detect("mystery.csv", "a,b,c")).id).toBe("csv");
    expect(bestSource(detect("mystery.txt", "https://a.example/")).id).toBe("text");
    expect(bestSource(detect("mystery.bin", "")).id).toBe("html");
  });
});

describe("every parser a source names can actually be run", () => {
  it("returns a result rather than throwing on an empty or hostile file", () => {
    for (const parser of PARSERS) {
      for (const input of ["", "not a file", "<plist", "{", "["]) {
        const result = parseWith(parser, input, { fileName: "x" });
        expect(Array.isArray(result.items)).toBe(true);
        expect(result.skipped).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("survives a deeply nested JSON document without recursing without bound", () => {
    let nested = '{"url":"https://deep.example/"}';
    for (let depth = 0; depth < 5000; depth += 1) nested = `{"a":${nested}}`;
    const result = parseWith("json", nested, { fileName: "deep.json" });
    // Depth-limited by design: it finds nothing rather than blowing the stack.
    expect(result.items).toHaveLength(0);
  });
});
