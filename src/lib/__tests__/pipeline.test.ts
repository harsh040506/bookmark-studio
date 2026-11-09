/**
 * The background pipeline.
 *
 * These tests exist because the pipeline is the one part of the app that runs when nobody
 * is watching, on a library nobody has opened, against servers that belong to other
 * people. Every failure mode it has is therefore silent: a queue that never drains, a URL
 * retried forever, a pass that keeps running after its switch is turned off, work done for
 * rows four thousand deep while the screen stays grey. None of those announce themselves,
 * so they have to be asserted.
 *
 * The module holds process-wide state by design — there is one queue per app, not one per
 * component — so each test re-imports it fresh rather than reaching for a reset hook that
 * would exist only for the tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookmark } from "../../../shared/types";

type Pipeline = typeof import("../pipeline");

let pipeline: Pipeline;

/** Long enough for the pump's own gap plus a few awaited turns. */
const settle = (ms = 420) => new Promise((resolve) => setTimeout(resolve, ms));

function bookmark(overrides: Partial<Bookmark> & { id: string; url: string }): Bookmark {
  return {
    title: overrides.id,
    domain: "example.com",
    description: "",
    category: "Uncategorised",
    tags: [],
    folderId: null,
    boardIds: [],
    addedAt: 0,
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
    ...overrides,
  };
}

/** A bookmark that has already had all three passes and should never be queued. */
function complete(id: string): Bookmark {
  return bookmark({
    id,
    url: `https://example.com/${id}`,
    enriched: true,
    meta: { fetchedAt: 1 },
    health: { status: "live", checkedAt: 1 },
    preview: { method: "screenshot", shotAt: 1 },
  });
}

interface Recorder {
  captured: string[][];
  enriched: string[][];
  checked: string[][];
}

function workers(recorder: Recorder, options: { captureOk?: boolean } = {}) {
  return {
    // Returns the URLs that produced a screenshot — an empty array is "none of them",
    // which is what drives the retry-then-abandon path below.
    capture: async (rows: Bookmark[]) => {
      const urls = rows.map((row) => row.url);
      recorder.captured.push(urls);
      return (options.captureOk ?? true) ? urls : [];
    },
    enrich: async (rows: Bookmark[]) => {
      recorder.enriched.push(rows.map((row) => row.url));
      return rows.length;
    },
    check: async (rows: Bookmark[]) => {
      recorder.checked.push(rows.map((row) => row.url));
      return rows.length;
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  pipeline = await import("../pipeline");
  pipeline.setPipelineOnline(true);
  pipeline.setPipelineHidden(false);
  pipeline.yieldPipeline(false);
});

describe("what the pipeline decides to do", () => {
  it("queues all three passes for a page it has never seen", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.configurePipeline(workers(recorder));
    pipeline.observeLibrary([bookmark({ id: "a", url: "https://example.com/a" })]);

    await settle();

    expect(recorder.captured.flat()).toContain("https://example.com/a");
    expect(recorder.enriched.flat()).toContain("https://example.com/a");
    expect(recorder.checked.flat()).toContain("https://example.com/a");
  });

  /**
   * The durability guarantee. Everything the pipeline has done is recorded on the bookmark
   * itself rather than in a session-local set, which is what makes closing the tab lose
   * only the unfinished remainder — and what stops a reload from re-rendering a thousand
   * pages that were captured yesterday.
   */
  it("asks for nothing when the work is already recorded on the bookmark", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.configurePipeline(workers(recorder));
    pipeline.observeLibrary([complete("done")]);

    await settle();

    expect(recorder.captured).toHaveLength(0);
    expect(recorder.enriched).toHaveLength(0);
    expect(recorder.checked).toHaveLength(0);
    // `visual` and `offline` are queued too now; with no worker supplied they stay at zero.
    expect(pipeline.pipelineState().pending).toEqual({
      shot: 0,
      meta: 0,
      health: 0,
      visual: 0,
      offline: 0,
    });
  });

  it("leaves archived bookmarks alone", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.configurePipeline(workers(recorder));
    pipeline.observeLibrary([
      bookmark({ id: "a", url: "https://example.com/a", archived: true }),
    ]);

    await settle();
    expect(recorder.captured).toHaveLength(0);
  });

  /**
   * A page that will not load is worth two attempts and no more. Without this it cycles
   * through the queue forever, spending the rate budget the rest of the library needs, and
   * does so silently because nobody is watching a background pass.
   */
  it("gives up on a URL that keeps failing", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.setPipelineSettings({ shots: true, meta: false, health: false });
    pipeline.configurePipeline(workers(recorder, { captureOk: false }));
    pipeline.observeLibrary([bookmark({ id: "a", url: "https://example.com/a" })]);

    await settle(1500);

    expect(recorder.captured.length).toBeLessThanOrEqual(2);
    expect(pipeline.pipelineState().failed).toBeGreaterThan(0);
    expect(pipeline.pipelineState().pending.shot).toBe(0);
  });

  it("reconsiders an abandoned URL when asked to", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.setPipelineSettings({ shots: true, meta: false, health: false });
    pipeline.configurePipeline(workers(recorder, { captureOk: false }));
    pipeline.observeLibrary([bookmark({ id: "a", url: "https://example.com/a" })]);
    await settle(1500);
    const before = recorder.captured.length;

    pipeline.resetPipelineFailures();
    pipeline.observeLibrary([bookmark({ id: "a", url: "https://example.com/a" })]);
    await settle(1500);

    expect(recorder.captured.length).toBeGreaterThan(before);
  });
});

