/**
 * Headless-browser screenshot service.
 *
 * Why this exists: measured against a real library, 12 of the 14 most-bookmarked sites
 * send `X-Frame-Options` or a restrictive `frame-ancestors`, so the live-iframe preview
 * can almost never render. A cached screenshot is the only preview tier that works for
 * the majority of the web, exactly as the requirements anticipated.
 *
 * Design notes:
 *  - One browser instance is reused; pages are the unit of concurrency, capped so a
 *    1200-bookmark sweep cannot spawn 1200 tabs.
 *  - Results are cached on disk by (url, viewport) and served straight from there.
 *  - Requests inside the page are filtered so a render cannot reach private addresses.
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { intFromEnv } from "./config";
import { createGate } from "./gate";
import { assertPublicUrl, isPrivateAddress } from "./safe-fetch";

export type DeviceName = "desktop" | "tablet" | "mobile";

export const DEVICES: Record<DeviceName, { width: number; height: number; scale: number; mobile: boolean }> = {
  desktop: { width: 1280, height: 800, scale: 1, mobile: false },
  tablet: { width: 834, height: 1112, scale: 1, mobile: true },
  mobile: { width: 414, height: 896, scale: 2, mobile: true },
};

const CACHE_DIR = path.resolve(process.env.SCREENSHOT_CACHE_DIR ?? ".cache/screenshots");
/**
 * Tabs open at once.
 *
 * Bounded at both ends by `intFromEnv`: a zero or a `NaN` here does not misbehave, it
 * deadlocks — `active < max` is false for both, so the gate admits nobody and every
 * capture waits forever. The upper bound is a guess at where a machine starts thrashing
 * rather than a hard limit, but an unbounded value is certainly wrong.
 */
const MAX_CONCURRENCY = intFromEnv("SCREENSHOT_CONCURRENCY", 3, { min: 1, max: 32 });
const NAVIGATION_TIMEOUT = 20_000;
/**
 * Hard ceiling on one capture, start to finish.
 *
 * Navigation already has its own timeout, but that is not enough: on a page that never
 * stops painting, `page.screenshot()` can wait for a stable frame forever, and closing a
 * page with pending intercepted requests can hang too. Measured against a real library,
 * one such site was enough to leave an HTTP request open indefinitely and hold a
 * concurrency slot for the life of the process. Every capture now has a deadline.
 */
const CAPTURE_BUDGET = 45_000;
/** How long to let a page close before abandoning it. */
const CLOSE_GRACE = 5_000;
/** A cached shot older than this is considered stale and re-rendered on request. */
export const SCREENSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Common install locations, so the service works without a bundled Chromium download. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${os.homedir()}/AppData/Local/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean) as string[];

export function findChrome(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

let browserPromise: Promise<Browser> | null = null;

/**
 * Starts Chrome, or returns the instance already running.
 *
 * ## Why the assignment happens before the first `await`
 *
 * Captures arrive concurrently — the gate allows three at once, and a batch dispatches
 * twenty-five together — so this function is routinely entered by several callers in the
 * same tick. The version this replaces checked `browserPromise`, then `await`ed, then
 * assigned; every caller that arrived during that await saw `null`, and each launched its
 * own Chrome. The last assignment won, and the earlier browsers became orphaned processes
 * that no longer had a reference anywhere in the program — so `shutdown()` could not close
 * them, and they outlived the server exactly as the shutdown handler exists to prevent.
 *
 * Publishing the promise synchronously, before anything is awaited, is what makes this
 * safe: the second caller finds the first caller's in-flight launch and waits on it.
 */
function launchBrowser(executablePath: string): Promise<Browser> {
  const launching = puppeteer
    .launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-first-run",
        "--disable-background-networking",
      ],
    })
    .then((browser) => {
      browser.on("disconnected", () => {
        // Only retract the handle if it is still this browser's. A slower disconnect event
        // from a previous instance must not clear a newer, healthy one.
        if (browserPromise === launching) browserPromise = null;
      });
      return browser;
    });

  // Assigned before the caller awaits, so a concurrent caller joins rather than launches.
  browserPromise = launching;

  /*
    A failed launch must not be remembered as a rejected promise.

    Leaving it in place would make every later capture reject with the original error —
    Chrome briefly unavailable at start-up would disable screenshots for the life of the
    process. The handler is attached without being awaited so the rejection is observed
    here too, which is what keeps a launch failure from surfacing as an unhandled
    rejection when the only caller has already given up and moved on.
  */
  launching.catch(() => {
    if (browserPromise === launching) browserPromise = null;
  });

  return launching;
}

