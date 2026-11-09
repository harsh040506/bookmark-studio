/**
 * "The extension should keep filling in my library after I close the browser."
 *
 * The queue runs in a page. When no Bookmark Studio window is open, the service worker
 * opens a hidden page that runs it, and closes it when the work is done. These are the
 * rules it follows (lib/background-runner.ts), and what the extension asks for to do it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRunnerUrl, isWorkReport, runnerAction, workRemains } from "../background-runner";

const idle = { offscreen: true, workPending: false, appWindowOpen: false, runnerOpen: false };
const queue = (pending: number, reason: "working" | "offline" | "off" | "yielded" = "working", active = 0) => ({
  pending: { shot: 0, meta: pending, health: 0, visual: 0, offline: 0 },
  active,
  reason,
});

describe("after the browser restarts with pages still to read", () => {
  it("starts the hidden runner when no window is open", () => {
    expect(runnerAction({ ...idle, workPending: true })).toBe("start");
  });

  it("leaves the work to an open window instead", () => {
    expect(runnerAction({ ...idle, workPending: true, appWindowOpen: true })).toBe("none");
  });

  it("does nothing in a browser without offscreen pages (Firefox)", () => {
    expect(runnerAction({ ...idle, workPending: true, offscreen: false })).toBe("none");
  });

  it("does not start a second runner", () => {
    expect(runnerAction({ ...idle, workPending: true, runnerOpen: true })).toBe("none");
  });
});

describe("the hidden runner", () => {
  it("closes once everything is done", () => {
    expect(runnerAction({ ...idle, runnerOpen: true })).toBe("close");
  });

  it("closes when a window opens, so the window takes over", () => {
    expect(runnerAction({ ...idle, workPending: true, runnerOpen: true, appWindowOpen: true })).toBe("close");
  });

  it("is not started for nothing", () => {
    expect(runnerAction(idle)).toBe("none");
  });
});

describe("what counts as work left", () => {
  it("is rows waiting or being worked on", () => {
    expect(workRemains(queue(3))).toBe(true);
    expect(workRemains(queue(0, "working", 1))).toBe(true);
    expect(workRemains(queue(0))).toBe(false);
  });

  it("is still work while a job the person started has the queue paused", () => {
    expect(workRemains(queue(3, "yielded"))).toBe(true);
  });

  it("is not work while page access is missing or every pass is off, so the runner does not sit open forever", () => {
    expect(workRemains(queue(3, "offline"))).toBe(false);
    expect(workRemains(queue(3, "off"))).toBe(false);
  });
});

describe("messages and addresses", () => {
  it("recognises the runner's address and only well-formed reports", () => {
    expect(isRunnerUrl("?runner")).toBe(true);
    expect(isRunnerUrl("")).toBe(false);
    expect(isWorkReport({ type: "background-work", pending: false })).toBe(true);
    expect(isWorkReport({ type: "background-work", pending: "yes" })).toBe(false);
    expect(isWorkReport(null)).toBe(false);
  });
});

describe("what installing the extension asks for", () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../../../extension/manifest.json"), "utf8"),
  ) as { permissions: string[] };

  it("includes the hidden page and the heartbeat, neither of which shows an install warning", () => {
    expect(manifest.permissions).toEqual(expect.arrayContaining(["offscreen", "alarms"]));
  });
});
