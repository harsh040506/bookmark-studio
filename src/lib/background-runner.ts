/**
 * Keeping the extension's background work going when no Bookmark Studio window is open.
 *
 * The queue (`pipeline.ts`) runs inside a page, started by the library hook. Close the last
 * window, or restart the browser, and nothing was left to start it, so a half-filled
 * library stayed half-filled until someone opened the app again.
 *
 * The extension's service worker now opens a hidden page (an offscreen document) that runs
 * the same app code with nothing drawn, whenever work is left and no window is open. That
 * page closes itself once the queue is empty, and an app window opening takes over from it.
 * The rules for when to start and stop live here, pure, so they are tested apart from
 * Chrome. Firefox has no offscreen documents, so there the work waits for a window.
 */
import type { PipelineState } from "./pipeline";

/** The query that turns `index.html` into the hidden runner. */
export const RUNNER_QUERY = "runner";
export const RUNNER_PATH = `index.html?${RUNNER_QUERY}`;

/** What a page tells the service worker about the queue. */
export interface WorkReport {
  type: "background-work";
  /** Whether anything is left that could run now. */
  pending: boolean;
}

export function isWorkReport(message: unknown): message is WorkReport {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as WorkReport).type === "background-work" &&
    typeof (message as WorkReport).pending === "boolean"
  );
}

/**
 * Whether the queue has work it can do.
 *
 * Rows waiting while page access is missing, or with every pass switched off, are not
 * work: a runner kept open for them would sit there forever. Granting access or switching
 * a pass back on happens in a window, which reports again.
 */
export function workRemains(state: Pick<PipelineState, "pending" | "active" | "reason">): boolean {
  if (state.reason === "offline" || state.reason === "off") return false;
  const waiting = Object.values(state.pending).reduce((sum, count) => sum + count, 0);
  return waiting + state.active > 0;
}

export interface RunnerFacts {
  /** The browser can open offscreen documents (Chrome 109+; not Firefox). */
  offscreen: boolean;
  /** Something is left unfinished, as last reported. */
  workPending: boolean;
  /** A Bookmark Studio window is open; it runs the queue itself. */
  appWindowOpen: boolean;
  /** The hidden runner is already open. */
  runnerOpen: boolean;
}

export type RunnerAction = "start" | "close" | "none";

/** What the service worker should do about the hidden runner. */
export function runnerAction(facts: RunnerFacts): RunnerAction {
  if (facts.runnerOpen) return facts.appWindowOpen || !facts.workPending ? "close" : "none";
  return facts.offscreen && facts.workPending && !facts.appWindowOpen ? "start" : "none";
}

/** Whether this page is the hidden runner. */
export function isRunnerUrl(search: string): boolean {
  return new URLSearchParams(search).has(RUNNER_QUERY);
}