/**
 * How many times to re-look before giving up.
 *
 * Each pass either returns a browser or discovers that the handle changed underneath it.
 * Three is enough for any realistic interleaving and bounds the loop against a browser
 * that dies the instant it starts, which would otherwise spin here indefinitely.
 */
const BROWSER_ATTEMPTS = 3;

async function getBrowser(): Promise<Browser> {
  for (let attempt = 0; attempt < BROWSER_ATTEMPTS; attempt += 1) {
    const pending = browserPromise;

    if (!pending) {
      const executablePath = findChrome();
      if (!executablePath) throw new ScreenshotUnavailable("No Chrome or Edge installation found");
      /*
        No `await` separates the null check above from the publish inside `launchBrowser`,
        so this whole branch is one synchronous block and exactly one caller can be in it.
      */
      return launchBrowser(executablePath);
    }

    const existing = await pending.catch(() => null);
    if (existing?.connected) return existing;

    /*
      The browser we waited on is gone. Retract the handle only if it is still the one we
      were holding: another caller waiting on the same dead browser may have already put a
      replacement in place, and clearing that would strand a live Chrome with no reference
      to it — the very leak this function was restructured to close. When the handle has
      moved on, the next pass simply waits on whatever replaced it.
    */
    if (browserPromise === pending) browserPromise = null;
  }

  throw new ScreenshotUnavailable("Could not start a browser for rendering");
}

export class ScreenshotUnavailable extends Error {}

/** A capture that ran past its budget. Distinct from "unavailable" so callers can retry. */
export class ScreenshotTimeout extends Error {}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejects if `work` has not settled within `ms`. The loser's result is discarded. */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ScreenshotTimeout(`${what} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function cacheKey(url: string, device: DeviceName): string {
  return crypto.createHash("sha256").update(`${device}|${url}`).digest("hex").slice(0, 32);
}

export function cachePathFor(url: string, device: DeviceName): string {
  return path.join(CACHE_DIR, `${cacheKey(url, device)}.webp`);
}

export async function readCached(
  url: string,
  device: DeviceName,
): Promise<{ file: string; capturedAt: number } | null> {
  const file = cachePathFor(url, device);
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > SCREENSHOT_TTL_MS) return null;
    return { file, capturedAt: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * How long a host's public/private verdict is reused inside one capture run.
 *
 * Short on purpose. The cache exists to stop a page issuing sixty requests to one CDN from
 * costing sixty DNS lookups; it is not meant to be a resolver. Ten seconds covers a single
 * page load and expires long before a capture of the same site an hour later.
 */
const DNS_VERDICT_TTL_MS = 10_000;
/** Bounded so a page requesting thousands of distinct hosts cannot grow the process. */
const DNS_VERDICT_MAX = 512;

const dnsVerdicts = new Map<string, { private: boolean; at: number }>();

/**
 * Whether a hostname resolves to anything this server refuses to reach.
 *
 * Fails closed at every step: an unparseable host, a lookup error and an empty answer all
 * report `true`. A screenshot that silently loses one subresource is a slightly worse
 * thumbnail; a screenshot that reaches the loopback interface is an SSRF.
 */
export async function resolvesToPrivateAddress(rawHost: string): Promise<boolean> {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return true;

  // Names that never legitimately appear in a public page, refused without a lookup.
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost|.*\.home\.arpa)$/i.test(host)) return true;

  // A literal address needs no resolution — it is already the thing being checked.
  if (net.isIP(host)) return isPrivateAddress(host);

  const cached = dnsVerdicts.get(host);
  if (cached && Date.now() - cached.at < DNS_VERDICT_TTL_MS) return cached.private;

  let verdict = true;
  try {
    const records = await dns.lookup(host, { all: true });
    // An empty answer is not permission to proceed.
    verdict = !records.length || records.some((record) => isPrivateAddress(record.address));
  } catch {
    verdict = true;
  }

  // Insertion-ordered eviction; see `TtlCache` in `cache.ts` for the same reasoning.
  if (dnsVerdicts.size >= DNS_VERDICT_MAX) {
    const oldest = dnsVerdicts.keys().next();
    if (!oldest.done) dnsVerdicts.delete(oldest.value);
  }
  dnsVerdicts.set(host, { private: verdict, at: Date.now() });
  return verdict;
}

/** Test hook: the verdict cache must not carry between cases. */
export function resetDnsVerdicts(): void {
  dnsVerdicts.clear();
}

