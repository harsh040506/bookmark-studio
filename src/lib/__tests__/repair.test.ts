/**
 * Records read back from storage that do not match today's types.
 *
 * One malformed row used to be enough to crash every page load, which looks exactly like a
 * lost library. The repair keeps the data and fixes the shape.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../../shared/types";
import { repairBookmark, repairFolders, repairSettings, type RepairReport } from "../repair";

const fresh = (): RepairReport => ({ repaired: 0, dropped: 0 });

describe("repairBookmark", () => {
  it("fills in every field the interface reads without checking", () => {
    const report = fresh();
    const row = repairBookmark({ id: "a", url: "https://a.example/", tags: null, health: "bad", preview: 3 }, report);
    expect(row).not.toBeNull();
    expect(row?.tags).toEqual([]);
    expect(row?.boardIds).toEqual([]);
    expect(row?.health).toEqual({ status: "unchecked" });
    expect(row?.preview.method).toBe("card");
    expect(row?.title).toBe("https://a.example/");
    expect(row?.folderId).toBeNull();
    expect(Number.isFinite(row?.addedAt)).toBe(true);
    expect(report.repaired).toBe(1);
  });

  it("drops only what cannot be identified", () => {
    const report = fresh();
    expect(repairBookmark(null, report)).toBeNull();
    expect(repairBookmark({ title: "no id" }, report)).toBeNull();
    expect(repairBookmark("string", report)).toBeNull();
    expect(report.dropped).toBe(3);
  });

  it("keeps the valid parts of a mixed tag list", () => {
    expect(repairBookmark({ id: "a", tags: ["ok", 4, null, "fine"] })?.tags).toEqual(["ok", "fine"]);
  });

  it("leaves a healthy row untouched and uncounted", () => {
    const report = fresh();
    const healthy = {
      id: "a",
      url: "https://a.example/",
      title: "A",
      domain: "a.example",
      description: "",
      category: "Other",
      tags: ["x"],
      folderId: null,
      boardIds: [],
      addedAt: 5,
      visitCount: 0,
      health: { status: "ok" },
      preview: { method: "card" },
    };
    expect(repairBookmark({ ...healthy }, report)).toEqual(healthy);
    expect(report.repaired).toBe(0);
  });
});

describe("repairFolders", () => {
  it("brings folders with a missing parent back to the top level", () => {
    const [folder] = repairFolders([{ id: "f", name: "Kept", parentId: "gone", addedAt: 1 }]);
    expect(folder.parentId).toBeNull();
  });

  it("breaks a loop so neither folder disappears from the tree", () => {
    const folders = repairFolders([
      { id: "a", name: "A", parentId: "b", addedAt: 1 },
      { id: "b", name: "B", parentId: "a", addedAt: 1 },
    ]);
    expect(folders.some((folder) => folder.parentId === null)).toBe(true);
  });

  it("keeps a valid nested tree as it is", () => {
    const folders = repairFolders([
      { id: "a", name: "A", parentId: null, addedAt: 1 },
      { id: "b", name: "B", parentId: "a", addedAt: 1 },
    ]);
    expect(folders.map((folder) => folder.parentId)).toEqual([null, "a"]);
  });

  it("names a folder that has no name", () => {
    expect(repairFolders([{ id: "a", name: "  ", parentId: null, addedAt: 1 }])[0].name).toBe("Untitled folder");
  });
});

describe("repairSettings", () => {
  it("falls back to the default for values of the wrong type", () => {
    const settings = repairSettings({ assetBudgetMb: "lots", autoCapture: "yes", confirmDeletes: false });
    expect(settings.assetBudgetMb).toBe(DEFAULT_SETTINGS.assetBudgetMb);
    expect(settings.autoCapture).toBe(DEFAULT_SETTINGS.autoCapture);
    expect(settings.confirmDeletes).toBe(false);
  });

  it("rejects numbers that would break arithmetic", () => {
    expect(repairSettings({ assetBudgetMb: Number.NaN }).assetBudgetMb).toBe(DEFAULT_SETTINGS.assetBudgetMb);
    expect(repairSettings({ assetBudgetMb: -5 }).assetBudgetMb).toBe(DEFAULT_SETTINGS.assetBudgetMb);
  });

  it("returns the defaults for anything that is not an object", () => {
    expect(repairSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(repairSettings("corrupt")).toEqual(DEFAULT_SETTINGS);
  });
});
