/**
 * The import pipeline: provenance, ordering, folders and de-duplication.
 *
 * These four are one feature seen from four sides. A bookmark has to remember which file
 * it came from, where in that file it sat, which folder it belongs to, and whether the
 * library already had it. Each is invisible until it is wrong — a lost ordinal shows up as
 * a shuffled library, a lost import id as an un-reversible import, a lost arrival time as
 * an empty "Recently added" immediately after importing nine hundred bookmarks.
 *
 * Every parser feeds the same {@link normalizeItems}, so these tests exercise the path that
 * all twenty-eight sources take rather than one adapter's private behaviour.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark, Folder } from "../../../shared/types";
import { buildLibraryIndex, select } from "../engine";
import { buildFolderPaths, buildIndex, compareFolders, folderChildren } from "../library";
import { buildExistingIndex, normalizeItems } from "../import/normalize";
import { parseWith } from "../import/parsers";
import { parseQuery } from "../query";

const EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://zeta.example/" ADD_DATE="1700000000">Zeta</A>
        <DT><A HREF="https://alpha.example/" ADD_DATE="1700000001">Alpha</A>
        <DT><A HREF="https://zeta.example/?utm_source=x" ADD_DATE="1700000002">Zeta again</A>
    </DL><p>
    <DT><H3>Reading</H3>
    <DL><p>
        <DT><A HREF="https://mid.example/" ADD_DATE="1700000003">Mid</A>
    </DL><p>
</DL><p>`;

const NOW = 1_800_000_000_000;

interface Outcome {
  bookmarks: Bookmark[];
  folders: Folder[];
  duplicates: number;
  internalDuplicates: number;
}

/** Runs the real pipeline over a Netscape file, as the worker would. */
function runImport(
  html: string,
  options: {
    keepDuplicates?: boolean;
    existing?: Bookmark[];
    folders?: Folder[];
    importId?: string;
    importedAt?: number;
  } = {},
): Outcome {
  const parsed = parseWith("netscape", html, { fileName: "export.html" });
  const result = normalizeItems(parsed.items, {
    existing: buildExistingIndex(options.existing ?? []),
    folders: options.folders ?? [],
    importId: options.importId ?? "imp_1",
    importedAt: options.importedAt ?? NOW,
    sourceId: "src_1",
    keepDuplicates: options.keepDuplicates ?? true,
  });
  return {
    bookmarks: result.bookmarks,
    folders: [...(options.folders ?? []), ...result.folders],
    duplicates: result.duplicates,
    internalDuplicates: result.internalDuplicates,
  };
}

/** The titles a view would show, in the given sort, through the selection engine. */
function titlesInOrder(
  bookmarks: Bookmark[],
  folders: Folder[],
  sort: "custom" | "recent" = "custom",
  criteria: { importId?: string; scope?: "all" | "recent" } = {},
): string[] {
  const folderPaths = buildFolderPaths(folders);
  const index = buildLibraryIndex(bookmarks, folderPaths);
  const { positions } = select(index, folders, buildIndex(bookmarks, folderPaths), {
    query: parseQuery(""),
    scope: criteria.scope ?? "all",
    importId: criteria.importId ?? null,
    sort,
  });
  return Array.from(positions, (position) => index.rows[position].title);
}

describe("import provenance", () => {
  it("stamps every bookmark with its batch, source and arrival time", () => {
    const { bookmarks } = runImport(EXPORT);
    expect(bookmarks.length).toBeGreaterThan(0);
    for (const bookmark of bookmarks) {
      expect(bookmark.importId).toBe("imp_1");
      expect(bookmark.importedAt).toBe(NOW);
      expect(bookmark.sourceId).toBe("src_1");
    }
  });

  it("stamps folders too, so an import can be reversed completely", () => {
    const { folders } = runImport(EXPORT);
    expect(folders.length).toBeGreaterThan(0);
    expect(folders.every((folder) => folder.importId === "imp_1")).toBe(true);
  });

  it("keeps duplicate URLs when asked, so they can be reviewed", () => {
    const outcome = runImport(EXPORT, { keepDuplicates: true });
    // The tracking parameter must not disguise the duplicate, and the copy must survive.
    expect(outcome.internalDuplicates).toBe(1);
    expect(
      outcome.bookmarks.filter((row) => row.url.startsWith("https://zeta.example")),
    ).toHaveLength(2);
    expect(outcome.bookmarks).toHaveLength(4);
  });

  it("skips duplicate URLs when asked, and still reports them", () => {
    const outcome = runImport(EXPORT, { keepDuplicates: false });
    expect(outcome.internalDuplicates).toBe(1);
    expect(outcome.bookmarks).toHaveLength(3);
    expect(
      outcome.bookmarks.filter((row) => row.url.startsWith("https://zeta.example")),
    ).toHaveLength(1);
  });

  it("recognises rows the library already holds, ignoring tracking parameters", () => {
    const first = runImport(EXPORT);
    const second = runImport(EXPORT, {
      existing: first.bookmarks,
      folders: first.folders,
      keepDuplicates: false,
      importId: "imp_2",
    });
    expect(second.bookmarks).toHaveLength(0);
    expect(second.duplicates).toBeGreaterThan(0);
  });

  it("re-imports into the folders that already exist rather than duplicating them", () => {
    const first = runImport(EXPORT);
    const second = runImport(EXPORT, {
      existing: [],
      folders: first.folders,
      importId: "imp_2",
    });
    // No *new* folders: the paths resolved to the ones already there.
    expect(second.folders).toHaveLength(first.folders.length);
  });
});

