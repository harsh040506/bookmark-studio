/**
 * Two-way sync with the browser's bookmarks, at the size where its mistakes show.
 *
 * Three things went wrong quietly at ten thousand bookmarks and are pinned here:
 *
 * - comparing the tree on every open rewrote every bookmark, sent all of them to the other
 *   copy of the library and stamped each as changed by the person just now;
 * - the browser's events were applied one at a time, each rebuilding the whole library;
 * - changes sent to the browser all left in the same instant, so the marks that recognise
 *   the browser's echoes expired before the browser had worked through them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookmark, Folder } from "../../../shared/types";
import type { BookmarksApi } from "../bookmarks-api";
import { PendingChanges } from "../pending-changes";

type Node = chrome.bookmarks.BookmarkTreeNode;

/** A stand-in for `chrome.bookmarks`: a tree, recorded calls, and events fired by hand. */
function fakeBrowser() {
  const event = <T extends (...args: never[]) => void>() => {
    const listeners = new Set<T>();
    return {
      addListener: (listener: T) => void listeners.add(listener),
      removeListener: (listener: T) => void listeners.delete(listener),
      fire: (...args: Parameters<T>) => {
        for (const listener of listeners) (listener as (...a: Parameters<T>) => void)(...args);
      },
    };
  };
  const state = {
    tree: [] as Node[],
    inFlight: 0,
    mostInFlight: 0,
    moves: [] as string[],
    failMoves: new Set<string>(),
    missing: new Set<string>(),
    hold: null as Promise<void> | null,
  };
  const tracked = async <T>(work: () => T): Promise<T> => {
    state.inFlight += 1;
    state.mostInFlight = Math.max(state.mostInFlight, state.inFlight);
    try {
      if (state.hold) await state.hold;
      else await Promise.resolve();
      return work();
    } finally {
      state.inFlight -= 1;
    }
  };
  const api = {
    getTree: async () => state.tree,
    create: async (details: { title?: string; url?: string }) => ({ id: "new", title: details.title ?? "", url: details.url }) as Node,
    update: (id: string) => tracked(() => ({ id, title: "" }) as Node),
    move: (id: string) =>
      tracked(() => {
        if (state.missing.has(id)) throw new Error("Can't find bookmark for id.");
        if (state.failMoves.has(id)) throw new Error("Bookmarks are locked");
        state.moves.push(id);
        return { id, title: "" } as Node;
      }),
    remove: (id: string) => tracked(() => void id),
    removeTree: (id: string) => tracked(() => void id),
    onCreated: event<(id: string, node: Node) => void>(),
    onRemoved: event<(id: string, info: chrome.bookmarks.BookmarkRemoveInfo) => void>(),
    onChanged: event<(id: string, info: chrome.bookmarks.BookmarkChangeInfo) => void>(),
    onMoved: event<(id: string, info: chrome.bookmarks.BookmarkMoveInfo) => void>(),
    onChildrenReordered: event<(id: string, info: chrome.bookmarks.BookmarkReorderInfo) => void>(),
    onImportBegan: event<() => void>(),
    onImportEnded: event<() => void>(),
  };
  return { api, state };
}

const browser = fakeBrowser();
vi.mock("../bookmarks-api", () => ({ bookmarksApi: () => browser.api as unknown as BookmarksApi }));

const sync = await import("../chrome-bookmarks");

const BOOKMARKS = 10_000;
const DEPTH = 8;

// Real work on ten thousand rows; the budgets inside the tests are what is being checked.
vi.setConfig({ testTimeout: 60_000 });

/** Chrome's tree: an invisible root, the bar and "Other", and links nested `DEPTH` deep. */
function browserTree(): Node[] {
  let next = 100;
  let links = 0;
  // The bar is the first level, so the folders grown under it fill levels two to eight.
  const perFolder = Math.ceil(BOOKMARKS / (2 ** (DEPTH - 1) - 1));
  const grow = (depth: number, parentId: string): Node => {
    const id = String(next++);
    const children: Node[] = [];
    for (let link = 0; link < perFolder && links < BOOKMARKS; link += 1) {
      const linkId = String(next++);
      children.push({ id: linkId, parentId: id, index: link, title: `Page ${links}`, url: `https://example.com/${links}` });
      links += 1;
    }
    if (depth < DEPTH) for (let branch = 0; branch < 2; branch += 1) children.push(grow(depth + 1, id));
    return { id, parentId, index: 0, title: `Folder ${id}`, children };
  };
  const bar: Node = { id: "1", parentId: "0", index: 0, title: "Bookmarks bar", children: [grow(2, "1")] };
  const other: Node = { id: "2", parentId: "0", index: 1, title: "Other bookmarks", children: [] };
  return [{ id: "0", title: "", children: [bar, other] }];
}

