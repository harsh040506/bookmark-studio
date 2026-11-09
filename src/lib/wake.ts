/**
 * A timer that keeps its pace in a hidden tab.
 *
 * Chrome slows chained `setTimeout` calls in a page that has been hidden for a few
 * minutes to about one wake-up a minute. The background queue is a chain of short
 * timers, so a library left in a background tab crawled to a near halt: one batch a
 * minute instead of a few a second. Timers inside a dedicated worker are not slowed that
 * way, so while the page is hidden the wake-up comes from a tiny worker instead.
 *
 * Where a worker cannot start (tests, a locked-down browser), it falls back to
 * `setTimeout`, which is slower when hidden but still correct.
 */
type Cancel = () => void;

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, () => void>();

function ensureWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  if (typeof Worker === "undefined") {
    workerFailed = true;
    return null;
  }
  try {
    worker = new Worker(new URL("./wake.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<number>) => {
      const run = pending.get(event.data);
      pending.delete(event.data);
      run?.();
    };
    worker.onerror = () => {
      // Hand every waiting callback to ordinary timers rather than dropping it.
      workerFailed = true;
      worker?.terminate();
      worker = null;
      for (const [id, run] of pending) {
        pending.delete(id);
        setTimeout(run, 0);
      }
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

/** Calls `run` after `delay` ms. Returns a function that cancels it. */
export function wakeAfter(delay: number, hidden: boolean, run: () => void): Cancel {
  const target = hidden ? ensureWorker() : null;
  if (!target) {
    const handle = setTimeout(run, delay);
    return () => clearTimeout(handle);
  }
  const id = nextId++;
  pending.set(id, run);
  target.postMessage({ id, delay });
  return () => {
    pending.delete(id);
  };
}
