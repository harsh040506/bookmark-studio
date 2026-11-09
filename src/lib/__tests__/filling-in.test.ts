/**
 * "The library says 'filling in 1,292' and never finishes."
 *
 * These tests drive the background queue the way the app does: workers that write their
 * results back into the library and then tell the queue what the library now holds, as
 * every commit does through `observeLibrary`. Each case is a way a real library got
 * stuck: duplicate links, the library changing mid-request, the tab going to the
 * background.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookmark, DeviceName } from "../../../shared/types";

type Pipeline = typeof import("../pipeline");
let pipeline: Pipeline;

const settle = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));

function bookmark(id: string, url: string): Bookmark {
  return {
    id,
    url,
    title: id,
    domain: new URL(url).hostname,
    description: "",
    category: "Other",
    tags: [],
    folderId: null,
    boardIds: [],
    addedAt: 0,
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
  };
}

/**
 * A tiny stand-in for the library layer: holds rows, applies results the way
 * `useLibrary` does (every row with a captured URL is marked), and reports back.
 */
function fakeLibrary(rows: Bookmark[], options: { captureDelayMs?: number } = {}) {
  let library = rows;
  const capturedUrls: string[] = [];
  const write = (next: Bookmark[]) => {
    library = next;
    pipeline.observeLibrary(library);
  };
  return {
    rows: () => library,
    capturedUrls,
    write,
    workers: {
      capture: async (batch: Bookmark[], device: DeviceName) => {
        if (options.captureDelayMs) await new Promise((resolve) => setTimeout(resolve, options.captureDelayMs));
        const urls = [...new Set(batch.map((row) => row.url))];
        capturedUrls.push(...urls);
        write(
          library.map((row) =>
            urls.includes(row.url) ? { ...row, preview: { ...row.preview, shotAt: Date.now(), shotDevice: device } } : row,
          ),
        );
        return urls;
      },
      enrich: async (batch: Bookmark[]) => {
        const ids = new Set(batch.map((row) => row.id));
        write(library.map((row) => (ids.has(row.id) ? { ...row, enriched: true, meta: { fetchedAt: 1 } } : row)));
        return batch.length;
      },
      check: async (batch: Bookmark[]) => {
        const ids = new Set(batch.map((row) => row.id));
        write(library.map((row): Bookmark => (ids.has(row.id) ? { ...row, health: { status: "live", checkedAt: 1 } } : row)));
        return batch.length;
      },
    },
  };
}

function pending(): number {
  const state = pipeline.pipelineState();
  return Object.values(state.pending).reduce((sum, value) => sum + value, 0) + state.active;
}

beforeEach(async () => {
  vi.resetModules();
  pipeline = await import("../pipeline");
  pipeline.setPipelineSettings({ shots: true, meta: true, health: true, visual: false, offline: false, device: "desktop" });
  pipeline.setPipelineOnline(true);
});

describe("a library with the same link saved more than once", () => {
  it("captures each page once and finishes", async () => {
    const lib = fakeLibrary([
      bookmark("a", "https://news.example/"),
      bookmark("b", "https://news.example/"), // the same page, filed twice
      bookmark("c", "https://news.example/"),
      bookmark("d", "https://docs.example/"),
    ]);
    pipeline.configurePipeline(lib.workers);
    pipeline.observeLibrary(lib.rows());
    await settle(1500);

    expect(pending()).toBe(0);
    expect(lib.capturedUrls.filter((url) => url === "https://news.example/").length).toBe(1);
    expect(lib.rows().every((row) => row.preview.shotAt)).toBe(true);
  });
});

describe("the library changing while a page is being captured", () => {
  it("does not start the same page a second time", async () => {
    const lib = fakeLibrary([bookmark("a", "https://slow.example/")], { captureDelayMs: 600 });
    pipeline.configurePipeline(lib.workers);
    pipeline.observeLibrary(lib.rows());
    await settle(150);
    // Other passes finish and every commit re-reports the library mid-capture.
    for (let index = 0; index < 5; index += 1) pipeline.observeLibrary(lib.rows());
    await settle(1200);

    expect(lib.capturedUrls).toEqual(["https://slow.example/"]);
    expect(pending()).toBe(0);
  });
});

describe("leaving the tab", () => {
  it("keeps filling in while the tab is in the background", async () => {
    const lib = fakeLibrary([bookmark("a", "https://one.example/"), bookmark("b", "https://two.example/")]);
    pipeline.configurePipeline(lib.workers);
    pipeline.setPipelineHidden(true);
    pipeline.observeLibrary(lib.rows());
    await settle(1200);

    expect(pipeline.pipelineState().reason).not.toBe("paused");
    expect(pending()).toBe(0);
  });
});

describe("a page the screenshot worker keeps failing on", () => {
  it("is given up on after a few tries instead of looping forever", async () => {
    const lib = fakeLibrary([bookmark("a", "https://broken.example/")]);
    pipeline.setPipelineSettings({ shots: true, meta: false, health: false });
    let attempts = 0;
    pipeline.configurePipeline({
      ...lib.workers,
      capture: async () => {
        attempts += 1;
        return [];
      },
    });
    pipeline.observeLibrary(lib.rows());
    await settle(2200);
    // Re-reporting the library must not reset the attempt count.
    pipeline.observeLibrary(lib.rows());
    await settle(800);

    expect(attempts).toBeLessThanOrEqual(2);
    expect(pipeline.pipelineState().failed).toBe(1);
    expect(pending()).toBe(0);
  });
});
