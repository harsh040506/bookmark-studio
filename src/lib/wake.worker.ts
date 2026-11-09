/// <reference lib="webworker" />
/**
 * The hidden-tab timer for `wake.ts`. Holds no state beyond the timers it is running and
 * accepts only a numeric id and delay, so a malformed message cannot make it do anything.
 */
self.onmessage = (event: MessageEvent<{ id?: unknown; delay?: unknown }>) => {
  const id = Number(event.data?.id);
  const delay = Math.min(Math.max(Number(event.data?.delay) || 0, 0), 60_000);
  if (!Number.isInteger(id)) return;
  setTimeout(() => self.postMessage(id), delay);
};

export {};
