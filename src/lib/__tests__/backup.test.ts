/**
 * Backup round-trip and hostile-input coverage.
 *
 * The restore path is the only code in the app that can silently destroy a library: a
 * "replace" restore wipes what is there before writing what it parsed. These tests pin
 * down the two behaviours that make that safe — that a file which cannot be trusted
 * throws rather than yielding an empty snapshot, and that a file which can be trusted
 * survives the trip with its structure intact.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark, Board, ImportBatch } from "../../../shared/types";
import { BackupFormatError, mergeBackup, parseBackup } from "../backup";

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: "bmk_1",
    url: "https://example.com/a",
    title: "Example",
    domain: "example.com",
    description: "",
    category: "Reference",
    tags: ["one"],
    folderId: null,
    boardIds: [],
    addedAt: 1_700_000_000_000,
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
    ...overrides,
  };
}

function serialise(payload: {
  bookmarks?: unknown[];
  folders?: unknown[];
  boards?: Board[];
  imports?: unknown[];
  exportedAt?: number;
}): string {
  return JSON.stringify({
    exportedAt: payload.exportedAt ?? Date.now(),
    folders: payload.folders ?? [],
    boards: payload.boards ?? [],
    imports: payload.imports ?? [],
    bookmarks: payload.bookmarks ?? [],
  });
}

function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  return {
    id: "imp_1",
    name: "Work laptop, March",
    fileName: "bookmarks.html",
    at: 1_700_000_000_000,
    format: "html",
    mode: "merge",
    bookmarkCount: 2,
    folderCount: 1,
    duplicateCount: 0,
    ...overrides,
  };
}

describe("parseBackup", () => {
  it("round-trips a complete record without losing fields", () => {
    const original = bookmark({
      note: "why I saved this",
      favorite: true,
      tags: ["react", "docs"],
      health: { status: "dead", httpCode: 404, checkedAt: 5 },
      preview: { method: "screenshot", shotAt: 9 },
      meta: { siteName: "Example", fetchedAt: 3 },
      enriched: true,
    });

    const { bookmarks, skipped } = parseBackup(serialise({ bookmarks: [original] }));

    expect(skipped).toBe(0);
    expect(bookmarks[0]).toMatchObject({
      id: original.id,
      note: "why I saved this",
      favorite: true,
      tags: ["react", "docs"],
      enriched: true,
    });
    expect(bookmarks[0].health.status).toBe("dead");
    expect(bookmarks[0].preview.shotAt).toBe(9);
    expect(bookmarks[0].meta?.siteName).toBe("Example");
  });

  it("drops unusable entries and counts them rather than failing the restore", () => {
    const result = parseBackup(
      serialise({ bookmarks: [bookmark(), { title: "no url" }, null, 42] }),
    );
    expect(result.bookmarks).toHaveLength(1);
    expect(result.skipped).toBe(3);
  });

  it("defaults a record missing its nested objects instead of producing undefined reads", () => {
    const { bookmarks } = parseBackup(
      serialise({ bookmarks: [{ url: "https://example.org/x" }] }),
    );
    expect(bookmarks[0].health.status).toBe("unchecked");
    expect(bookmarks[0].preview.method).toBe("card");
    expect(bookmarks[0].domain).toBe("example.org");
    expect(bookmarks[0].tags).toEqual([]);
  });

  it("rejects an out-of-range status rather than trusting the file", () => {
    const { bookmarks } = parseBackup(
      serialise({ bookmarks: [{ url: "https://x.com/", health: { status: "banana" } }] }),
    );
    expect(bookmarks[0].health.status).toBe("unchecked");
  });

  it("clears references to folders and boards the file does not carry", () => {
    const { bookmarks } = parseBackup(
      serialise({
        bookmarks: [bookmark({ folderId: "missing", boardIds: ["gone", "kept"] })],
        boards: [{ id: "kept", name: "Kept", color: "#000", createdAt: 1 }],
      }),
    );
    expect(bookmarks[0].folderId).toBeNull();
    expect(bookmarks[0].boardIds).toEqual(["kept"]);
  });

  it("reparents a folder whose parent is absent", () => {
    const { folders } = parseBackup(
      serialise({
        bookmarks: [bookmark()],
        folders: [{ id: "f1", name: "Orphan", parentId: "nowhere", addedAt: 1 }],
      }),
    );
    expect(folders[0].parentId).toBeNull();
  });

  /**
   * The fields that used to vanish on a round trip.
   *
   * None of these produced an error, which is what made the loss worth pinning down: a
   * restored library simply forgot the arrangement the user had built. `sourceOrder` is
   * what "As imported" sorts on and what draws the folder tree, `importedAt` is what
   * "Recently added" measures against — browser timestamps are routinely years old, so
   * without it that view is permanently empty — and `importId` is the thread tying a row
   * to the batch it arrived in, and to the undo that can remove that batch wholesale.
   */
  it("preserves ordering and provenance through a round trip", () => {
    const original = bookmark({
      sourceOrder: 42,
      importId: "imp_1",
      importedAt: 1_700_000_500_000,
      preview: { method: "screenshot", shotAt: 9, shotDevice: "mobile" },
    });

    const { bookmarks, imports } = parseBackup(
      serialise({ bookmarks: [original], imports: [batch()] }),
    );

    expect(bookmarks[0].sourceOrder).toBe(42);
    expect(bookmarks[0].importId).toBe("imp_1");
    expect(bookmarks[0].importedAt).toBe(1_700_000_500_000);
    expect(bookmarks[0].preview.shotDevice).toBe("mobile");
    expect(imports).toHaveLength(1);
    expect(imports[0].name).toBe("Work laptop, March");
  });

  it("keeps a folder's position in the file it came from", () => {
    const { folders } = parseBackup(
      serialise({
        bookmarks: [bookmark()],
        folders: [
          { id: "f1", name: "Design", parentId: null, addedAt: 1, sourceOrder: 7, importId: "imp_1" },
        ],
        imports: [batch()],
      }),
    );

    expect(folders[0].sourceOrder).toBe(7);
    expect(folders[0].importId).toBe("imp_1");
  });

  it("rejects a viewport name the app does not recognise", () => {
    const { bookmarks } = parseBackup(
      serialise({
        bookmarks: [{ url: "https://x.com/", preview: { method: "screenshot", shotDevice: "watch" } }],
      }),
    );
    expect(bookmarks[0].preview.shotDevice).toBeUndefined();
  });

  /**
   * An id pointing at a batch the file does not carry is worse than no id: the row is
   * counted in the total but belongs to an import that can never be opened or removed.
   * The timestamp is kept, because "when this entered a library" is still true of it.
   */
  it("clears an import reference the file does not carry, but keeps the arrival time", () => {
    const { bookmarks } = parseBackup(
      serialise({
        bookmarks: [bookmark({ importId: "imp_gone", importedAt: 1_700_000_500_000 })],
      }),
    );

    expect(bookmarks[0].importId).toBeUndefined();
    expect(bookmarks[0].importedAt).toBe(1_700_000_500_000);
  });

  it("drops an import batch with no id, which nothing could ever reference", () => {
    const { imports } = parseBackup(
      serialise({ bookmarks: [bookmark()], imports: [batch(), { name: "nameless" }] }),
    );
    expect(imports).toHaveLength(1);
  });

  it("reads a backup written before batches were carried", () => {
    const parsed = parseBackup(
      JSON.stringify({ exportedAt: 1, folders: [], boards: [], bookmarks: [bookmark()] }),
    );
    expect(parsed.imports).toEqual([]);
  });

  it("throws on input that is not JSON", () => {
    expect(() => parseBackup("<html></html>")).toThrow(BackupFormatError);
  });

  it("throws on JSON with no bookmarks array, so a replace cannot wipe a library", () => {
    expect(() => parseBackup(JSON.stringify({ exportedAt: 1 }))).toThrow(BackupFormatError);
  });

  it("throws when every entry was unusable", () => {
    expect(() => parseBackup(serialise({ bookmarks: [{ nope: true }] }))).toThrow(
      BackupFormatError,
    );
  });
});

