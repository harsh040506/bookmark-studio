/**
 * Ten thousand bookmarks in folders eight levels deep, and the trees nobody made by hand.
 *
 * ## The shape being tested
 *
 * `scale.test.ts` pins the selection engine on a flat library. A real library is a tree: a
 * decade of browser bookmarks is a few thousand folders nested five to ten deep, and every
 * part of the app that walks that tree (naming folders, counting what is under each one,
 * selecting a folder with its subfolders, exporting, syncing) has its own way to turn slow
 * or to lose something. This file drives a 10,000-bookmark, 8-level library through each
 * of them and checks the answers against a naive version.
 *
 * ## And the hostile shape
 *
 * A folder tree also arrives from places that are not a person: a damaged backup, a file
 * somebody else made, the other copy of the library. Those can describe a chain thousands
 * of folders long, folders that name each other as parent, or a parent that does not exist.
 * None of that may crash a page load, hang the tab or drop a bookmark from an export.
 *
 * Timing budgets are several times what a laptop needs, as in `scale.test.ts`: loose enough
 * for a slow CI machine, tight enough to catch a quadratic walk.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Bookmark, Folder } from "../../../shared/types";
import { buildLibraryIndex, countFacets, select } from "../engine";
import { SOURCE_BY_ID, runImport } from "../import";
import {
  MAX_FOLDER_DEPTH,
  buildFolderPaths,
  folderAncestors,
  folderChildren,
  folderEntries,
  folderMoveProblem,
  folderSubtree,
  folderTotals,
  rankFolders,
} from "../library";
import { parseNetscapeBookmarks, serializeNetscapeBookmarks } from "../netscape";
import { parseBackup } from "../backup";
import { parseQuery } from "../query";
import { repairFolders } from "../repair";
import { TfIdfIndex } from "../tfidf";

const BOOKMARKS = 10_000;
const DEPTH = 8;

/**
 * A bookmarks file with `BOOKMARKS` links spread over a tree `DEPTH` levels deep.
 *
 * Three top-level folders, each level splitting in two below that, so the tree has a few
 * hundred folders and every level holds links of its own, as a real one does.
 */
function nestedExport(): { html: string; folderCount: number } {
  const lines: string[] = ["<!DOCTYPE NETSCAPE-Bookmark-file-1>", "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>", "<DL><p>"];
  const paths: string[][] = [];
  const grow = (path: string[]) => {
    paths.push(path);
    if (path.length >= DEPTH) return;
    for (let branch = 0; branch < 2; branch += 1) grow([...path, `L${path.length + 1}-${branch}-${paths.length}`]);
  };
  for (const top of ["Bookmarks bar", "Other bookmarks", "Mobile bookmarks"]) grow([top]);

  const perFolder = Math.floor(BOOKMARKS / paths.length);
  let written = 0;
  let open: string[] = [];
  const closeTo = (keep: number) => {
    while (open.length > keep) {
      open.pop();
      lines.push("</DL><p>");
    }
  };
  paths.forEach((path, position) => {
    let shared = 0;
    while (shared < open.length && shared < path.length && open[shared] === path[shared]) shared += 1;
    closeTo(shared);
    for (const name of path.slice(shared)) {
      lines.push(`<DT><H3 ADD_DATE="1700000000">${name}</H3>`, "<DL><p>");
      open.push(name);
    }
    const count = position === paths.length - 1 ? BOOKMARKS - written : perFolder;
    for (let link = 0; link < count; link += 1) {
      lines.push(`<DT><A HREF="https://site${written % 400}.example/page/${written}" ADD_DATE="1700000000">Page ${written} design notes</A>`);
      written += 1;
    }
  });
  closeTo(0);
  lines.push("</DL><p>");
  open = [];
  return { html: lines.join("\n"), folderCount: paths.length };
}