function library(result: { bookmarks: Bookmark[]; folders: Folder[] }) {
  return () => ({ bookmarks: result.bookmarks, folders: result.folders });
}

beforeEach(() => {
  sync.allowBrowserSync(true);
  browser.state.tree = browserTree();
  browser.state.inFlight = 0;
  browser.state.mostInFlight = 0;
  browser.state.moves = [];
  browser.state.failMoves.clear();
  browser.state.missing.clear();
  browser.state.hold = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("comparing the browser's tree with the library", () => {
  it("reads ten thousand bookmarks nested eight deep", async () => {
    const started = performance.now();
    const first = await sync.reconcile(() => ({ bookmarks: [], folders: [] }));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(first.bookmarks).toHaveLength(BOOKMARKS);
    expect(first.changedBookmarks).toHaveLength(BOOKMARKS);
    expect(first.changedFolders).toHaveLength(first.folders.length);
    // The fixed top-level folders are folders; the invisible root is not.
    expect(first.folders.find((entry) => entry.id === "1")?.parentId).toBeNull();
    expect(first.folders.some((entry) => entry.id === "0")).toBe(false);
    expect(first.bookmarks.every((row) => row.folderId && row.sourceId === sync.CHROME_SOURCE_ID)).toBe(true);
  });

  it("writes nothing when nothing changed", async () => {
    const first = await sync.reconcile(() => ({ bookmarks: [], folders: [] }));
    const second = await sync.reconcile(library(first));
    expect(second.changedBookmarks).toEqual([]);
    expect(second.changedFolders).toEqual([]);
    expect(second.removedBookmarkIds).toEqual([]);
    // The very same objects, so nothing downstream sees a new row to save or send.
    expect(second.bookmarks[0]).toBe(first.bookmarks[0]);
    expect(second.folders[0]).toBe(first.folders[0]);
  });

  it("reports only the bookmark and the folder that did change", async () => {
    const first = await sync.reconcile(() => ({ bookmarks: [], folders: [] }));
    const bar = browser.state.tree[0].children![0];
    const top = bar.children![0];
    const link = top.children!.find((child) => child.url)!;
    link.title = "Renamed in the browser";
    top.title = "Renamed folder";

    const second = await sync.reconcile(library(first));
    expect(second.changedBookmarks.map((row) => row.title)).toEqual(["Renamed in the browser"]);
    expect(second.changedFolders.map((entry) => entry.name)).toEqual(["Renamed folder"]);
  });

  it("keeps a title the person wrote here over the browser's", async () => {
    const first = await sync.reconcile(() => ({ bookmarks: [], folders: [] }));
    const edited = { ...first.bookmarks[0], title: "My own title", editedAt: 5 };
    const second = await sync.reconcile(library({ bookmarks: [edited, ...first.bookmarks.slice(1)], folders: first.folders }));
    expect(second.changedBookmarks).toEqual([]);
  });

  it("notices bookmarks deleted in the browser while the app was closed", async () => {
    const first = await sync.reconcile(() => ({ bookmarks: [], folders: [] }));
    const top = browser.state.tree[0].children![0].children![0];
    const gone = top.children!.find((child) => child.url)!;
    top.children = top.children!.filter((child) => child !== gone);
    const second = await sync.reconcile(library(first));
    expect(second.removedBookmarkIds).toEqual([gone.id]);
  });

  it("compares with the library as it is after the tree arrives, not before", async () => {
    const first = await sync.reconcile(() => ({ bookmarks: [], folders: [] }));
    let reads = 0;
    const original = browser.api.getTree;
    browser.api.getTree = async () => {
      expect(reads).toBe(0);
      return browser.state.tree;
    };
    await sync.reconcile(() => {
      reads += 1;
      return { bookmarks: first.bookmarks, folders: first.folders };
    });
    browser.api.getTree = original;
    // Read again at the end, for what is still filed where; never before the tree.
    expect(reads).toBeGreaterThanOrEqual(1);
  });

  it("walks a tree far deeper than the stack", async () => {
    let node: Node = { id: "leaf", index: 0, title: "Bottom", url: "https://example.com/bottom" };
    for (let level = 0; level < 20_000; level += 1) node = { id: `f${level}`, index: 0, title: `f${level}`, children: [node] };
    browser.state.tree = [{ id: "0", title: "", children: [node] }];
    const result = await sync.reconcile(() => ({ bookmarks: [], folders: [] }));
    expect(result.folders).toHaveLength(20_000);
    expect(result.bookmarks.map((row) => row.title)).toEqual(["Bottom"]);
  });

  it("refuses a reply that is not a tree instead of emptying the library", async () => {
    browser.state.tree = [] as Node[];
    await expect(sync.reconcile(() => ({ bookmarks: [], folders: [] }))).rejects.toThrow();
    browser.state.tree = [null as unknown as Node];
    await expect(sync.reconcile(() => ({ bookmarks: [], folders: [] }))).rejects.toThrow();
  });
});

describe("folders deleted in the browser while the app was closed", () => {
  const old = 1_000;
  const now = 10_000_000;
  const f = (id: string, parentId: string | null = null, extra: Partial<Folder> = {}): Folder => ({
    id,
    name: id,
    parentId,
    addedAt: old,
    ...extra,
  });

  it("removes a browser folder that is gone from the tree and holds nothing", () => {
    const folders = [f("1"), f("77", "1"), f("78", "77")];
    expect(sync.vanishedBrowserFolders(folders, new Set(["1"]), new Set(), now).sort()).toEqual(["77", "78"]);
  });

  it("keeps a folder that still holds a bookmark, and every folder above it", () => {
    const folders = [f("1"), f("77", "1"), f("78", "77"), f("79", "77")];
    const removed = sync.vanishedBrowserFolders(folders, new Set(["1"]), new Set(["78"]), now);
    expect(removed).toEqual(["79"]);
  });

  it("never touches folders made here or by an import, or ones the browser still has", () => {
    const folders = [f("1"), f("fld_abc_1"), f("55", null, { importId: "imp_1" }), f("60", "1")];
    expect(sync.vanishedBrowserFolders(folders, new Set(["1", "60"]), new Set(), now)).toEqual([]);
  });

  it("leaves alone a folder made a moment ago, which the tree may not show yet", () => {
    const folders = [f("90", null, { addedAt: now - 5_000 })];
    expect(sync.vanishedBrowserFolders(folders, new Set(), new Set(), now)).toEqual([]);
  });

  it("does not hang or remove anything for folders that name each other as parent", () => {
    const folders = [f("70", "71"), f("71", "70")];
    expect(sync.vanishedBrowserFolders(folders, new Set(), new Set(), now)).toEqual([]);
  });

  it("handles a chain far deeper than the stack", () => {
    const folders: Folder[] = [];
    for (let position = 0; position < 20_000; position += 1) folders.push(f(String(1000 + position), position ? String(999 + position) : null));
    expect(sync.vanishedBrowserFolders(folders, new Set(), new Set(), now)).toHaveLength(20_000);
  });

  it("reports them when the tree is compared, along with the bookmarks that went with them", async () => {
    const first = await sync.reconcile(() => ({ bookmarks: [], folders: [] }));
    const aged = first.folders.map((entry) => ({ ...entry, addedAt: 1 }));
    // Delete one whole branch in the browser.
    const top = browser.state.tree[0].children![0].children![0];
    const branch = top.children!.find((child) => !child.url)!;
    top.children = top.children!.filter((child) => child !== branch);

    const second = await sync.reconcile(() => ({ bookmarks: first.bookmarks, folders: aged }));
    expect(second.removedFolderIds).toContain(branch.id);
    expect(second.removedFolderIds.length).toBeGreaterThan(1);
    expect(second.removedBookmarkIds.length).toBeGreaterThan(0);
    // Nothing that is still in the browser is removed.
    const stillThere = new Set(second.folders.map((entry) => entry.id));
    expect(second.removedFolderIds.some((id) => stillThere.has(id))).toBe(false);
  });

  it("removes nothing when the tree is unchanged", async () => {
    const first = await sync.reconcile(() => ({ bookmarks: [], folders: [] }));
    const aged = first.folders.map((entry) => ({ ...entry, addedAt: 1 }));
    const second = await sync.reconcile(() => ({ bookmarks: first.bookmarks, folders: aged }));
    expect(second.removedFolderIds).toEqual([]);
  });
});

describe("changes sent to the browser", () => {
  it("never sends more than a few at once, however many are asked for", async () => {
    let release = () => undefined as void;
    browser.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const all = Promise.all(Array.from({ length: 2_000 }, (_, position) => sync.moveBookmarkNode(`m${position}`, "1")));
    await Promise.resolve();
    expect(browser.state.inFlight).toBeGreaterThan(0);
    expect(browser.state.inFlight).toBeLessThanOrEqual(6);
    release();
    browser.state.hold = null;
    const results = await all;
    expect(results.every(Boolean)).toBe(true);
    expect(browser.state.moves).toHaveLength(2_000);
    expect(browser.state.mostInFlight).toBeLessThanOrEqual(6);
  });

  it("says when the browser refused a move, and treats a bookmark the browser never had as safe", async () => {
    browser.state.failMoves.add("locked");
    browser.state.missing.add("imported");
    expect(await sync.moveBookmarkNode("fine", "1")).toBe(true);
    expect(await sync.moveBookmarkNode("locked", "1")).toBe(false);
    expect(await sync.moveBookmarkNode("imported", "1")).toBe(true);
  });

  it("tells whoever is listening that a change did not reach the browser", async () => {
    const heard: string[] = [];
    const stop = sync.onMirrorFailure((operation) => heard.push(operation));
    browser.state.failMoves.add("locked");
    await sync.moveBookmarkNode("locked", "1");
    stop();
    expect(heard).toEqual(["move"]);
  });
});

describe("changes made in the browser", () => {
  function listen(rows: Bookmark[], folders: Folder[]) {
    const pendingRows = new PendingChanges<Bookmark>();
    const pendingFolders = new PendingChanges<Folder>();
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const folderById = new Map(folders.map((entry) => [entry.id, entry]));
    let bulk = 0;
    const stop = sync.startSync({
      onBookmarkCreated: (row) => pendingRows.create(row),
      onBookmarkPatched: (id, patch) => pendingRows.patch(id, patch),
      onBookmarkRemoved: (ids) => pendingRows.remove(ids),
      onFolderCreated: (entry) => pendingFolders.create(entry),
      onFolderPatched: (id, patch) => pendingFolders.patch(id, patch),
      onFolderRemoved: (ids) => pendingFolders.remove(ids),
      onBulkChange: () => void (bulk += 1),
      findBookmark: (id) => pendingRows.find(id, (key) => rowById.get(key)),
      findFolder: (id) => pendingFolders.find(id, (key) => folderById.get(key)),
    });
    return {
      stop,
      rows: () => pendingRows.take((key) => rowById.get(key)),
      folders: () => pendingFolders.take((key) => folderById.get(key)),
      bulk: () => bulk,
    };
  }

  const row = (id: string, extra: Partial<Bookmark> = {}): Bookmark => ({
    id,
    url: `https://example.com/${id}`,
    title: id,
    domain: "example.com",
    description: "",
    category: "Other",
    tags: [],
    folderId: "1",
    boardIds: [],
    addedAt: 1,
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
    ...extra,
  });

  it("gathers a burst of ten thousand new bookmarks into one change", () => {
    const listening = listen([], [{ id: "1", name: "Bookmarks bar", parentId: null, addedAt: 1 }]);
    const started = performance.now();
    for (let position = 0; position < BOOKMARKS; position += 1) {
      browser.api.onCreated.fire(`n${position}`, {
        id: `n${position}`,
        parentId: "1",
        index: position,
        title: `New ${position}`,
        url: `https://example.com/new/${position}`,
      });
    }
    expect(performance.now() - started).toBeLessThan(5_000);
    const { upserts, removals } = listening.rows();
    listening.stop();
    expect(upserts).toHaveLength(BOOKMARKS);
    expect(removals).toEqual([]);
    expect(upserts[0].folderId).toBe("1");
  });

  it("reports a move as the fields that changed, so a newer edit here is not overwritten", () => {
    const listening = listen([row("a", { tags: ["kept"] })], [folder("1"), folder("9")]);
    browser.api.onMoved.fire("a", { parentId: "9", index: 3, oldParentId: "1", oldIndex: 0 });
    const { upserts } = listening.rows();
    listening.stop();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ folderId: "9", sourceOrder: 3, tags: ["kept"] });
  });

  it("ignores a move that changes nothing", () => {
    const listening = listen([row("a", { sourceOrder: 0 })], [folder("1")]);
    browser.api.onMoved.fire("a", { parentId: "1", index: 0, oldParentId: "1", oldIndex: 0 });
    expect(listening.rows().upserts).toEqual([]);
    listening.stop();
  });

  it("never deletes a bookmark that is in the trash here because the browser removed it", () => {
    const listening = listen([row("binned", { trashedAt: 5 })], [folder("1")]);
    browser.api.onRemoved.fire("binned", { parentId: "1", index: 0, node: { id: "binned", title: "x", url: "https://example.com/" } });
    expect(listening.rows().removals).toEqual([]);
    listening.stop();
  });

  it("removes a folder with everything the browser says was in it", () => {
    const listening = listen([row("a", { folderId: "9" })], [folder("1"), folder("9"), folder("10", "9")]);
    browser.api.onRemoved.fire("9", {
      parentId: "1",
      index: 0,
      node: { id: "9", title: "Gone", children: [{ id: "a", title: "a", url: "https://example.com/a" }, { id: "10", title: "Sub", children: [] }] },
    });
    expect(listening.rows().removals).toEqual(["a"]);
    expect(listening.folders().removals.sort()).toEqual(["10", "9"]);
    listening.stop();
  });

  it("will not make a folder its own parent", () => {
    const listening = listen([], [folder("9")]);
    browser.api.onMoved.fire("9", { parentId: "9", index: 0, oldParentId: "1", oldIndex: 0 });
    expect(listening.folders().upserts).toEqual([]);
    listening.stop();
  });

  it("survives events with nothing usable in them", () => {
    const listening = listen([row("a")], [folder("1")]);
    expect(() => {
      browser.api.onCreated.fire("x", null as unknown as Node);
      browser.api.onChanged.fire("a", null as unknown as chrome.bookmarks.BookmarkChangeInfo);
      browser.api.onMoved.fire("a", {} as chrome.bookmarks.BookmarkMoveInfo);
      browser.api.onChildrenReordered.fire("1", {} as chrome.bookmarks.BookmarkReorderInfo);
      browser.api.onRemoved.fire("zzz", undefined as unknown as chrome.bookmarks.BookmarkRemoveInfo);
    }).not.toThrow();
    listening.stop();
  });

  it("holds events during the browser's own import and asks for one full comparison after", () => {
    const listening = listen([], [folder("1")]);
    browser.api.onImportBegan.fire();
    browser.api.onCreated.fire("n1", { id: "n1", parentId: "1", index: 0, title: "n1", url: "https://example.com/n1" });
    browser.api.onImportEnded.fire();
    expect(listening.rows().upserts).toEqual([]);
    expect(listening.bulk()).toBe(1);
    listening.stop();
  });

  function folder(id: string, parentId: string | null = null): Folder {
    return { id, name: `Folder ${id}`, parentId, addedAt: 1 };
  }
});

