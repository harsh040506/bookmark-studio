/**
 * Per-client request throttling for the outbound-fetching endpoints.
 *
 * This server makes requests to arbitrary third-party sites on behalf of whoever calls
 * it. That is fine for the one person running it locally, and a liability the moment
 * the port is reachable by anything else: an unthrottled `/api/health` is a traffic
 * amplifier pointed at other people's infrastructure, and an unthrottled
 * `/api/screenshot` will happily launch browser tabs until the machine falls over.
 *
 * A fixed-window counter is used rather than a token bucket. The traffic being shaped
 * is bursty by nature — a sweep fires a batch, waits, fires another — so precise
 * smoothing buys nothing, while the window's O(1) bookkeeping keeps the hot path free
 * of allocation. Counters are held in memory: this is a single-process local server,
 * and a limiter that outlives a restart would be surprising rather than useful.
 */
import type { NextFunction, Request, Response } from "express";

export interface RateLimitOptions {
  /** Length of the counting window in milliseconds. */
  windowMs: number;
  /** Requests permitted per client per window. */
  max: number;
  /** Distinguishes limiter buckets so one endpoint's budget cannot drain another's. */
  scope: string;
}

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Size at which expired windows are swept. */
const PRUNE_THRESHOLD = 1024;

/**
 * Hard ceiling on retained windows.
 *
 * Sweeping only removes windows that have *expired*, which bounds nothing when the keys
 * keep changing: the limiter buckets on client address, and a caller reaching the server
 * over IPv6 — or any caller at all once `HOST` is set to a shared interface — can present
 * a fresh address per request. Every one of those mints a live window that the sweep is
 * not allowed to touch, so the map grows for as long as the traffic lasts. The limiter
 * would be holding the memory that the limiter exists to protect.
 *
 * Past this ceiling the oldest windows are dropped. That is a real concession — an evicted
 * client starts its count again — but it is the right one: the alternative to forgetting
 * the oldest attacker is running out of memory, and a legitimate client is never the one
 * being forgotten, because it has far fewer distinct addresses than it takes to get here.
 */
const MAX_WINDOWS = 8192;

/**
 * Drops windows that have already expired, then enforces the hard ceiling.
 *
 * Called opportunistically from the request path rather than on a timer: an interval
 * would keep the Node event loop alive and stop the process exiting cleanly, and there
 * is no work to do when no requests are arriving anyway.
 */
function prune(now: number): void {
  if (windows.size < PRUNE_THRESHOLD) return;

  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }

  // Insertion order is oldest-first, so the iterator yields eviction candidates directly.
  if (windows.size <= MAX_WINDOWS) return;
  const excess = windows.size - MAX_WINDOWS;
  let dropped = 0;
  for (const key of windows.keys()) {
    if (dropped >= excess) break;
    windows.delete(key);
    dropped += 1;
  }
}

/**
 * Identifies the caller.
 *
 * `req.ip` is used directly and proxy headers are deliberately ignored: this server is
 * not meant to run behind a proxy, and trusting `X-Forwarded-For` here would let any
 * caller mint a fresh identity per request and bypass the limit entirely.
 */
function clientKey(req: Request, scope: string): string {
  return `${scope}|${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
}

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    prune(now);

    const key = clientKey(req, options.scope);
    const existing = windows.get(key);
    const window =
      existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + options.windowMs };

    window.count += 1;
    windows.set(key, window);

    const remaining = Math.max(0, options.max - window.count);
    res.setHeader("x-ratelimit-limit", String(options.max));
    res.setHeader("x-ratelimit-remaining", String(remaining));
    res.setHeader("x-ratelimit-reset", String(Math.ceil(window.resetAt / 1000)));

    if (window.count > options.max) {
      const retryAfter = Math.ceil((window.resetAt - now) / 1000);
      res.setHeader("retry-after", String(retryAfter));
      res.status(429).json({
        error: "Too many requests",
        detail: `Slow down — try again in ${retryAfter}s.`,
        retryAfter,
      });
      return;
    }

    next();
  };
}

/** Test and diagnostic hook; not used by request handling. */
export function resetRateLimits(): void {
  windows.clear();
}