async function importHtml(html: string, existing: Folder[] = []): Promise<{ bookmarks: Bookmark[]; folders: Folder[] }> {
  const outcome = await runImport({
    file: new File([html], "bookmarks.html", { type: "text/html" }),
    source: SOURCE_BY_ID.get("chrome")!,
    existingUrls: [],
    folders: existing,
    importId: "imp_nesting",
    importedAt: Date.now(),
    sourceId: "src_nesting",
    keepDuplicates: true,
  });
  expect(outcome.ok).toBe(true);
  return { bookmarks: outcome.bookmarks, folders: [...existing, ...outcome.newFolders] };
}

function time(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** How many folders sit above this one, counted the slow, obviously right way. */
function depthOf(folder: Folder, byId: Map<string, Folder>): number {
  let depth = 1;
  let cursor = folder.parentId ? byId.get(folder.parentId) : undefined;
  while (cursor) {
    depth += 1;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return depth;
}

function folder(id: string, parentId: string | null, name = id): Folder {
  return { id, name, parentId, addedAt: 1 };
}

function chain(length: number): Folder[] {
  const folders: Folder[] = [];
  for (let position = 0; position < length; position += 1) {
    folders.push(folder(`c${position}`, position ? `c${position - 1}` : null, `n${position}`));
  }
  return folders;
}

const fixture = nestedExport();
const emptyText = new TfIdfIndex([]);

// These tests do real work on ten thousand rows; the budgets inside them are what is being
// checked, not the runner's default five seconds on a busy CI machine.
vi.setConfig({ testTimeout: 60_000 });

/** The library every test below reads. Imported once: nothing here changes it. */
let imported: { bookmarks: Bookmark[]; folders: Folder[] };
let importMs = 0;
beforeAll(async () => {
  const started = performance.now();
  imported = await importHtml(fixture.html);
  importMs = performance.now() - started;
}, 60_000);

describe(`${BOOKMARKS.toLocaleString()} bookmarks nested ${DEPTH} levels deep`, () => {
  it("imports every bookmark and rebuilds the whole tree", () => {
    const { bookmarks, folders } = imported;
    expect(importMs).toBeLessThan(15_000);

    expect(bookmarks).toHaveLength(BOOKMARKS);
    expect(folders).toHaveLength(fixture.folderCount);
    const byId = new Map(folders.map((entry) => [entry.id, entry]));
    expect(Math.max(...folders.map((entry) => depthOf(entry, byId)))).toBe(DEPTH);
    // Nothing is filed nowhere, and nothing points at a folder that does not exist.
    expect(bookmarks.every((row) => row.folderId && byId.has(row.folderId))).toBe(true);
  });

  it("names, counts and selects through the tree in a few milliseconds", () => {
    const { bookmarks, folders } = imported;
    const byId = new Map(folders.map((entry) => [entry.id, entry]));

    let paths = new Map<string, string>();
    expect(time(() => (paths = buildFolderPaths(folders)))).toBeLessThan(250);
    expect(paths.size).toBe(folders.length);
    for (const entry of folders) expect(paths.get(entry.id)!.split(" / ")).toHaveLength(depthOf(entry, byId));

    const index = buildLibraryIndex(bookmarks, paths);
    const facets = countFacets(index);
    let totals = new Map<string, number>();
    expect(time(() => (totals = folderTotals(folders, facets.folders)))).toBeLessThan(250);

    // Every folder's total is itself plus everything beneath it, and the tops add up to the library.
    const roots = folders.filter((entry) => entry.parentId === null);
    expect(roots.reduce((sum, entry) => sum + (totals.get(entry.id) ?? 0), 0)).toBe(BOOKMARKS);

    for (const level of [1, 3, 5, 8]) {
      const target = folders.find((entry) => depthOf(entry, byId) === level)!;
      const subtree = folderSubtree(folders, target.id);
      const naive = bookmarks.filter((row) => row.folderId && subtree.has(row.folderId)).length;
      const { positions } = select(index, folders, emptyText, {
        query: parseQuery(""),
        scope: "all",
        folderId: target.id,
        sort: "recent",
      });
      expect(positions.length).toBe(naive);
      expect(totals.get(target.id)).toBe(naive);
      expect(folderAncestors(folders, target.id)).toHaveLength(level - 1);
    }
  });

  it("keeps typing inside a folder under a frame budget", () => {
    const { bookmarks, folders } = imported;
    const index = buildLibraryIndex(bookmarks, buildFolderPaths(folders));
    const top = folders.find((entry) => entry.parentId === null)!;
    const search = (text: string) =>
      select(index, folders, emptyText, { query: parseQuery(text), scope: "all", folderId: top.id, sort: "recent" });

    search("");
    let worst = 0;
    for (let length = 1; length <= "design".length; length += 1) {
      worst = Math.max(worst, time(() => search("design".slice(0, length))));
    }
    expect(worst).toBeLessThan(200);
    // The tree is grouped and sorted once per version of the folder list, not per keystroke.
    expect(folderChildren(folders)).toBe(folderChildren(folders));
  });

  it("exports and re-imports without losing a bookmark, a folder or a level", async () => {
    const { bookmarks, folders } = imported;
    let html = "";
    expect(
      time(() => {
        html = serializeNetscapeBookmarks({ folders, bookmarks });
      }),
    ).toBeLessThan(3_000);

    const again = await importHtml(html);
    expect(again.bookmarks).toHaveLength(BOOKMARKS);
    expect(again.folders).toHaveLength(folders.length);
    const first = [...buildFolderPaths(folders).values()].sort();
    const second = [...buildFolderPaths(again.folders).values()].sort();
    expect(second).toEqual(first);
  });

  it("lands in the same folders when the same file is imported twice", async () => {
    const twice = await importHtml(fixture.html, imported.folders);
    expect(twice.folders).toHaveLength(imported.folders.length);
  });
});

describe("trees nobody made by hand", () => {
  it("stops an imported tree at the depth limit and still keeps every bookmark", async () => {
    const deep = 3_000;
    const html = [
      "<DL><p>",
      ...Array.from({ length: deep }, (_, level) => `<DT><H3>d${level}</H3><DL><p>`),
      '<DT><A HREF="https://deep.example/">At the bottom</A>',
      ...Array.from({ length: deep }, () => "</DL><p>"),
      '<DT><A HREF="https://top.example/">At the top</A>',
      "</DL><p>",
    ].join("\n");

    const { bookmarks, folders } = await importHtml(html);
    expect(bookmarks.map((row) => row.title).sort()).toEqual(["At the bottom", "At the top"]);
    expect(folders.length).toBeLessThanOrEqual(MAX_FOLDER_DEPTH);
    expect(bookmarks.find((row) => row.title === "At the bottom")!.folderId).toBeTruthy();
  });

  it("stops a nested JSON export at the same limit", async () => {
    let node: Record<string, unknown> = { type: "url", name: "Bottom", url: "https://deep.example/" };
    for (let level = 0; level < 500; level += 1) node = { type: "folder", name: `d${level}`, children: [node] };
    const outcome = await runImport({
      file: new File([JSON.stringify({ roots: { bookmark_bar: node } })], "Bookmarks", { type: "application/json" }),
      source: SOURCE_BY_ID.get("chrome")!,
      parser: "chromium-json",
      existingUrls: [],
      folders: [],
      importId: "imp_json",
      importedAt: Date.now(),
      sourceId: "src_json",
      keepDuplicates: true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.bookmarks).toHaveLength(1);
    expect(outcome.newFolders.length).toBeLessThanOrEqual(MAX_FOLDER_DEPTH);
  });

  it("names a chain far deeper than the stack without crashing or growing without bound", () => {
    const folders = chain(50_000);
    let paths = new Map<string, string>();
    expect(time(() => (paths = buildFolderPaths(folders)))).toBeLessThan(2_000);
    expect(paths.size).toBe(folders.length);
    expect(paths.get("c0")).toBe("n0");
    expect(paths.get("c2")).toBe("n0 / n1 / n2");
    // Below the limit a path is shortened, so fifty thousand of them stay small.
    const deepest = paths.get("c49999")!;
    expect(deepest.endsWith(" / … / n49999")).toBe(true);
    expect(deepest.split(" / ").length).toBeLessThanOrEqual(MAX_FOLDER_DEPTH + 2);
  });

  it("gives folders in a loop, or under a missing parent, a path instead of none", () => {
    const paths = buildFolderPaths([folder("a", "b", "A"), folder("b", "a", "B"), folder("orphan", "gone", "Orphan"), folder("child", "orphan", "Child")]);
    expect(paths.get("a")).toBeTruthy();
    expect(paths.get("b")).toBeTruthy();
    expect(paths.get("orphan")).toBe("Orphan");
    expect(paths.get("child")).toBe("Orphan / Child");
  });

  it("counts and walks a deep chain without recursion", () => {
    const folders = chain(50_000);
    const counts = new Map(folders.map((entry) => [entry.id, 1]));
    let totals = new Map<string, number>();
    expect(time(() => (totals = folderTotals(folders, counts)))).toBeLessThan(2_000);
    expect(totals.get("c0")).toBe(50_000);
    expect(totals.get("c49999")).toBe(1);
    expect(folderSubtree(folders, "c0").size).toBe(50_000);
    expect(folderAncestors(folders, "c49999")).toHaveLength(49_999);
  });

  it("does not loop forever looking for the folders above one in a loop", () => {
    const folders = [folder("a", "b"), folder("b", "c"), folder("c", "a")];
    expect(folderAncestors(folders, "a").sort()).toEqual(["b", "c"]);
    expect(folderAncestors(folders, "missing")).toEqual([]);
    expect(folderSubtree(folders, "a").size).toBe(3);
  });

  it("repairs a very long chain in one pass and cuts a loop at the end of it", () => {
    const folders = chain(50_000);
    folders[0].parentId = "c49999";
    let repaired: Folder[] = [];
    expect(time(() => (repaired = repairFolders(folders)))).toBeLessThan(2_000);
    expect(repaired).toHaveLength(50_000);
    expect(repaired.filter((entry) => entry.parentId === null)).toHaveLength(1);
    // Still one connected tree: every folder reaches the top.
    expect(folderSubtree(repaired, repaired.find((entry) => entry.parentId === null)!.id).size).toBe(50_000);
  });

  it("repairs loops in a backup as it is read, not at the next reload", () => {
    const restored = parseBackup(
      JSON.stringify({
        folders: [folder("a", "b", "A"), folder("b", "a", "B")],
        bookmarks: [{ id: "x", url: "https://example.com/", title: "Kept", folderId: "a" }],
      }),
    );
    expect(restored.folders.some((entry) => entry.parentId === null)).toBe(true);
    expect(folderTotals(restored.folders, new Map([["a", 1]])).get("a")).toBe(1);
  });

  it("exports bookmarks whose folder is missing, looped or orphaned instead of dropping them", () => {
    const bookmark = (title: string, folderId: string | null) => ({
      url: `https://example.com/${title}`,
      title,
      addedAt: 1_700_000_000_000,
      folderId,
    });
    const html = serializeNetscapeBookmarks({
      folders: [
        folder("loop-a", "loop-b", "Loop A"),
        folder("loop-b", "loop-a", "Loop B"),
        folder("orphan", "deleted-elsewhere", "Orphan"),
        folder("self", "self", "Self"),
      ],
      bookmarks: [
        bookmark("in-loop", "loop-a"),
        bookmark("in-orphan", "orphan"),
        bookmark("in-self", "self"),
        bookmark("no-such-folder", "never-existed"),
        bookmark("unfiled", null),
      ],
    });
    const parsed = parseNetscapeBookmarks(html);
    expect(parsed.bookmarks.map((row) => row.title).sort()).toEqual(
      ["in-loop", "in-orphan", "in-self", "no-such-folder", "unfiled"].sort(),
    );
    expect(parsed.folders.map((entry) => entry.name).sort()).toEqual(["Loop A", "Loop B", "Orphan", "Self"]);
  });

  it("exports a chain far deeper than the stack", () => {
    const folders = chain(20_000);
    const html = serializeNetscapeBookmarks({
      folders,
      bookmarks: [{ url: "https://example.com/", title: "Bottom", addedAt: 1, folderId: "c19999" }],
    });
    expect(html.match(/<H3/g)).toHaveLength(20_000);
    expect(html).toContain("Bottom");
  });
});

describe("moving a folder", () => {
  const tree = [folder("a", null), folder("b", "a"), folder("c", "b"), folder("x", null), folder("y", "x")];

  it("allows a move to another branch or to the top level", () => {
    expect(folderMoveProblem(tree, "c", "x")).toBeNull();
    expect(folderMoveProblem(tree, "b", null)).toBeNull();
    expect(folderMoveProblem(tree, "x", "c")).toBeNull();
  });

  it("refuses to put a folder inside itself or anything beneath it", () => {
    expect(folderMoveProblem(tree, "a", "a")).toMatch(/into itself/);
    expect(folderMoveProblem(tree, "a", "c")).toMatch(/own subfolders/);
    expect(folderMoveProblem(tree, "b", "c")).toMatch(/own subfolders/);
  });

  it("refuses a folder or a destination that is no longer there", () => {
    expect(folderMoveProblem(tree, "gone", "a")).toMatch(/no longer here/);
    expect(folderMoveProblem(tree, "a", "gone")).toMatch(/no longer here/);
  });

  it("counts what is beneath the folder against the depth limit", () => {
    const deep = chain(MAX_FOLDER_DEPTH);
    const shallow = [...deep, folder("solo", null), folder("solo-child", "solo")];
    // One folder under the deepest would be level 33.
    expect(folderMoveProblem(shallow, "solo-child", `c${MAX_FOLDER_DEPTH - 1}`)).toMatch(/levels deep/);
    // Two levels moved under the last-but-one would end at level 33 too.
    expect(folderMoveProblem(shallow, "solo", `c${MAX_FOLDER_DEPTH - 2}`)).toMatch(/levels deep/);
    expect(folderMoveProblem(shallow, "solo-child", `c${MAX_FOLDER_DEPTH - 2}`)).toBeNull();
  });

  it("answers for a tree of thousands without walking it per folder", () => {
    expect(time(() => folderMoveProblem(imported.folders, imported.folders[5].id, imported.folders[40].id))).toBeLessThan(200);
  });
});

describe("finding a folder by typing", () => {
  const folders = [
    folder("d", null, "Design"),
    folder("d1", "d", "Fonts"),
    folder("d2", "d", "Design systems"),
    folder("r", null, "Reading"),
    folder("r1", "r", "Redesigns"),
  ];
  const entries = folderEntries(folders, buildFolderPaths(folders));

  it("lists a folder named for the text before folders that only sit under one", () => {
    const names = rankFolders(entries, "design").matches.map((entry) => entry.folder.name);
    expect(names.slice(0, 2).sort()).toEqual(["Design", "Design systems"]);
    expect(names).toContain("Redesigns");
    expect(names.indexOf("Redesigns")).toBeLessThan(names.indexOf("Fonts"));
    expect(names[names.length - 1]).toBe("Fonts");
  });

  it("knows when a folder already has exactly that name, whatever the capitals", () => {
    expect(rankFolders(entries, "  fonts ").exact).toBe(true);
    expect(rankFolders(entries, "design / fonts").exact).toBe(true);
    expect(rankFolders(entries, "font").exact).toBe(false);
  });

  it("leaves out folders that cannot be chosen, and returns everything for an empty search", () => {
    const allowed = folderEntries(folders, buildFolderPaths(folders), new Set(["d", "d1", "d2"]));
    expect(allowed.map((entry) => entry.folder.id).sort()).toEqual(["r", "r1"]);
    expect(rankFolders(allowed, "").matches).toHaveLength(2);
  });

  it("searches ten thousand bookmarks' worth of folders well inside a keystroke", () => {
    const large = folderEntries(imported.folders, buildFolderPaths(imported.folders));
    expect(time(() => rankFolders(large, "l5"))).toBeLessThan(100);
  });
});