describe("what stops it", () => {
  it("does nothing while the server is unreachable", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.setPipelineOnline(false);
    pipeline.configurePipeline(workers(recorder));
    pipeline.observeLibrary([bookmark({ id: "a", url: "https://example.com/a" })]);

    await settle();

    expect(recorder.captured).toHaveLength(0);
    expect(pipeline.pipelineState().reason).toBe("offline");
    // The work is queued, not discarded: coming back online resumes it.
    expect(pipeline.pipelineState().pending.shot).toBe(1);
  });

  /**
   * A foreground job and the background sweep drive the same single renderer. Letting them
   * interleave makes the job the user is actually watching take about twice as long, for
   * no benefit they can see.
   */
  it("stands down entirely while a user-initiated job is running", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.configurePipeline(workers(recorder));
    pipeline.yieldPipeline(true);
    pipeline.observeLibrary([bookmark({ id: "a", url: "https://example.com/a" })]);

    await settle();
    expect(recorder.captured).toHaveLength(0);
    expect(pipeline.pipelineState().reason).toBe("yielded");

    pipeline.yieldPipeline(false);
    await settle();
    expect(recorder.captured.flat()).toContain("https://example.com/a");
  });

  it("drops a pass's queue the moment its switch is turned off", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.setPipelineOnline(false);
    pipeline.configurePipeline(workers(recorder));
    pipeline.observeLibrary([bookmark({ id: "a", url: "https://example.com/a" })]);
    expect(pipeline.pipelineState().pending.meta).toBe(1);

    pipeline.setPipelineSettings({ meta: false });
    expect(pipeline.pipelineState().pending.meta).toBe(0);
    // The other passes are untouched.
    expect(pipeline.pipelineState().pending.shot).toBe(1);
  });

  it("reports itself as off when every pass is disabled", () => {
    pipeline.configurePipeline(workers({ captured: [], enriched: [], checked: [] }));
    pipeline.setPipelineSettings({ shots: false, meta: false, health: false });
    expect(pipeline.pipelineState().reason).toBe("off");
  });
});

describe("ordering", () => {
  /**
   * The rule the whole design rests on: a page you are about to scroll to is processed
   * before one four thousand rows away that you may never reach. Without it the pipeline
   * is technically busy and visibly useless — the screen stays grey while the far end of
   * the library fills in.
   */
  it("processes what is on screen before what is not", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.setPipelineSettings({ shots: true, meta: false, health: false });
    pipeline.setPipelineOnline(false);
    pipeline.configurePipeline(workers(recorder));

    const library = Array.from({ length: 30 }, (_, index) =>
      bookmark({ id: `b${index}`, url: `https://example.com/${index}` }),
    );
    pipeline.observeLibrary(library);

    // Row 25 is the one being scrolled towards.
    pipeline.sight([library[25]]);
    pipeline.setPipelineOnline(true);

    await settle();

    expect(recorder.captured[0]).toContain("https://example.com/25");
  });

  it("counts what is left, per pass", () => {
    pipeline.setPipelineOnline(false);
    pipeline.configurePipeline(workers({ captured: [], enriched: [], checked: [] }));
    pipeline.observeLibrary([
      bookmark({ id: "a", url: "https://example.com/a" }),
      bookmark({ id: "b", url: "https://example.com/b", preview: { method: "screenshot", shotAt: 1 } }),
      complete("c"),
    ]);

    expect(pipeline.pipelineState().pending).toEqual({
      shot: 1,
      meta: 2,
      health: 2,
      visual: 0,
      offline: 0,
    });
  });

  it("forgets work for bookmarks that have been deleted", () => {
    pipeline.setPipelineOnline(false);
    pipeline.configurePipeline(workers({ captured: [], enriched: [], checked: [] }));
    const rows = [
      bookmark({ id: "a", url: "https://example.com/a" }),
      bookmark({ id: "b", url: "https://example.com/b" }),
    ];
    pipeline.observeLibrary(rows);
    expect(pipeline.pipelineState().pending.shot).toBe(2);

    pipeline.observeLibrary([rows[0]]);
    expect(pipeline.pipelineState().pending.shot).toBe(1);
  });
});

