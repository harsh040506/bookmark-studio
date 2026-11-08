/**
 * Circuit breakers: stop asking something that has stopped answering.
 *
 * A library of a few thousand bookmarks has clusters: fifty links on one site that has
 * since gone offline is ordinary. Without a breaker, each of those fifty waits out its full
 * timeout (nine seconds for a link check), so a sweep spends minutes on one dead host and
 * holds connections the healthy sites are waiting for. After `threshold` consecutive
 * failures within `windowMs`, the key "opens" and calls fail at once for `coolOffMs`. The
 * next call after that is let through as a trial: success closes the breaker, failure
 * opens it again.
 *
 * Only failures to *reach* something should count. An HTTP 404 is an answer, not an
 * outage, and must never open a breaker.
 */
export interface BreakerOptions {
  threshold: number;
  windowMs: number;
  coolOffMs: number;
  /** Ceiling on tracked keys, so a sweep across ten thousand hosts cannot grow memory. */
  maxKeys?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  firstFailureAt: number;
  openUntil: number;
}

export class CircuitOpenError extends Error {
  constructor(
    readonly key: string,
    readonly retryAt: number,
  ) {
    super("Not responding right now");
    this.name = "CircuitOpenError";
  }
}

export function createBreaker(options: BreakerOptions) {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 2_000;
  const entries = new Map<string, Entry>();

  /** Throws `CircuitOpenError` while `key` is cooling off. */
  function check(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    const time = now();
    if (entry.openUntil > time) throw new CircuitOpenError(key, entry.openUntil);
  }

  function success(key: string): void {
    entries.delete(key);
  }

  function failure(key: string): void {
    const time = now();
    let entry = entries.get(key);
    if (!entry || time - entry.firstFailureAt > options.windowMs) {
      entry = { failures: 0, firstFailureAt: time, openUntil: 0 };
    }
    entry.failures += 1;
    // A failed trial after a cool-off reopens at once rather than counting up again.
    if (entry.failures >= options.threshold || entry.openUntil > 0) entry.openUntil = time + options.coolOffMs;
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > maxKeys) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
  }

  function state(key: string): "closed" | "open" {
    const entry = entries.get(key);
    return entry && entry.openUntil > now() ? "open" : "closed";
  }

  return { check, success, failure, state, reset: () => entries.clear() };
}

export type Breaker = ReturnType<typeof createBreaker>;
