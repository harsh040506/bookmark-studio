/**
 * "Installing the extension should be safe, quiet and work in more than one browser."
 *
 * What a cautious person sees at install, what an allowed website can and cannot make
 * the extension do, and the browser differences that used to stop sync working.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, wantsBrowserSync } from "../../../shared/types";
import { clampNumber, isWritableBookmarkUrl } from "../../ext/bridge-host";
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID, learnRootIds } from "../chrome-bookmarks";
import { repairSettings } from "../repair";

const manifest = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../../extension/manifest.json"), "utf8"),
) as { host_permissions?: string[]; optional_host_permissions?: string[]; permissions: string[] };

describe("what the install prompt asks for", () => {
  it("does not demand access to every website up front", () => {
    expect(manifest.host_permissions ?? []).not.toContain("<all_urls>");
  });

  it("asks for page access later, when the person first needs it", () => {
    expect(manifest.optional_host_permissions).toContain("<all_urls>");
  });
});

describe("what an allowed website can make the extension do", () => {
  it.each(["javascript:alert(1)", "data:text/html,x", "file:///c:/secrets", "chrome://settings", 42, null])(
    "cannot save %j as a browser bookmark",
    (url) => {
      expect(isWritableBookmarkUrl(url)).toBe(false);
    },
  );

  it.each(["https://example.com/", "http://example.com/a?b=c", "ftp://files.example.com/"])("can save %s", (url) => {
    expect(isWritableBookmarkUrl(url)).toBe(true);
  });

  it("cannot lift the download size limit with a nonsense number", () => {
    expect(clampNumber(Number.NaN, 2_000_000, 0, 8_000_000)).toBe(2_000_000);
    expect(clampNumber(Infinity, 2_000_000, 0, 8_000_000)).toBe(2_000_000);
    expect(clampNumber("9999999999", 2_000_000, 0, 8_000_000)).toBe(2_000_000);
    expect(clampNumber(1e12, 2_000_000, 0, 8_000_000)).toBe(8_000_000);
    expect(clampNumber(-5, 2_000_000, 0, 8_000_000)).toBe(0);
  });
});

describe("syncing with the browser's bookmarks", () => {
  it("is on by default once the extension is connected", () => {
    expect(wantsBrowserSync(DEFAULT_SETTINGS)).toBe(true);
  });

  it("stays off for someone who switched it off", () => {
    expect(wantsBrowserSync({ browserSync: false, browserSyncChosen: true })).toBe(false);
  });

  it("stays on for someone who switched it on before this default existed", () => {
    expect(wantsBrowserSync(repairSettings({ browserSync: true }))).toBe(true);
  });
});

describe("background capture windows", () => {
  it("are off by default, so the extension never flickers windows unasked", () => {
    expect(DEFAULT_SETTINGS.captureWithWindows).toBe(false);
  });
});

describe("damaged settings", () => {
  it("fall back to a working preview size rather than one nothing can render", () => {
    expect(repairSettings({ previewDevice: "watch" }).previewDevice).toBe(DEFAULT_SETTINGS.previewDevice);
    expect(repairSettings({ previewDevice: "mobile" }).previewDevice).toBe("mobile");
  });
});

describe("Firefox's bookmark folders", () => {
  it("files new bookmarks into Firefox's 'Other Bookmarks', not a Chrome-only id", () => {
    learnRootIds({
      id: "root________",
      title: "",
      children: [
        { id: "menu________", title: "Bookmarks Menu" },
        { id: "toolbar_____", title: "Bookmarks Toolbar" },
        { id: "unfiled_____", title: "Other Bookmarks" },
        { id: "mobile______", title: "Mobile Bookmarks" },
      ],
    } as chrome.bookmarks.BookmarkTreeNode);
    expect(OTHER_BOOKMARKS_ID).toBe("unfiled_____");
    expect(BOOKMARKS_BAR_ID).toBe("toolbar_____");
  });

  it("still uses Chrome's ids in Chrome", () => {
    learnRootIds({
      id: "0",
      title: "",
      children: [
        { id: "1", title: "Bookmarks bar" },
        { id: "2", title: "Other bookmarks" },
      ],
    } as chrome.bookmarks.BookmarkTreeNode);
    expect(OTHER_BOOKMARKS_ID).toBe("2");
    expect(BOOKMARKS_BAR_ID).toBe("1");
  });
});