/** Keeps the tab count bounded under a batch sweep. */
const gate = createGate(MAX_CONCURRENCY);

/** Current gate state, exposed for diagnostics. */
export const gateState = gate.state;

export interface CaptureResult {
  file: string;
  capturedAt: number;
  fromCache: boolean;
}

/** Loads the page and writes the WebP. Always called under a deadline. */
async function render(page: Page, rawUrl: string, device: DeviceName): Promise<CaptureResult> {
  const viewport = DEVICES[device];
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.scale,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
  });
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

  /*
    Subresource filtering: a page must not be able to pull in private hosts, and
    media/websockets only slow the capture down.

    ## Why this resolves DNS

    The previous filter rejected `localhost`, `*.local`, `*.internal` and literal private
    IPs — and nothing else. That leaves the entire attack open, because the interesting
    case is not a page asking for `http://127.0.0.1:6379`; it is a page asking for
    `http://assets.example.com/x.png` where that name has an A record pointing at
    127.0.0.1. The name passes every pattern above, and Chrome then makes the request to
    the loopback interface on the host running this server.

    The main document is protected — `capture` calls `assertPublicUrl` before navigating —
    but a document is not the only request a page makes, and a redirect or a client-side
    navigation reaches here rather than there. So every request is resolved and checked
    against the same rules the outbound fetcher uses.

    Results are cached because a page issues dozens of requests to a handful of hosts and
    a lookup per request would add real latency to every capture. The cache is small,
    short-lived and per-process; its staleness window is the one place a rebind could still
    land, and a few seconds is a far smaller window than "never checked at all".
  */
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void (async () => {
      try {
        const target = new URL(request.url());

        if (target.protocol !== "http:" && target.protocol !== "https:") {
          await request.abort().catch(() => undefined);
          return;
        }
        if (["media", "websocket", "eventsource"].includes(request.resourceType())) {
          await request.abort().catch(() => undefined);
          return;
        }
        if (await resolvesToPrivateAddress(target.hostname)) {
          await request.abort().catch(() => undefined);
          return;
        }

        await request.continue().catch(() => undefined);
      } catch {
        // Anything unparseable is refused rather than guessed at. `abort` itself can throw
        // when the request was already handled or the page is closing, which is not a
        // failure worth propagating out of an event handler.
        await request.abort().catch(() => undefined);
      }
    })();
  });

  try {
    await page.goto(rawUrl, { waitUntil: "networkidle2", timeout: NAVIGATION_TIMEOUT });
  } catch {
    // Busy pages may never go idle; a painted DOM is enough for a thumbnail.
    await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
  }

  /**
   * Let the page finish becoming itself before capturing it.
   *
   * `networkidle2` means the requests stopped, not that the page is done: hero imagery
   * decodes, webfonts swap, skeleton loaders resolve into content, and cookie banners
   * animate in — all after the network goes quiet. Capturing at that moment produced
   * thumbnails of half-built pages, which is worse than no thumbnail because it looks
   * like the site is broken.
   *
   * Two seconds is the point where, measured across a real library, the great majority
   * of pages have settled. It is charged once per capture and the results are cached for
   * a month, so the cost is paid on a background sweep rather than by anyone waiting.
   */
  await delay(2_000);

  /**
   * Freeze animation before capturing.
   *
   * `page.screenshot()` waits for a stable frame, so a page that animates continuously
   * never gives it one and the capture runs out its whole budget for a thumbnail that
   * would have looked the same anyway. Killing animations and transitions also makes
   * repeat captures of the same page deterministic instead of catching it mid-transition.
   */
  await page
    .addStyleTag({
      content: `*, *::before, *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
        caret-color: transparent !important;
      }`,
    })
    .catch(() => undefined);

  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file = cachePathFor(rawUrl, device);
  await page.screenshot({
    path: file as `${string}.webp`,
    type: "webp",
    quality: 80,
    captureBeyondViewport: false,
  });

  return { file, capturedAt: Date.now(), fromCache: false };
}

/**
 * Renders a page and stores a WebP screenshot, returning the cached copy when fresh.
 * Throws `ScreenshotTimeout` rather than hanging when a page refuses to settle.
 */