describe("changes waiting to be applied together", () => {
  interface Item {
    id: string;
    name: string;
    place?: string;
  }
  const none = () => undefined;

  it("applies later changes on top of earlier ones", () => {
    const pending = new PendingChanges<Item>();
    pending.create({ id: "a", name: "first" });
    pending.patch("a", { name: "second" });
    pending.patch("a", { place: "here" });
    expect(pending.find("a", none)).toEqual({ id: "a", name: "second", place: "here" });
    expect(pending.take(none)).toEqual({ upserts: [{ id: "a", name: "second", place: "here" }], removals: [] });
    expect(pending.empty).toBe(true);
  });

  it("does not replace a record the app already made itself, but still applies changes to it", () => {
    const stored = new Map<string, Item>([["a", { id: "a", name: "the person's own", place: "chosen" }]]);
    const pending = new PendingChanges<Item>();
    pending.create({ id: "a", name: "the browser's echo" });
    expect(pending.take((id) => stored.get(id)).upserts).toEqual([]);

    pending.create({ id: "a", name: "the browser's echo" });
    pending.patch("a", { place: "moved" });
    expect(pending.take((id) => stored.get(id)).upserts).toEqual([{ id: "a", name: "the person's own", place: "moved" }]);
  });

  it("applies a change to the record as it is when the batch is taken", () => {
    const stored = new Map<string, Item>([["a", { id: "a", name: "old" }]]);
    const pending = new PendingChanges<Item>();
    pending.patch("a", { place: "moved" });
    // The person renames it before the batch runs.
    stored.set("a", { id: "a", name: "renamed meanwhile" });
    expect(pending.take((id) => stored.get(id)).upserts).toEqual([{ id: "a", name: "renamed meanwhile", place: "moved" }]);
  });

  it("drops what a removal makes pointless, and removals of things that are not stored", () => {
    const stored = new Map<string, Item>([["kept", { id: "kept", name: "k" }]]);
    const pending = new PendingChanges<Item>();
    pending.create({ id: "new", name: "n" });
    pending.patch("kept", { name: "changed" });
    pending.remove(["new", "kept", "never-existed"]);
    expect(pending.find("kept", (id) => stored.get(id))).toBeUndefined();
    expect(pending.take((id) => stored.get(id))).toEqual({ upserts: [], removals: ["kept"] });
  });

  it("ignores a change for a record nobody has", () => {
    const pending = new PendingChanges<Item>();
    pending.patch("ghost", { name: "x" });
    expect(pending.take(none)).toEqual({ upserts: [], removals: [] });
  });
});