describe("one pass failing does not silence the others", () => {
  /**
   * The bug this pins down was invisible and expensive: a page whose screenshot could not
   * be produced had its URL marked abandoned *globally*, so it was then never read for its
   * text and never link-checked either. In a real library — where a few hundred saved
   * pages have since 404'd — that quietly switched off two thirds of the work for a large
   * fraction of the shelf, with nothing on screen to indicate it.
   */
  it("keeps reading and checking a page whose screenshot keeps failing", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.configurePipeline(workers(recorder, { captureOk: false }));

    const row = bookmark({ id: "a", url: "https://example.com/a" });
    pipeline.observeLibrary([row]);

    // Long enough for the capture to fail twice and be abandoned.
    await settle(1500);
    expect(pipeline.pipelineState().failed).toBeGreaterThan(0);

    // The library is re-observed constantly in the real app; the other two passes must
    // still be offered work for this URL.
    pipeline.observeLibrary([row]);
    await settle();

    expect(recorder.enriched.flat()).toContain("https://example.com/a");
    expect(recorder.checked.flat()).toContain("https://example.com/a");
  });

  it("does not requeue the pass that was abandoned", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.setPipelineSettings({ shots: true, meta: false, health: false });
    pipeline.configurePipeline(workers(recorder, { captureOk: false }));

    const row = bookmark({ id: "a", url: "https://example.com/a" });
    pipeline.observeLibrary([row]);
    await settle(1500);
    const attempts = recorder.captured.length;

    pipeline.observeLibrary([row]);
    await settle();

    expect(recorder.captured.length).toBe(attempts);
  });
});

/**
 * A screenshot belongs to a viewport, not to a page.
 *
 * Cards resolve their preview through `shot:<device>:<url>`, so a desktop capture is
 * simply not the picture a grid rendering at mobile is asking for. The bug this pins down
 * was total and silent for anyone who touched the preview-device preference: `shotAt`
 * answered "already captured" regardless of viewport, so the pipeline declared the work
 * finished while every card went on requesting a render that had never been made. The
 * library stayed grey permanently, and nothing anywhere said why.
 */
describe("the viewport a screenshot was taken at", () => {
  const captured = (device: "desktop" | "tablet" | "mobile") =>
    bookmark({
      id: "a",
      url: "https://example.com/a",
      enriched: true,
      meta: { fetchedAt: 1 },
      health: { status: "live", checkedAt: 1 },
      preview: { method: "screenshot", shotAt: 1, shotDevice: device },
    });

  it("asks for nothing when the stored capture matches the requested device", () => {
    pipeline.setPipelineOnline(false);
    pipeline.setPipelineSettings({ device: "mobile" });
    pipeline.configurePipeline(workers({ captured: [], enriched: [], checked: [] }));
    pipeline.observeLibrary([captured("mobile")]);

    expect(pipeline.pipelineState().pending.shot).toBe(0);
  });

  it("re-queues a page whose only capture is at another device", () => {
    pipeline.setPipelineOnline(false);
    pipeline.setPipelineSettings({ device: "mobile" });
    pipeline.configurePipeline(workers({ captured: [], enriched: [], checked: [] }));
    pipeline.observeLibrary([captured("desktop")]);

    expect(pipeline.pipelineState().pending.shot).toBe(1);
  });

  /**
   * Rows written before the viewport was recorded predate any path that could capture at
   * anything but desktop, so reading them as desktop is a statement of fact rather than a
   * guess — and it is what stops an upgrade from re-rendering an entire settled library.
   */
  it("reads a capture with no recorded device as desktop", () => {
    pipeline.setPipelineOnline(false);
    pipeline.configurePipeline(workers({ captured: [], enriched: [], checked: [] }));

    pipeline.setPipelineSettings({ device: "desktop" });
    pipeline.observeLibrary([complete("legacy")]);
    expect(pipeline.pipelineState().pending.shot).toBe(0);

    pipeline.setPipelineSettings({ device: "tablet" });
    pipeline.observeLibrary([complete("legacy")]);
    expect(pipeline.pipelineState().pending.shot).toBe(1);
  });

  /**
   * Failing to render at one viewport is not evidence about another, and the abandoned set
   * is per-URL rather than per-device. Leaving it in place would mean the one viewport the
   * user has just chosen is the one that never gets a second attempt.
   */
  it("reconsiders pages abandoned at the previous device", async () => {
    const recorder: Recorder = { captured: [], enriched: [], checked: [] };
    pipeline.setPipelineSettings({ shots: true, meta: false, health: false, device: "desktop" });
    pipeline.configurePipeline(workers(recorder, { captureOk: false }));

    const row = bookmark({ id: "a", url: "https://example.com/a" });
    pipeline.observeLibrary([row]);
    await settle(1500);
    const attempts = recorder.captured.length;
    expect(attempts).toBeGreaterThan(0);

    pipeline.setPipelineSettings({ device: "mobile" });
    pipeline.observeLibrary([row]);
    await settle();

    expect(recorder.captured.length).toBeGreaterThan(attempts);
  });

  it("captures at the device the pipeline was configured with", async () => {
    const seen: string[] = [];
    pipeline.setPipelineSettings({ shots: true, meta: false, health: false, device: "tablet" });
    pipeline.configurePipeline({
      capture: async (rows, device) => {
        const urls = rows.map((row) => row.url);
        seen.push(device);
        return urls;
      },
      enrich: async (rows) => rows.length,
      check: async (rows) => rows.length,
    });
    pipeline.observeLibrary([bookmark({ id: "a", url: "https://example.com/a" })]);

    await settle();

    expect(seen).toContain("tablet");
  });
});