describe("source order", () => {
  it("preserves the order of the file rather than re-sorting it", () => {
    const { bookmarks } = runImport(EXPORT);
    const inFileOrder = [...bookmarks].sort(
      (a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0),
    );
    expect(inFileOrder.map((row) => row.title)).toEqual(["Zeta", "Alpha", "Zeta again", "Mid"]);
  });

  it("sorts by the file order under the custom sort", () => {
    const { bookmarks, folders } = runImport(EXPORT);
    expect(titlesInOrder(bookmarks, folders)).toEqual(["Zeta", "Alpha", "Zeta again", "Mid"]);
  });

  it("filters to a single import batch", () => {
    const { bookmarks, folders } = runImport(EXPORT);
    const outsider: Bookmark = { ...bookmarks[0], id: "other", title: "Outsider", importId: "imp_2" };
    const titles = titlesInOrder([...bookmarks, outsider], folders, "custom", {
      importId: "imp_2",
    });
    expect(titles).toEqual(["Outsider"]);
  });
});

describe("folder ordering", () => {
  const folder = (overrides: Partial<Folder> & { id: string; name: string }): Folder => ({
    parentId: null,
    addedAt: 0,
    ...overrides,
  });

  it("puts the bookmarks bar first whatever its name sorts to", () => {
    const bar = folder({ id: "a", name: "Zebra bar", toolbar: true, sourceOrder: 90 });
    const other = folder({ id: "b", name: "Alpha", sourceOrder: 1 });
    expect([other, bar].sort(compareFolders)[0]).toBe(bar);
  });

  it("then follows the imported arrangement", () => {
    const second = folder({ id: "a", name: "Alpha", sourceOrder: 9 });
    const first = folder({ id: "b", name: "Zulu", sourceOrder: 2 });
    expect([second, first].sort(compareFolders).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("falls back to the name for folders made in the app", () => {
    const later = folder({ id: "a", name: "Beta" });
    const earlier = folder({ id: "b", name: "Alpha" });
    expect([later, earlier].sort(compareFolders).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("sorts app-made folders after imported ones", () => {
    const imported = folder({ id: "a", name: "Zulu", sourceOrder: 4 });
    const made = folder({ id: "b", name: "Alpha" });
    expect([made, imported].sort(compareFolders).map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("recently added", () => {
  const base = (overrides: Partial<Bookmark> & { id: string }): Bookmark => ({
    url: `https://example.com/${overrides.id}`,
    title: overrides.id,
    domain: "example.com",
    description: "",
    category: "Reference",
    tags: [],
    folderId: null,
    boardIds: [],
    addedAt: 0,
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
    ...overrides,
  });

  const recent = (bookmarks: Bookmark[]) =>
    titlesInOrder(bookmarks, [], "recent", { scope: "recent" });

  it("measures arrival here, not the browser's original save date", () => {
    // The exact case that made the old view useless: a decade-old export, imported now.
    const ancient = base({ id: "old", addedAt: Date.now() - 3_000 * 24 * 60 * 60 * 1000 });
    expect(recent([{ ...ancient, importedAt: Date.now() - 60_000 }])).toEqual(["old"]);
  });

  it("uses a two-day window", () => {
    const day = 24 * 60 * 60 * 1000;
    const justInside = base({ id: "in", addedAt: 0, importedAt: Date.now() - day });
    const justOutside = base({ id: "out", addedAt: 0, importedAt: Date.now() - 3 * day });
    expect(recent([justInside, justOutside])).toEqual(["in"]);
  });

  it("falls back to addedAt for bookmarks that predate import tracking", () => {
    const legacy = base({ id: "legacy", addedAt: Date.now() - 60_000 });
    expect(recent([legacy])).toEqual(["legacy"]);
  });
});

/**
 * Nesting.
 *
 * The flat root case is easy to get right by accident; depth is where an ordering scheme
 * usually falls apart, because it is where "position in the file" and "position among my
 * siblings" stop being the same number. A single counter running through the document makes
 * them agree at every level, and these tests pin that down.
 */
describe("order at depth", () => {
  const NESTED = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://bar-1.example/">bar one</A>
        <DT><H3>Zulu</H3>
        <DL><p>
            <DT><A HREF="https://zulu-1.example/">zulu one</A>
            <DT><H3>Zulu deep</H3>
            <DL><p>
                <DT><A HREF="https://deep-2.example/">deep two</A>
                <DT><A HREF="https://deep-1.example/">deep one</A>
            </DL><p>
            <DT><A HREF="https://zulu-2.example/">zulu two</A>
        </DL><p>
        <DT><H3>Alpha</H3>
        <DL><p>
            <DT><A HREF="https://alpha-1.example/">alpha one</A>
        </DL><p>
        <DT><A HREF="https://bar-2.example/">bar two</A>
    </DL><p>
    <DT><H3>Zebra top</H3>
    <DL><p>
        <DT><A HREF="https://zebra-1.example/">zebra one</A>
    </DL><p>
    <DT><H3>Aardvark top</H3>
    <DL><p>
        <DT><A HREF="https://aardvark-1.example/">aardvark one</A>
    </DL><p>
</DL><p>`;

  const IN_FILE_ORDER = [
    "bar one",
    "zulu one",
    "deep two",
    "deep one",
    "zulu two",
    "alpha one",
    "bar two",
    "zebra one",
    "aardvark one",
  ];

  it("reproduces the whole file in reading order, subfolders included", () => {
    const { bookmarks, folders } = runImport(NESTED, { importId: "imp_n" });
    expect(titlesInOrder(bookmarks, folders)).toEqual(IN_FILE_ORDER);
  });

  it("orders bookmarks inside a subfolder by the file, not by title", () => {
    const { bookmarks, folders } = runImport(NESTED, { importId: "imp_n" });
    const deep = folders.find((folder) => folder.name === "Zulu deep");
    const inside = bookmarks
      .filter((row) => row.folderId === deep?.id)
      .sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0))
      .map((row) => row.title);
    // "deep two" precedes "deep one" in the file; alphabetical would reverse them.
    expect(inside).toEqual(["deep two", "deep one"]);
  });

  it("nests folders under the right parents", () => {
    const { folders } = runImport(NESTED, { importId: "imp_n" });
    const children = folderChildren(folders);
    const roots = (children.get(null) ?? []).map((folder) => folder.name);
    expect(roots).toEqual(["Bookmarks bar", "Zebra top", "Aardvark top"]);

    const bar = folders.find((folder) => folder.name === "Bookmarks bar");
    const inBar = (children.get(bar!.id) ?? []).map((folder) => folder.name);
    // Zulu comes first in the file even though Alpha wins alphabetically.
    expect(inBar).toEqual(["Zulu", "Alpha"]);
  });

  it("keeps two imports from interleaving", () => {
    const first = runImport(NESTED, { importId: "imp_n" });
    const second = runImport(EXPORT, {
      existing: first.bookmarks,
      folders: first.folders,
      importId: "imp_2",
      importedAt: NOW + 60_000,
    });
    const titles = titlesInOrder(
      [...first.bookmarks, ...second.bookmarks],
      second.folders,
    );
    // Everything from the first file, in its order, then everything from the second.
    expect(titles.slice(0, 9)).toEqual(IN_FILE_ORDER);
    expect(titles.slice(9, 11)).toEqual(["Zeta", "Alpha"]);
  });
});

/**
 * The other formats.
 *
 * One test per family rather than per source, because the twenty-eight sources share nine
 * parsers — what is worth pinning is that each parser reaches {@link normalizeItems} with
 * the same six facts, not that "Brave" and "Chrome" both call the Netscape scanner.
 */
describe("other formats reach the same pipeline", () => {
  it("reads a Chromium Bookmarks file, with its folder tree", () => {
    const json = JSON.stringify({
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "Bookmarks bar",
          children: [
            { type: "url", name: "Alpha", url: "https://alpha.example/", date_added: "13350000000000000" },
            {
              type: "folder",
              name: "Nested",
              children: [{ type: "url", name: "Beta", url: "https://beta.example/" }],
            },
          ],
        },
      },
    });
    const parsed = parseWith("chromium-json", json, { fileName: "Bookmarks" });
    expect(parsed.items.map((item) => item.title)).toEqual(["Alpha", "Beta"]);
    expect(parsed.items[1].folderPath).toEqual(["Bookmarks bar", "Nested"]);
  });

  it("reads a Firefox places export", () => {
    const json = JSON.stringify({
      type: "text/x-moz-place-container",
      title: "",
      children: [
        {
          type: "text/x-moz-place-container",
          title: "Bookmarks Menu",
          children: [
            {
              type: "text/x-moz-place",
              title: "Rust",
              uri: "https://rust-lang.org/",
              tags: "rust,systems",
            },
          ],
        },
      ],
    });
    const parsed = parseWith("firefox-json", json, { fileName: "bookmarks.json" });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].folderPath).toEqual(["Bookmarks Menu"]);
    expect(parsed.items[0].tags).toEqual(["rust", "systems"]);
  });

  it("reads a Pinboard JSON export, whose column names are inverted", () => {
    const json = JSON.stringify([
      {
        href: "https://example.com/a",
        description: "The title",
        extended: "The note",
        tags: "one two",
        time: "2024-01-01T00:00:00Z",
      },
    ]);
    const parsed = parseWith("json", json, { fileName: "pinboard.json" });
    // Pinboard calls the title `description` and the description `extended`.
    expect(parsed.items[0].title).toBe("The title");
    expect(parsed.items[0].description).toBe("The note");
  });

  it("reads a CSV with quoted fields, commas and embedded newlines", () => {
    const csv = [
      "url,title,tags,folder,created",
      '"https://example.com/one","A title, with a comma","design,ui","Work/Design","2024-03-01"',
      '"https://example.com/two","Multi\nline","","",""',
    ].join("\n");
    const parsed = parseWith("csv", csv, { fileName: "export.csv" });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].title).toBe("A title, with a comma");
    expect(parsed.items[0].tags).toEqual(["design", "ui"]);
    expect(parsed.items[0].folderPath).toEqual(["Work", "Design"]);
    expect(parsed.items[1].title).toContain("Multi");
  });

  it("reads an Evernote ENEX, keeping notes that carry no URL", () => {
    const enex = `<?xml version="1.0"?><en-export>
      <note><title>Clipped</title><source-url>https://example.com/clip</source-url></note>
      <note><title>Just a note</title><content><![CDATA[<div>Some body</div>]]></content></note>
    </en-export>`;
    const parsed = parseWith("enex", enex, { fileName: "notes.enex" });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].url).toBe("https://example.com/clip");
    expect(parsed.items[1].kind).toBe("note");
    expect(parsed.items[1].text).toContain("Some body");
  });

  it("reads a Safari XML property list", () => {
    const plist = `<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict>
      <key>Children</key><array>
        <dict>
          <key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string>
          <key>URLString</key><string>https://apple.example/</string>
          <key>URIDictionary</key><dict><key>title</key><string>Apple</string></dict>
        </dict>
      </array>
    </dict></plist>`;
    const parsed = parseWith("safari-plist", plist, { fileName: "Bookmarks.plist" });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].url).toBe("https://apple.example/");
    expect(parsed.items[0].title).toBe("Apple");
  });

  it("reads a plain list of URLs, including markdown links", () => {
    const text = ["# heading", "https://one.example/ One", "[Two](https://two.example/)", "notaurl"].join(
      "\n",
    );
    const parsed = parseWith("text-urls", text, { fileName: "links.txt" });
    expect(parsed.items.map((item) => item.url)).toEqual([
      "https://one.example/",
      "https://two.example/",
    ]);
    expect(parsed.items[1].title).toBe("Two");
  });

  it("refuses addresses that would execute, in every format", () => {
    const html = `<DL><p><DT><A HREF="javascript:alert(1)">Bad</A>
      <DT><A HREF="https://good.example/">Good</A></DL><p>`;
    const fromHtml = parseWith("netscape", html, { fileName: "x.html" });
    expect(fromHtml.items.map((item) => item.url)).toEqual(["https://good.example/"]);
    expect(fromHtml.skipped).toBe(1);

    const fromJson = parseWith("json", JSON.stringify([{ url: "javascript:alert(1)" }]), {
      fileName: "x.json",
    });
    expect(fromJson.items).toHaveLength(0);

    const fromCsv = parseWith("csv", "url\njavascript:alert(1)", { fileName: "x.csv" });
    expect(fromCsv.items).toHaveLength(0);
  });
});