export async function capture(
  rawUrl: string,
  device: DeviceName = "desktop",
  options: { refresh?: boolean; priority?: boolean } = {},
): Promise<CaptureResult> {
  if (!options.refresh) {
    const cached = await readCached(rawUrl, device);
    if (cached) return { ...cached, fromCache: true };
  }

  // Validates the scheme and resolves DNS, refusing private addresses.
  await assertPublicUrl(rawUrl);

  await gate.acquire(options.priority);

  /**
   * One budget covers launching, opening the tab and rendering.
   *
   * Splitting it — a short deadline on `newPage()` and a longer one on the render — looks
   * tidier but is wrong: opening a tab is slow precisely when other captures are already
   * running, so the tight sub-deadline fired on healthy pages under load and reported a
   * timeout for work that would have finished. The page handle is held in a box so
   * cleanup can still reach it when the deadline wins.
   */
  const holder: { page?: Page } = {};
  try {
    return await withDeadline(
      (async () => {
        const browser = await getBrowser();
        holder.page = await browser.newPage();
        return render(holder.page, rawUrl, device);
      })(),
      CAPTURE_BUDGET,
      "Capture",
    );
  } finally {
    /**
     * Closing is never awaited here.
     *
     * `page.close()` can hang indefinitely on a page still holding intercepted
     * requests, and awaiting it inside this `finally` meant `release()` never ran: three
     * such pages permanently exhausted the gate and every later capture — including
     * every card in the grid — hung forever with no error to show for it.
     */
    const doomed = holder.page;
    if (doomed) {
      void Promise.race([doomed.close(), delay(CLOSE_GRACE)]).catch(() => undefined);
    }
    gate.release();
  }
}

/**
 * Ceiling on the on-disk screenshot cache.
 *
 * A WebP thumbnail averages 60–120 KB, so a fully captured library of a few thousand
 * bookmarks lands comfortably inside this. The cap exists for the pathological case —
 * repeated re-captures across three viewports over months — where an unbounded cache
 * quietly consumes a disk with files nobody will ever look at again.
 */
const MAX_CACHE_BYTES = intFromEnv("SCREENSHOT_CACHE_MAX_BYTES", 512 * 1024 * 1024, {
  // A megabyte floor: below this the cache cannot hold a single capture, and the prune
  // loop would empty it completely every time it ran.
  min: 1024 * 1024,
});

/** Serialises pruning so two concurrent batches cannot race over the same unlink. */
let pruning: Promise<number> | null = null;

/**
 * Deletes the least-recently-captured screenshots until the cache fits its budget.
 *
 * Eviction is by modification time, which for this cache is capture time: the oldest
 * shots are both the most stale and the least likely to be on screen. Expired entries go
 * first regardless of budget, since `readCached` already refuses to serve them and they
 * are pure dead weight.
 *
 * Returns the number of files removed. Never throws — a cache that cannot be pruned is a
 * disk-space problem, not a reason to fail the capture that triggered it.
 */
export async function pruneCache(): Promise<number> {
  if (pruning) return pruning;

  pruning = (async () => {
    try {
      const names = await fs.readdir(CACHE_DIR);
      const now = Date.now();
      const entries: { file: string; size: number; mtime: number }[] = [];
      let total = 0;

      for (const name of names) {
        const file = path.join(CACHE_DIR, name);
        const stat = await fs.stat(file).catch(() => null);
        if (!stat?.isFile()) continue;
        entries.push({ file, size: stat.size, mtime: stat.mtimeMs });
        total += stat.size;
      }

      // Oldest first, so the loop below can stop as soon as the budget is met.
      entries.sort((a, b) => a.mtime - b.mtime);

      let removed = 0;
      for (const entry of entries) {
        const expired = now - entry.mtime > SCREENSHOT_TTL_MS;
        if (!expired && total <= MAX_CACHE_BYTES) break;
        await fs.rm(entry.file, { force: true }).catch(() => undefined);
        total -= entry.size;
        removed += 1;
      }
      return removed;
    } catch {
      // A missing cache directory simply means nothing has been captured yet.
      return 0;
    } finally {
      pruning = null;
    }
  })();

  return pruning;
}

export async function cacheStats(): Promise<{ files: number; bytes: number }> {
  try {
    const names = await fs.readdir(CACHE_DIR);
    let bytes = 0;
    for (const name of names) {
      const stat = await fs.stat(path.join(CACHE_DIR, name)).catch(() => null);
      if (stat) bytes += stat.size;
    }
    return { files: names.length, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

export async function clearCache(): Promise<number> {
  try {
    const names = await fs.readdir(CACHE_DIR);
    await Promise.all(names.map((name) => fs.rm(path.join(CACHE_DIR, name), { force: true })));
    return names.length;
  } catch {
    return 0;
  }
}

export async function shutdown(): Promise<void> {
  const browser = await browserPromise?.catch(() => null);
  await browser?.close().catch(() => undefined);
  browserPromise = null;
}
