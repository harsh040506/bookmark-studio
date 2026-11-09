/**
 * "The website and the extension should be one library, not two."
 *
 * Browsers give a website and an extension separate storage, so each keeps a copy and the
 * two swap changes over the bridge. These tests run two real databases (fake-indexeddb),
 * the real website-side client (`replicateOnce`) and the real service-worker handler
 * (`bridgeLibrary`), joined by a stand-in bridge that serialises every message to JSON the
 * way Chrome's messaging does.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bookmark } from "../../../shared/types";
import { decideRow } from "../replica";

type Db = typeof import("../db");

function row(id: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    url: `https://${id}.example/`,
    title: id,
    domain: `${id}.example`,
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

const wire = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** Two copies of the library, as the website and the extension would hold them. */
async function twoCopies() {
  // The extension's copy, with the real service-worker handler bound to it.
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  const ext: Db = await import("../db");
  await ext.localReplica();
  const host = await import("../../ext/bridge-host");

  const traffic = { pulls: 0 };
  // The website's copy, whose bridge reaches the handler above.
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  vi.doMock("../bridge", () => ({
    bridgeCall: async (op: string, payload: unknown) => {
      if (op === "library-pull") traffic.pulls += 1;
      return wire(await host.bridgeLibrary(op, wire(payload)));
    },
    onBridgeEvent: () => () => undefined,
  }));
  const web: Db = await import("../db");
  await web.localReplica();
  const { replicateOnce } = await import("../replication");

  /** Exchanges until there is nothing left to send, as the app's rounds do. */
  const exchange = async () => {
    for (let round = 0; round < 50 && (await replicateOnce()); round += 1);
  };
  return { ext, web, exchange, traffic, host };
}

afterEach(() => {
  vi.doUnmock("../bridge");
});

describe("a bookmark saved in one place", () => {
  it("appears in the extension after it was saved on the website", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putBookmarks([row("figma", { title: "Figma" })]);
    await exchange();
    expect((await ext.getBookmarks(["figma"]))[0]?.title).toBe("Figma");
  });

  it("appears on the website after it was saved in the extension", async () => {
    const { ext, web, exchange } = await twoCopies();
    await ext.putBookmarks([row("notion")]);
    await exchange();
    expect(await web.getBookmarks(["notion"])).toHaveLength(1);
  });

  it("arrives with its folder and board", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putFolders([{ id: "f1", name: "Design", parentId: null, addedAt: 1 }]);
    await web.putBoards([{ id: "b1", name: "Moodboard", createdAt: 1 } as never]);
    await web.putBookmarks([row("figma", { folderId: "f1", boardIds: ["b1"] })]);
    await exchange();
    const shell = await ext.loadShell();
    expect(shell.folders.map((folder) => folder.name)).toEqual(["Design"]);
    expect(shell.boards.map((board) => board.name)).toEqual(["Moodboard"]);
    expect((await ext.getBookmarks(["figma"]))[0]?.folderId).toBe("f1");
  });
});

describe("deleting", () => {
  it("removes the bookmark from the other copy too", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putBookmarks([row("old")]);
    await exchange();
    await ext.deleteBookmarks(["old"]);
    await exchange();
    expect(await web.getBookmarks(["old"])).toEqual([]);
  });

  it("does not bring the bookmark back on a later exchange", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putBookmarks([row("old")]);
    await exchange();
    await web.deleteBookmarks(["old"]);
    await exchange();
    await exchange();
    expect(await ext.getBookmarks(["old"])).toEqual([]);
    expect(await web.getBookmarks(["old"])).toEqual([]);
  });

  it("restoring a backup on one side removes what the backup did not have from the other", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putBookmarks([row("keep"), row("drop")]);
    await exchange();
    await web.replaceAll({ bookmarks: [row("keep")], folders: [], boards: [], imports: [], sources: [], smart: [] });
    await exchange();
    expect((await ext.loadSnapshot()).bookmarks.map((bookmark) => bookmark.id)).toEqual(["keep"]);
  });
});

describe("both sides changing the same bookmark before they next speak", () => {
  it("keeps a tag added in the extension and a description a page read found on the website", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putBookmarks([row("figma")]);
    await exchange();

    // In the extension, the person tags it.
    await ext.putBookmarks([row("figma", { tags: ["design"], changedAt: Date.now() })]);
    // A moment later, the website's background reader finishes with its older copy.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await web.putBookmarks([row("figma", { description: "Collaborative design", enriched: true })]);
    await exchange();

    for (const copy of [web, ext]) {
      const [figma] = await copy.getBookmarks(["figma"]);
      expect(figma?.tags).toEqual(["design"]);
      expect(figma?.description).toBe("Collaborative design");
      expect(figma?.enriched).toBe(true);
    }
  });

  it("settles: a second exchange changes nothing on either side", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putBookmarks([row("a"), row("b", { tags: ["x"], changedAt: 3 })]);
    await ext.putBookmarks([row("b", { description: "found", enriched: true }), row("c")]);
    await exchange();
    let writes = 0;
    const offWeb = web.onLibraryWrite(() => (writes += 1));
    const offExt = ext.onLibraryWrite(() => (writes += 1));
    await exchange();
    offWeb();
    offExt();
    expect(writes).toBe(0);
  });
});