describe("mergeBackup", () => {
  it("updates rows in place by id rather than duplicating them", () => {
    const existing = bookmark({ title: "Old title" });
    const restored = parseBackup(serialise({ bookmarks: [bookmark({ title: "New title" })] }));

    const merged = mergeBackup(restored, { bookmarks: [existing], folders: [], boards: [] });

    expect(merged.bookmarks).toHaveLength(1);
    expect(merged.bookmarks[0].title).toBe("New title");
    expect(merged.updated).toBe(1);
    expect(merged.added).toBe(0);
  });

  it("keeps rows the backup does not mention", () => {
    const untouched = bookmark({ id: "bmk_other", url: "https://other.com/" });
    const restored = parseBackup(serialise({ bookmarks: [bookmark()] }));

    const merged = mergeBackup(restored, { bookmarks: [untouched], folders: [], boards: [] });

    expect(merged.bookmarks).toHaveLength(2);
    expect(merged.added).toBe(1);
  });

  it("re-establishes the import rail without stacking duplicate batches", () => {
    const restored = parseBackup(
      serialise({ bookmarks: [bookmark({ importId: "imp_1" })], imports: [batch()] }),
    );

    const merged = mergeBackup(restored, {
      bookmarks: [],
      folders: [],
      boards: [],
      // The same batch is already present — restoring a backup over the library it came
      // from must update the row, not add a second one beside it.
      imports: [batch({ name: "stale name" })],
    });

    expect(merged.imports).toHaveLength(1);
    expect(merged.imports[0].name).toBe("Work laptop, March");
  });

  it("keeps batches the restore does not mention", () => {
    const restored = parseBackup(serialise({ bookmarks: [bookmark()] }));

    const merged = mergeBackup(restored, {
      bookmarks: [],
      folders: [],
      boards: [],
      imports: [batch({ id: "imp_other" })],
    });

    expect(merged.imports.map((entry) => entry.id)).toEqual(["imp_other"]);
  });
});
