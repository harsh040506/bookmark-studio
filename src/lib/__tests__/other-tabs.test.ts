/**
 * "A link I add should show up in my other open tab straight away."
 *
 * The other tab is told which rows changed and reads just those. It used to re-read the
 * whole library for every change, often before the write had landed, so new rows were
 * missed until a reload. The announcement now waits for the write; these tests cover the
 * read side: the changed rows come back, repaired, and nothing else is scanned.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookmark } from "../../../shared/types";

type Db = typeof import("../db");
let db: Db;

function row(id: string, title = id): Bookmark {
  return {
    id,
    url: `https://${id}.example/`,
    title,
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
  };
}

beforeEach(async () => {
  vi.resetModules();
  // A fresh database per test, so rows cannot leak between cases.
  const { IDBFactory } = await import("fake-indexeddb");
  globalThis.indexedDB = new IDBFactory();
  db = await import("../db");
});

describe("a bookmark added in another tab", () => {
  it("can be read by id as soon as its write has finished", async () => {
    await db.putBookmarks([row("new", "Just added")]);
    const [found] = await db.getBookmarks(["new"]);
    expect(found?.title).toBe("Just added");
  });

  it("reads only the rows that changed", async () => {
    await db.putBookmarks([row("a"), row("b"), row("c")]);
    const found = await db.getBookmarks(["b"]);
    expect(found.map((bookmark) => bookmark.id)).toEqual(["b"]);
  });

  it("skips a row that was deleted before the other tab looked", async () => {
    await db.putBookmarks([row("gone")]);
    await db.deleteBookmarks(["gone"]);
    expect(await db.getBookmarks(["gone", "never-existed"])).toEqual([]);
  });

  it("ignores ids that are not strings, rather than failing the whole read", async () => {
    await db.putBookmarks([row("ok")]);
    const found = await db.getBookmarks(["ok", 7 as unknown as string, null as unknown as string]);
    expect(found.map((bookmark) => bookmark.id)).toEqual(["ok"]);
  });

  it("repairs a damaged row on the way in instead of passing it on", async () => {
    await db.putBookmarks([{ ...row("odd"), tags: "not-a-list" as unknown as string[] }]);
    const [found] = await db.getBookmarks(["odd"]);
    expect(Array.isArray(found?.tags)).toBe(true);
  });
});
