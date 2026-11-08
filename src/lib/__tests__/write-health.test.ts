/**
 * Saving changes when the device refuses them.
 *
 * Edits reach the screen before the disk, so a failed write used to vanish on the next
 * reload with nobody told. These tests make writes fail the way real browsers do (a full
 * disk, a connection closed by another tab) and check that the change is remembered,
 * reported once, retried, and that an older failure can never overwrite a newer change.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookmark } from "../../../shared/types";

type Db = typeof import("../db");
let db: Db;

function row(id: string, title: string): Bookmark {
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
  } as unknown as Bookmark;
}

function quotaError(): DOMException {
  return new DOMException("The quota has been exceeded.", "QuotaExceededError");
}

async function stored(id: string): Promise<Bookmark | undefined> {
  const snapshot = await db.loadSnapshot();
  return snapshot.bookmarks.find((bookmark) => bookmark.id === id);
}

beforeEach(async () => {
  vi.resetModules();
  db = await import("../db");
  await db.clearLibrary();
  db.resetWriteHealth();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("write health", () => {
  it("remembers a change the disk refused, and says why", async () => {
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw quotaError();
    });
    const failure = await db.putBookmarks([row("a", "First")]).catch((error: unknown) => error);

    expect(db.isReported(failure)).toBe(true);
    expect(db.writeHealth()).toMatchObject({ unsaved: 1, failure: "quota" });
  });

  it("writes the remembered change once the disk has room again", async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw quotaError();
    });
    await db.putBookmarks([row("a", "First")]).catch(() => undefined);
    put.mockRestore();

    await expect(db.retryUnsaved()).resolves.toBe(true);
    expect(db.writeHealth().unsaved).toBe(0);
    expect((await stored("a"))?.title).toBe("First");
  });

  it("never lets an older failed change overwrite a newer saved one", async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw quotaError();
    });
    await db.putBookmarks([row("a", "Old")]).catch(() => undefined);
    put.mockRestore();

    await db.putBookmarks([row("a", "New")]);
    expect(db.writeHealth().unsaved).toBe(0);
    await db.retryUnsaved();
    expect((await stored("a"))?.title).toBe("New");
  });

  it("keeps the latest intent when a delete fails after an edit", async () => {
    await db.putBookmarks([row("a", "Kept")]);
    const remove = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(() => {
      throw quotaError();
    });
    await db.deleteBookmarks(["a"]).catch(() => undefined);
    remove.mockRestore();

    expect(db.writeHealth().unsaved).toBe(1);
    await db.retryUnsaved();
    expect(await stored("a")).toBeUndefined();
  });

  it("notifies listeners when changes go unsaved and when they recover", async () => {
    const seen: number[] = [];
    const stop = db.subscribeWriteHealth((health) => seen.push(health.unsaved));
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw quotaError();
    });
    await db.putBookmarks([row("a", "x"), row("b", "y")]).catch(() => undefined);
    put.mockRestore();
    await db.retryUnsaved();
    stop();

    expect(seen).toContain(2);
    expect(seen[seen.length - 1]).toBe(0);
  });

  it("retries a write that hits a closed connection instead of failing it", async () => {
    const original = IDBDatabase.prototype.transaction;
    let calls = 0;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      calls += 1;
      if (calls === 1) throw new DOMException("The database connection is closing.", "InvalidStateError");
      return original.apply(this, args as Parameters<IDBDatabase["transaction"]>);
    });

    await db.putBookmarks([row("a", "Saved")]);
    expect(db.writeHealth().unsaved).toBe(0);
    expect((await stored("a"))?.title).toBe("Saved");
  });

  it("does not retry a full disk, so the person hears about it at once", async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw quotaError();
    });
    await db.putBookmarks([row("a", "x")]).catch(() => undefined);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