describe("the same bookmarks imported on both sides before the extension was connected", () => {
  it("are merged by address instead of showing up twice", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putBookmarks([row("web-1", { url: "https://figma.com/", tags: ["work"] })]);
    await ext.putBookmarks([row("ext-1", { url: "https://figma.com/" })]);
    await exchange();
    const onWeb = (await web.loadSnapshot()).bookmarks.filter((bookmark) => bookmark.url === "https://figma.com/");
    const onExt = (await ext.loadSnapshot()).bookmarks.filter((bookmark) => bookmark.url === "https://figma.com/");
    expect(onWeb).toHaveLength(1);
    expect(onExt).toHaveLength(1);
    expect(onWeb[0]?.id).toBe(onExt[0]?.id);
    expect(onExt[0]?.tags).toEqual(["work"]);
  });

  it("keeps what each side added: tags from both, a favourite from either", async () => {
    // Written in both orders, so which import came last cannot decide what survives.
    for (const webFirst of [true, false]) {
      const { ext, web, exchange } = await twoCopies();
      const webRow = row("w", { url: "https://same.example/", tags: ["work"] });
      const extRow = row("e", { url: "https://same.example/", tags: ["design"], favorite: true });
      if (webFirst) {
        await web.putBookmarks([webRow]);
        await ext.putBookmarks([extRow]);
      } else {
        await ext.putBookmarks([extRow]);
        await web.putBookmarks([webRow]);
      }
      await exchange();
      for (const copy of [web, ext]) {
        const [merged] = (await copy.loadSnapshot()).bookmarks;
        expect(merged?.tags.sort()).toEqual(["design", "work"]);
        expect(merged?.favorite).toBe(true);
      }
    }
  });
});

describe("screenshots and offline copies", () => {
  it("stay with the copy that took them, so a card never points at a missing picture", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putBookmarks([
      row("shot", {
        preview: { method: "screenshot", shotAt: 5, shotDevice: "desktop" },
        offline: { assetKey: "image:offline:shot", capturedAt: 5, bytes: 10 },
      }),
    ]);
    await exchange();
    const [copy] = await ext.getBookmarks(["shot"]);
    expect(copy?.preview.shotAt).toBeUndefined();
    expect(copy?.offline).toBeUndefined();
    // The website keeps its own.
    expect((await web.getBookmarks(["shot"]))[0]?.preview.shotAt).toBe(5);
  });

  it("an uploaded file is not copied, because its bytes exist on one side only", async () => {
    const { ext, web, exchange } = await twoCopies();
    await web.putBookmarks([row("upload", { url: "", media: { assetKey: "k", mime: "image/png", bytes: 1, fileName: "a.png" } })]);
    await exchange();
    expect(await ext.getBookmarks(["upload"])).toEqual([]);
  });
});

describe("a large library", () => {
  it("copies over completely, page by page", async () => {
    const { ext, web, exchange, traffic } = await twoCopies();
    await web.putBookmarks(Array.from({ length: 1_200 }, (_, index) => row(`r${index}`)));
    await exchange();
    expect((await ext.loadSnapshot()).bookmarks).toHaveLength(1_200);
    expect(traffic.pulls).toBeGreaterThan(0);
    // 1,200 rows through the in-memory database take seconds alone and longer beside the
    // other test files, so the default 5 s limit fails on a busy machine, not on a bug.
  }, 30_000);
});

describe("what the extension accepts from a website", () => {
  it("refuses rows that are not ordinary web pages, and malformed stamps", async () => {
    const { ext, host } = await twoCopies();
    await host.bridgeLibrary("library-push", {
      from: "r_attacker",
      rows: [
        { row: row("js", { url: "javascript:alert(1)" }), stamp: { at: 1, by: "r_attacker" } },
        { row: row("nostamp"), stamp: { at: "soon" } },
        { row: { id: 7 }, stamp: { at: 1 } },
        { row: row("fine"), stamp: { at: 1, by: "r_attacker" } },
      ],
      tombstones: [{ store: "../../etc", id: "x", at: 1 }],
      shell: [{ store: "settings", record: { id: "s" }, stamp: { at: 1 } }],
    });
    expect((await ext.loadSnapshot()).bookmarks.map((bookmark) => bookmark.id)).toEqual(["fine"]);
  });

  it("will not answer without knowing who is asking", async () => {
    const { host } = await twoCopies();
    await expect(host.bridgeLibrary("library-pull", { cursor: null })).rejects.toThrow();
    await expect(host.bridgeLibrary("library-push", { rows: [] })).rejects.toThrow();
  });
});

describe("the merge rule on its own", () => {
  const stamp = (at: number, by = "a") => ({ at, by });

  it("takes the newer write when nobody changed anything by hand", () => {
    const decision = decideRow({ row: row("x", { title: "old" }), stamp: stamp(1) }, { row: row("x", { title: "new" }), stamp: stamp(2) });
    expect(decision).toMatchObject({ action: "take", row: { title: "new" } });
  });

  it("keeps a deletion that happened after the arriving change", () => {
    expect(decideRow(undefined, { row: row("x"), stamp: stamp(5) }, { at: 9 })).toEqual({ action: "keep" });
  });

  it("brings a bookmark back when it was changed after it was deleted (an undo)", () => {
    expect(decideRow(undefined, { row: row("x"), stamp: stamp(9) }, { at: 5 }).action).toBe("take");
  });

  it("does nothing when the arriving row says what this side already has", () => {
    expect(decideRow({ row: row("x"), stamp: stamp(1) }, { row: row("x"), stamp: stamp(2, "b") })).toEqual({ action: "keep" });
  });
});
