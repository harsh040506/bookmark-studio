/**
 * The HTTP surface the client cannot provide for itself.
 *
 * Four capabilities live here, and only four: reading a page's own metadata, checking
 * whether a link still resolves, locating an archived copy when it does not, and
 * rendering a screenshot. Everything else — search, tagging, similarity, organisation —
 * runs in the browser against local data. No model, no third-party AI service, and no
 * user data ever leaves the machine through this server.
 *
 * ## Trust boundary
 *
 * Every endpoint takes a URL from the client and fetches it. That makes this module the
 * app's SSRF frontier, so *nothing* here calls `fetch` directly: all outbound traffic
 * goes through `safe-fetch`, which re-resolves DNS and refuses private address space on
 * every redirect hop. Rate limits sit in front of the fetching routes so the server
 * cannot be turned into a traffic amplifier aimed at somebody else's infrastructure.
 *
 * ## Caching contract
 *
 * Responses are cached in-process, bounded in both age and entry count. Caches are a
 * courtesy to the sites being read — a library sweep passes over the same URLs
 * repeatedly — and are intentionally not durable: a restart should re-read the web
 * rather than serve answers of unknown age.
 */
import { load } from "cheerio";
import { Router, type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import type { HealthResult, HealthStatus, PageMetadata } from "../shared/types";
import { SingleFlight, TtlCache } from "./cache";
import { rateLimit } from "./rate-limit";
import {
  BlockedUrlError,
  ResponseTooLargeError,
  drain,
  followedFetch,
  mapWithConcurrency,
  readCapped,
  readTruncated,
} from "./safe-fetch";
import { snapshot } from "./snapshot";
import {
  type DeviceName,
  ScreenshotTimeout,
  ScreenshotUnavailable,
  cacheStats,
  capture,
  clearCache,
  findChrome,
  gateState,
  pruneCache,
  readCached,
} from "./screenshot";
import { CircuitOpenError } from "./breaker";

export const api = Router();

/**
 * Cache lifetimes, chosen against how fast each answer actually goes stale.
 *
 * Page metadata and framing headers change on a deploy cadence (hours); link health
 * changes on an outage cadence (minutes). Entry ceilings are sized so a large library
 * sweep fits in one window without letting a hostile caller grow the process without
 * bound.
 */
const METADATA_TTL = 6 * 60 * 60 * 1000;
const HEALTH_TTL = 30 * 60 * 1000;
const FAVICON_TTL = 24 * 60 * 60 * 1000;

const metadataCache = new TtlCache<PageMetadata>({ ttlMs: METADATA_TTL, maxEntries: 4000 });
const healthCache = new TtlCache<HealthResult>({ ttlMs: HEALTH_TTL, maxEntries: 8000 });
const frameableCache = new TtlCache<{ frameable: boolean; reason: string }>({
  ttlMs: METADATA_TTL,
  maxEntries: 4000,
});
/** `null` body records a confirmed absence, so a site without a favicon is asked once. */
const faviconCache = new TtlCache<{ body: Buffer | null; type: string }>({
  ttlMs: FAVICON_TTL,
  maxEntries: 1500,
});

/** Deduplicates concurrent work for the same URL across overlapping batches. */
const metadataFlight = new SingleFlight<PageMetadata>();
const healthFlight = new SingleFlight<HealthResult>();

/**
 * Longest URL accepted from a client.
 *
 * Browsers stop well short of this, and the cap keeps a pathological query string from
 * becoming a cache key that costs more to store than the response it guards.
 */
const MAX_URL_LENGTH = 2048;

/**
 * How much of an HTML document is read before the transfer is cut off.
 *
 * Everything `extractMetadata` looks for — `<title>`, meta tags, the first headings, the
 * opening paragraphs — lives near the top of the document. Reading further buys nothing
 * and, on a page that streams indefinitely, costs everything.
 */
const MAX_HTML_BYTES = 1_500_000;

/** Largest plausible favicon. Anything past this is a misconfigured server, not an icon. */
const MAX_FAVICON_BYTES = 200_000;

/**
 * Ceiling on a JSON reply from a third-party API.
 *
 * `/archive` is the only route that parses somebody else's JSON, and `response.json()`
 * offers no way to bound what it reads before parsing it. Reading to a ceiling first and
 * parsing the buffer keeps a hostile or broken endpoint from turning one lookup into an
 * unbounded allocation.
 */
const MAX_JSON_BYTES = 256_000;

/**
 * Validates and normalises a `url` query parameter.
 *
 * Returns `null` after having already answered the request, so handlers can bail with a
 * single guard clause rather than duplicating the 400 body at every call site.
 */
function readUrlParam(value: unknown, res: Response): string | null {
  const target = typeof value === "string" ? value.trim() : "";
  if (!target) {
    res.status(400).json({ error: "Missing url" });
    return null;
  }
  if (target.length > MAX_URL_LENGTH) {
    res.status(414).json({ error: "URL is too long" });
    return null;
  }
  return target;
}

/**
 * Validates a client-supplied `urls` array.
 *
 * De-duplication matters more than it looks: the client batches by position, so the same
 * URL saved twice under different folders would otherwise be fetched twice inside a
 * single request. The cap is the contract the client chunks against.
 */
function readUrlList(values: unknown[], limit: number): string[] {
  return [
    ...new Set(
      values
        .filter((url): url is string => typeof url === "string")
        .map((url) => url.trim())
        .filter((url) => url.length > 0 && url.length <= MAX_URL_LENGTH),
    ),
  ].slice(0, limit);
}

/**
 * Reported by `/ping` so a stale browser tab left open across a rebuild can tell that
 * the process it is talking to is no longer the one its assets came from.
 */
const SERVER_VERSION = "5.0.0";

/**
 * Shared budget for the routes that reach out to the wider internet.
 *
 * Sized generously enough that a legitimate sweep (batches of 40 health checks, a few
 * seconds apart) never trips it, and tight enough that a runaway loop is stopped inside
 * a minute rather than after it has finished annoying a third party.
 */
const fetchLimiter = rateLimit({ windowMs: 60_000, max: 240, scope: "fetch" });

/**
 * Rendering is far more expensive than fetching, so it gets its own, smaller budget.
 *
 * This covers *captures only*. Reading an already-captured screenshot off disk is not a
 * render and must not be charged as one — see `assetLimiter`.
 */
const renderLimiter = rateLimit({ windowMs: 60_000, max: 60, scope: "render" });

/**
 * Budget for reading cached bytes back out: screenshots, proxied images, favicons.
 *
 * These are the requests a *page of the grid* makes, and there are as many of them as
 * there are cards on screen — twenty, plus twenty more when the next page is warmed on
 * hover. Two pages of ordinary browsing therefore issue eighty requests inside a few
 * seconds, which is unremarkable for static files and instantly fatal under a budget
 * sized for outbound rendering. Charging them to the render limiter is what made a
 * fast-scrolling grid fill with fallbacks: the images were on disk the whole time, and
 * the server was answering 429 to a request that would have been a file read.
 *
 * The ceiling is high because the work is cheap and bounded — every one of these is
 * either a local file or a hard-cached proxy response — but it is not absent, because
 * the proxy routes can still reach the network on a cold cache.
 */
const assetLimiter = rateLimit({ windowMs: 60_000, max: 1200, scope: "asset" });

/**
 * Picks a budget from what the request will actually cost.
 *
 * `mode=cached` (the grid's default) resolves from disk or 404s; anything else opens a
 * browser tab. One route, two very different prices.
 */
function screenshotLimiter(req: Request, res: Response, next: NextFunction): void {
  const renders = req.query.mode === "render" || req.query.refresh === "1";
  (renders ? renderLimiter : assetLimiter)(req, res, next);
}

function statusToHealth(code: number): HealthStatus {
  if (code >= 200 && code < 300) return "live";
  if (code === 401 || code === 403 || code === 402 || code === 429) return "blocked";
  if (code >= 400) return "dead";
  return "live";
}

/** Reads the useful parts of a page: title, description, og:image, favicon, body text. */
function extractMetadata(html: string, finalUrl: string): Omit<PageMetadata, "url"> {
  const $ = load(html);
  const meta = (selector: string) => $(selector).attr("content")?.trim() || undefined;

  const title =
    meta('meta[property="og:title"]') ||
    meta('meta[name="twitter:title"]') ||
    $("title").first().text().trim() ||
    undefined;

  const description =
    meta('meta[name="description"]') ||
    meta('meta[property="og:description"]') ||
    meta('meta[name="twitter:description"]') ||
    undefined;

  const image =
    meta('meta[property="og:image:secure_url"]') ||
    meta('meta[property="og:image"]') ||
    meta('meta[name="twitter:image"]') ||
    meta('meta[name="twitter:image:src"]') ||
    undefined;

  const iconHref =
    $('link[rel="apple-touch-icon"]').attr("href") ||
    $('link[rel="icon"]').attr("href") ||
    $('link[rel="shortcut icon"]').attr("href") ||
    undefined;

  const keywords = (meta('meta[name="keywords"]') || "")
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 12);

  const author =
    meta('meta[name="author"]') ||
    meta('meta[property="article:author"]') ||
    $('[rel="author"]').first().text().trim() ||
    undefined;

  const publishedAt =
    meta('meta[property="article:published_time"]') ||
    meta('meta[name="date"]') ||
    $("time[datetime]").first().attr("datetime") ||
    undefined;

  const lang = $("html").attr("lang")?.split("-")[0] || undefined;
  const feedHref =
    $('link[type="application/rss+xml"]').attr("href") ||
    $('link[type="application/atom+xml"]').attr("href") ||
    undefined;

  // Cheap, deterministic technology fingerprinting — useful for filtering dev bookmarks.
  const generator = meta('meta[name="generator"]') ?? "";
  const rawHtml = $.html();
  const tech = [
    generator.split(/[\s\d.]/)[0],
    /__NEXT_DATA__|\/_next\//.test(rawHtml) ? "Next.js" : "",
    /__NUXT__/.test(rawHtml) ? "Nuxt" : "",
    /data-svelte|__SVELTEKIT/.test(rawHtml) ? "SvelteKit" : "",
    /ng-version=/.test(rawHtml) ? "Angular" : "",
    /wp-content|wp-includes/.test(rawHtml) ? "WordPress" : "",
    /cdn\.shopify\.com/.test(rawHtml) ? "Shopify" : "",
    /webflow/i.test(generator) || /assets\.website-files\.com/.test(rawHtml) ? "Webflow" : "",
    /framerusercontent\.com/.test(rawHtml) ? "Framer" : "",
    /tailwind/i.test(rawHtml) ? "Tailwind" : "",
  ]
    .map((entry) => entry.trim())
    .filter((entry, position, all) => entry.length > 1 && all.indexOf(entry) === position)
    .slice(0, 6);

  // Headings carry strong topical signal and are cheap to index.
  const headings: string[] = [];
  $("h1, h2, h3").each((_, element) => {
    if (headings.length >= 12) return false;
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (text.length > 2 && text.length < 120) headings.push(text);
    return undefined;
  });

  // Body text for extractive summaries and keyword-based tagging.
  $("script, style, noscript, svg, nav, footer, header, form").remove();
  const paragraphs: string[] = [];
  let collected = 0;
  $("h1, h2, p, li").each((_, element) => {
    if (collected >= 3000) return false;
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (text.length > 40) {
      paragraphs.push(text);
      collected += text.length;
    }
    return undefined;
  });

  const wordCount = paragraphs.join(" ").split(/\s+/).length;

  const absolute = (href?: string) => {
    if (!href) return undefined;
    try {
      return new URL(href, finalUrl).toString();
    } catch {
      return undefined;
    }
  };

  /**
   * Outbound links, one per host, so "Discover" has something local to reason over.
   *
   * Deduplicated by hostname and stripped of self-references: a page linking to its own
   * sections forty times says nothing about where else to look, and keeping every one of
   * them would bury the handful of genuinely outbound links under the site's own
   * navigation. Capped hard — a directory page can carry thousands.
   */
  const selfHost = (() => {
    try {
      return new URL(finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const linksByHost = new Map<string, { url: string; text?: string }>();
  $("a[href]").each((_, element) => {
    if (linksByHost.size >= 40) return false;
    const href = absolute($(element).attr("href"));
    if (!href) return undefined;
    let host: string;
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      host = parsed.hostname.replace(/^www\./, "");
    } catch {
      return undefined;
    }
    if (!host || host === selfHost || linksByHost.has(host)) return undefined;
    const text = $(element).text().replace(/\s+/g, " ").trim().slice(0, 80);
    linksByHost.set(host, { url: href, text: text || undefined });
    return undefined;
  });

  /**
   * Typefaces and gradients the page declares.
   *
   * Read out of the page's own inline styles and `<link>`ed font providers rather than by
   * running it, which is the difference between this and the extension-based design
   * analysers: they read `getComputedStyle` on a live DOM and see everything; this sees
   * what the document says about itself, which is less, and costs no browser.
   */
  const fonts = new Set<string>();
  for (const match of rawHtml.matchAll(/font-family\s*:\s*([^;}"']+)/gi)) {
    if (fonts.size >= 8) break;
    const first = match[1].split(",")[0]?.replace(/["']/g, "").trim();
    if (first && first.length < 40 && !/^(inherit|initial|unset|var\()/i.test(first)) {
      fonts.add(first);
    }
  }
  for (const match of rawHtml.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^&"'>]+)/gi)) {
    if (fonts.size >= 8) break;
    fonts.add(decodeURIComponent(match[1].split(":")[0]).replace(/\+/g, " "));
  }

  const gradients = new Set<string>();
  for (const match of rawHtml.matchAll(
    /(linear-gradient|radial-gradient|conic-gradient)\(([^()]|\([^()]*\)){1,200}?\)/gi,
  )) {
    if (gradients.size >= 6) break;
    const value = match[0].replace(/\s+/g, " ").trim();
    if (value.length < 240) gradients.add(value);
  }

  return {
    finalUrl,
    title,
    description,
    siteName: meta('meta[property="og:site_name"]'),
    image: absolute(image),
    icon: absolute(iconHref),
    keywords,
    headings,
    author,
    publishedAt,
    type: meta('meta[property="og:type"]'),
    lang,
    readingMinutes: wordCount > 80 ? Math.max(1, Math.round(wordCount / 220)) : undefined,
    tech,
    feedUrl: absolute(feedHref),
    text: paragraphs.join(" ").slice(0, 3000) || undefined,
    links: linksByHost.size ? [...linksByHost.values()] : undefined,
    fonts: fonts.size ? [...fonts] : undefined,
    gradients: gradients.size ? [...gradients] : undefined,
  };
}

/**
 * Reads one page and returns what it says about itself.
 *
 * Failures are reported as a 200 with an `error` field rather than an HTTP error status.
 * That is deliberate: the client enriches in batches and treats "this page could not be
 * read" as a *result* to record on the bookmark, not as a transport failure to retry.
 * Collapsing the two would make an unreachable site indistinguishable from a broken
 * server and send the background pass into a permanent retry loop.
 */
api.get("/metadata", fetchLimiter, async (req, res) => {
  const target = readUrlParam(req.query.url, res);
  if (!target) return;

  const cached = metadataCache.get(target);
  if (cached) {
    res.setHeader("x-cache", "hit");
    res.json(cached);
    return;
  }

  const value = await metadataFlight.run(target, async (): Promise<PageMetadata> => {
    try {
      const { response, finalUrl } = await followedFetch(target, { timeoutMs: 12_000 });
      if (!response.ok) {
        // Not cached: an HTTP error is frequently transient, and caching it for six
        // hours would hide a site that came back up two minutes later.
        await drain(response);
        return { url: target, finalUrl, keywords: [], error: `HTTP ${response.status}` };
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("html")) {
        // A PDF or image is a legitimate bookmark with nothing to extract. Cached so the
        // background pass does not re-download it on every sweep.
        await drain(response);
        const nonHtml: PageMetadata = { url: target, finalUrl, keywords: [] };
        metadataCache.set(target, nonHtml);
        return nonHtml;
      }

      /*
        Capped read, and now actually capped.

        This previously buffered the whole body and *then* sliced it, which bounded the
        string handed to the parser but not the memory used to produce it: a page that
        streams without a `Content-Length` — or lies about one — was downloaded in full
        before the slice ran. `readTruncated` stops pulling at the ceiling and cancels the
        rest, so an enormous document costs one chunk past the limit instead of all of it.

        A truncated document is still worth parsing: titles, meta tags and the opening
        headings are what this extracts, and every one of them is near the top. Cheerio is
        tolerant of the unclosed tags a mid-document cut leaves behind.
      */
      const buffer = await readTruncated(response, MAX_HTML_BYTES);
      const html = new TextDecoder("utf-8").decode(buffer);
      const parsed: PageMetadata = { url: target, ...extractMetadata(html, finalUrl) };
      metadataCache.set(target, parsed);
      return parsed;
    } catch (error) {
      return {
        url: target,
        keywords: [],
        error: describeFetchFailure(error),
      };
    }
  });

  res.setHeader("x-cache", "miss");
  res.json(value);
});

/**
 * Whether a value is a string naming an ordinary web URL.
 *
 * Used on values that arrive from a third-party API and leave again as something the
 * client may render as a link. The scheme allow-list is the point: `javascript:` and
 * `data:` are both valid to `new URL`, and both are links that do something other than
 * navigate.
 */
function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Turns a thrown fetch failure into a short phrase fit for a bookmark record.
 *
 * The distinction that matters to a reader is *why* a page could not be read: refused
 * by policy, too slow, or simply unreachable. Anything else is collapsed rather than
 * leaking a Node error string into the UI.
 */
function describeFetchFailure(error: unknown): string {
  if (error instanceof BlockedUrlError) return error.message;
  if (error instanceof CircuitOpenError) return "Site not responding";
  if (error instanceof Error && error.name === "AbortError") return "Timed out";
  if (error instanceof Error && /ENOTFOUND|EAI_AGAIN/.test(error.message)) {
    return "Domain does not resolve";
  }
  return "Fetch failed";
}

/**
 * Resolves the health of one URL.
 *
 * Strategy: a `HEAD` first, because it is the cheapest way to learn a status code, then
 * a ranged `GET` when the server mishandles `HEAD` — a large minority answer 405, 501
 * or a 5xx to it while serving the page perfectly well, and judging those as dead would
 * mark healthy links broken.
 *
 * Both outcomes are cached, successes and failures alike: a sweep over a library
 * revisits the same URL from several batches, and a site that is down stays down for
 * longer than the cache window.
 */
async function checkOne(url: string): Promise<HealthResult> {
  const cached = healthCache.get(url);
  if (cached) return cached;

  return healthFlight.run(url, async () => {
    const started = Date.now();
    const attempt = (method: "HEAD" | "GET") =>
      followedFetch(url, {
        method,
        timeoutMs: 9_000,
        // Only the status line is needed, so ask for as few bytes as the server will give.
        headers: method === "GET" ? { range: "bytes=0-2048" } : undefined,
      });

    try {
      let { response, finalUrl, redirectCount } = await attempt("HEAD");

      if (response.status === 405 || response.status === 501 || response.status >= 500) {
        ({ response, finalUrl, redirectCount } = await attempt("GET"));
      }

      // Release the socket rather than leaving a body suspended on a keep-alive connection.
      await drain(response);

      const status: HealthStatus =
        redirectCount > 0 && response.status < 400 ? "redirected" : statusToHealth(response.status);

      const result: HealthResult = {
        url,
        status,
        httpCode: response.status,
        finalUrl,
        redirectCount,
        elapsedMs: Date.now() - started,
      };
      healthCache.set(url, result);
      return result;
    } catch (error) {
      const result: HealthResult = {
        url,
        status: "dead",
        redirectCount: 0,
        elapsedMs: Date.now() - started,
        error: describeFetchFailure(error),
      };
      // A skip by the breaker is not a real check, so it is not remembered: the next sweep
      // after the cool-off asks the site itself.
      if (!(error instanceof CircuitOpenError)) healthCache.set(url, result);
      return result;
    }
  });
}

/**
 * Batch link check.
 *
 * The batch is capped and de-duplicated before dispatch, and concurrency is held at 8:
 * a library sweep should feel like a browser reading a few tabs, not like a scanner.
 */
api.post("/health", fetchLimiter, async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? (req.body.urls as unknown[]) : [];
  const targets = readUrlList(urls, 100);

  if (!targets.length) {
    res.status(400).json({ error: "Provide a urls array" });
    return;
  }
  const results = await mapWithConcurrency(targets, 8, checkOne);
  res.json({ results });
});

/**
 * Finds the closest Wayback Machine snapshot of a URL.
 *
 * Offered only for links the health check has already declared dead, so a bookmark that
 * outlived its site still leads somewhere. Failure is answered as a 200 with no
 * `archiveUrl`: "no snapshot exists" and "archive.org is unreachable" are the same
 * outcome from the user's side — there is nothing to open — and the client shows the
 * same message for both.
 */
api.get("/archive", fetchLimiter, async (req, res) => {
  const target = readUrlParam(req.query.url, res);
  if (!target) return;

  try {
    const endpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(target)}`;
    const { response } = await followedFetch(endpoint, { timeoutMs: 8_000 });
    if (!response.ok) {
      await drain(response);
      res.json({ url: target, archiveUrl: undefined });
      return;
    }

    // Bounded read, then parse — `response.json()` would read whatever it was sent.
    const payload = JSON.parse(
      (await readCapped(response, MAX_JSON_BYTES)).toString("utf8") || "{}",
    ) as unknown;

    /*
      The reply is validated rather than asserted into shape.

      This is the one place the server takes a *value* from a third party and passes it
      to the client, and the client turns `archiveUrl` into a link. A cast alone would
      let `archived_snapshots.closest.url` be any JSON at all — an object, or a
      `javascript:` URL — and hand it onward as though it had been checked.
    */
    const closest =
      payload && typeof payload === "object"
        ? (payload as { archived_snapshots?: { closest?: unknown } }).archived_snapshots?.closest
        : undefined;
    const snapshotUrl =
      closest && typeof closest === "object"
        ? (closest as { url?: unknown }).url
        : undefined;
    const timestamp =
      closest && typeof closest === "object"
        ? (closest as { timestamp?: unknown }).timestamp
        : undefined;

    res.json({
      url: target,
      archiveUrl: isSafeHttpUrl(snapshotUrl) ? snapshotUrl : undefined,
      timestamp: typeof timestamp === "string" ? timestamp.slice(0, 32) : undefined,
    });
  } catch {
    res.json({ url: target, archiveUrl: undefined });
  }
});

/**
 * Tells the browser not to keep a copy.
 *
 * Counter-intuitive on an image endpoint, and deliberate. The client stores every asset it
 * fetches in its own IndexedDB store (see `src/lib/assets.ts`), which is what makes the
 * library work offline, survive a cache eviction and be able to report — and clear — its
 * own storage. Letting the browser *also* hold these bytes would mean every screenshot
 * was stored twice on the same disk, with the second copy invisible to the app and to the
 * user, evicted on a schedule neither of them controls.
 *
 * So: exactly one cache, and it is the one the app can account for.
 */
function noStore(res: Response): void {
  res.setHeader("cache-control", "no-store, max-age=0");
}

/**
 * Streams a remote preview image through this origin.
 *
 * Sites routinely refuse hotlinked images or omit CORS headers, which would show up in
 * the moodboard as a wall of broken-image icons. Proxying also means the browser never
 * announces the user's bookmark list to a third party by requesting its assets directly.
 *
 * The response is streamed to a byte ceiling instead of being buffered whole: an
 * `og:image` pointing at a 200 MB file must fail cheaply rather than consuming that much
 * server memory before the size check runs.
 */
api.get("/image", assetLimiter, async (req, res) => {
  const target = readUrlParam(req.query.url, res);
  if (!target) return;

  const MAX_IMAGE_BYTES = 5_000_000;

  try {
    const { response } = await followedFetch(target, { timeoutMs: 10_000 });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.startsWith("image/")) {
      await drain(response);
      res.status(404).end();
      return;
    }

    /*
      One bounded read replaces the declared-length check plus a full buffer.

      The old pair looked like a belt-and-braces size guard and was neither: the header
      check only fired when the remote server volunteered a length, and the check after
      `arrayBuffer()` ran once the bytes were already in the heap — which is the exact
      moment it was supposed to prevent. `readCapped` performs both halves, and enforces
      the second one against the bytes as they arrive.
    */
    const buffer = await readCapped(response, MAX_IMAGE_BYTES);

    res.setHeader("content-type", contentType);
    res.setHeader("content-length", String(buffer.byteLength));
    // See `noStore` — the client owns this cache now.
    noStore(res);
    // The bytes come from an arbitrary remote host: never let a browser sniff them into
    // something executable, and never let them be framed.
    res.setHeader("x-content-type-options", "nosniff");
    res.end(buffer);
  } catch (error) {
    // "Too big" is a different answer from "could not fetch", and the client's fallback
    // chain treats them differently: an oversized image will never fit, so there is no
    // point retrying it, while a 502 is worth another attempt later.
    res.status(error instanceof ResponseTooLargeError ? 413 : 502).end();
  }
});

/**
 * A self-contained, offline-readable copy of a page.
 *
 * Charged to the render budget rather than the fetch budget: one call fetches the
 * document plus up to a hundred and twenty subresources, which costs a third-party site
 * far more than a metadata read and belongs under the tighter ceiling.
 *
 * The body is `text/html` but is served with `no-store` and a download disposition, and
 * the *client* never renders it into this origin — it is stored as bytes and opened in a
 * sandboxed frame. Serving it inline here would put arbitrary third-party markup on this
 * origin, which is the one thing every other route in this file is careful to avoid.
 */
api.get("/snapshot", renderLimiter, async (req, res) => {
  const target = readUrlParam(req.query.url, res);
  if (!target) return;

  try {
    const result = await snapshot(target);
    if (result.error || !result.html) {
      res.status(200).json({
        url: target,
        bytes: 0,
        inlined: 0,
        skipped: 0,
        error: result.error ?? "Nothing to archive",
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-disposition", "attachment; filename=\"snapshot.html\"");
    res.setHeader("x-snapshot-inlined", String(result.inlined));
    res.setHeader("x-snapshot-skipped", String(result.skipped));
    res.setHeader("x-snapshot-bytes", String(result.bytes));
    if (result.finalUrl) res.setHeader("x-snapshot-final-url", encodeURI(result.finalUrl));
    noStore(res);
    res.setHeader("x-content-type-options", "nosniff");
    res.end(result.html);
  } catch (error) {
    res.status(502).json({
      url: target,
      bytes: 0,
      inlined: 0,
      skipped: 0,
      error: describeFetchFailure(error),
    });
  }
});

/**
 * Streams a remote media file (an image or a video) through this origin.
 *
 * Separate from `/api/image` because the ceiling is different by two orders of magnitude:
 * a preview image is capped at 5 MB because nothing needs more, while a saved video is
 * routinely tens of megabytes and is the whole point of "available offline". Range
 * requests are passed through so a partially-downloaded video still seeks.
 */
api.get("/media", assetLimiter, async (req, res) => {
  const target = readUrlParam(req.query.url, res);
  if (!target) return;

  const MAX_MEDIA_BYTES = 120_000_000;

  try {
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    const { response } = await followedFetch(target, {
      timeoutMs: 30_000,
      headers: range ? { range } : undefined,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const isMedia = contentType.startsWith("image/") || contentType.startsWith("video/");
    if (!response.ok || !isMedia) {
      await drain(response);
      res.status(404).end();
      return;
    }

    // Bounded as it arrives rather than measured after the fact — see `/api/image`. The
    // ceiling here is two orders of magnitude higher, which makes the unbounded version
    // that much more dangerous: a chunked response with no declared length had no limit
    // at all, and this route exists to fetch video.
    const buffer = await readCapped(response, MAX_MEDIA_BYTES);

    res.status(response.status === 206 ? 206 : 200);
    res.setHeader("content-type", contentType);
    res.setHeader("content-length", String(buffer.byteLength));
    const contentRange = response.headers.get("content-range");
    if (contentRange) res.setHeader("content-range", contentRange);
    res.setHeader("accept-ranges", "bytes");
    noStore(res);
    res.setHeader("x-content-type-options", "nosniff");
    res.end(buffer);
  } catch (error) {
    res.status(error instanceof ResponseTooLargeError ? 413 : 502).end();
  }
});

/**
 * Can this URL be embedded in an iframe?
 *
 * The browser cannot answer this for itself: a blocked frame still fires `load`, and
 * cross-origin rules forbid inspecting what rendered — which is exactly how a preview
 * ends up labelled "live" while showing an empty box. The response headers give a
 * definitive answer, so the client asks here before choosing a preview tier.
 */
api.get("/frameable", fetchLimiter, async (req, res) => {
  const target = readUrlParam(req.query.url, res);
  if (!target) return;

  const cached = frameableCache.get(target);
  if (cached) {
    res.setHeader("x-cache", "hit");
    res.json(cached);
    return;
  }

  try {
    const { response } = await followedFetch(target, { method: "GET", timeoutMs: 8_000 });
    const value = evaluateFraming(
      response.headers.get("x-frame-options"),
      response.headers.get("content-security-policy"),
    );
    await drain(response);
    frameableCache.set(target, value);
    res.json(value);
  } catch {
    // Not cached: an unreachable site should be re-probed rather than written off for
    // six hours on the strength of one bad moment.
    res.json({ frameable: false, reason: "unreachable" });
  }
});

export function evaluateFraming(
  xFrameOptions: string | null,
  csp: string | null,
): { frameable: boolean; reason: string } {
  const xfo = xFrameOptions?.trim().toLowerCase();
  if (xfo === "deny") return { frameable: false, reason: "X-Frame-Options: DENY" };
  if (xfo === "sameorigin") return { frameable: false, reason: "X-Frame-Options: SAMEORIGIN" };
  if (xfo?.startsWith("allow-from")) {
    return { frameable: false, reason: "X-Frame-Options restricts the origin" };
  }

  // CSP frame-ancestors supersedes X-Frame-Options where both are present.
  const directive = csp
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("frame-ancestors"));

  if (directive) {
    const sources = directive.split(/\s+/).slice(1).map((source) => source.toLowerCase());
    if (sources.includes("*")) return { frameable: true, reason: "frame-ancestors *" };
    if (sources.includes("'none'")) return { frameable: false, reason: "frame-ancestors 'none'" };
    // Anything else is an allow-list we are not on.
    return { frameable: false, reason: `frame-ancestors ${sources.join(" ")}` };
  }

  return { frameable: true, reason: "no framing restriction" };
}

/**
 * Screenshot preview.
 *
 * `mode=cached` (the default) never renders — it answers only from disk, so a grid of
 * hundreds of cards costs nothing. `mode=render` captures on demand and is used by the
 * detail panel and the batch capture job.
 */
api.get("/screenshot", screenshotLimiter, async (req, res) => {
  const target = readUrlParam(req.query.url, res);
  if (!target) return;

  const device = readDevice(req.query.device);
  const mode = req.query.mode === "render" ? "render" : "cached";
  const refresh = req.query.refresh === "1";

  try {
    if (mode === "cached" && !refresh) {
      const cached = await readCached(target, device);
      if (!cached) {
        // 404 is the contract the client's preview probe relies on: it means "nothing
        // captured", not "something went wrong", and costs milliseconds to answer.
        res.status(404).json({ error: "Not captured yet" });
        return;
      }
      sendImage(res, cached.file, cached.capturedAt);
      return;
    }

    // A single render is always something a person is waiting on, so it jumps ahead of
    // the background sweep rather than queueing behind tens of seconds of it.
    const result = await capture(target, device, { refresh, priority: true });
    sendImage(res, result.file, result.capturedAt);
  } catch (error) {
    respondToCaptureError(res, error);
  }
});

/** Narrows an untrusted `device` parameter to a supported viewport. */
function readDevice(value: unknown): DeviceName {
  return (["desktop", "tablet", "mobile"] as const).includes(value as DeviceName)
    ? (value as DeviceName)
    : "desktop";
}

/**
 * Maps a capture failure onto a status the client can act on.
 *
 * The distinction carries real meaning downstream: 503 means "this machine cannot render
 * at all", which the UI turns into a single "install Chrome" message rather than a
 * per-bookmark error, while 504 means "this particular page would not settle" and leaves
 * the rest of a batch worth attempting.
 */
function respondToCaptureError(res: Response, error: unknown): void {
  if (error instanceof ScreenshotUnavailable) {
    res.status(503).json({ error: error.message });
    return;
  }
  if (error instanceof ScreenshotTimeout) {
    // A definite answer beats an open socket: the client falls back to its next tier.
    res.status(504).json({ error: "That page took too long to render" });
    return;
  }
  if (error instanceof BlockedUrlError) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(502).json({ error: "Could not capture that page" });
}

function sendImage(res: Response, file: string, capturedAt: number): void {
  res.setHeader("content-type", "image/webp");
  noStore(res);
  res.setHeader("x-content-type-options", "nosniff");
  // Lets the client label a preview with its true age rather than "just now".
  res.setHeader("x-captured-at", String(capturedAt));
  res.sendFile(path.resolve(file));
}

/**
 * Batch capture with a JSON summary, driven by the client's progress bar.
 *
 * Per-URL failures are reported inside a 200 response rather than failing the batch:
 * one page that refuses to render must not discard the twenty-four that succeeded.
 */
api.post("/screenshot/batch", renderLimiter, async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? (req.body.urls as unknown[]) : [];
  const device = readDevice(req.body?.device);
  const targets = readUrlList(urls, 25);

  if (!targets.length) {
    res.status(400).json({ error: "Provide a urls array" });
    return;
  }
  if (!findChrome()) {
    res.status(503).json({ error: "No Chrome or Edge installation found" });
    return;
  }

  // Dispatched together; the screenshot gate — not this loop — decides how many tabs
  // actually open at once.
  const results = await Promise.all(
    targets.map(async (url) => {
      try {
        const shot = await capture(url, device);
        return { url, ok: true, capturedAt: shot.capturedAt, fromCache: shot.fromCache };
      } catch (error) {
        return { url, ok: false, reason: describeFetchFailure(error) };
      }
    }),
  );

  // Pruning after a batch keeps the on-disk cache bounded without a background timer,
  // which would otherwise hold the event loop open and delay a clean shutdown.
  void pruneCache().catch(() => undefined);

  res.json({ results });
});

api.get("/screenshot/cache", async (_req, res) => {
  // `pool` reports open tabs (never above five), queued captures and browser restarts.
  res.json({ ...(await cacheStats()), available: Boolean(findChrome()), pool: gateState() });
});

api.delete("/screenshot/cache", async (_req, res) => {
  res.json({ cleared: await clearCache() });
});

/**
 * Favicon proxy.
 *
 * Chrome embeds a favicon for most bookmarks, but not all, and the gaps tend to be the
 * bookmarks a user is least able to recognise by title alone. Falling back to a public
 * favicon service would hand a third party the full list of domains someone has saved,
 * which contradicts the point of a local-first library — so the icon is fetched from the
 * site itself, through this origin.
 *
 * A confirmed absence is cached as emphatically as a hit. Without that, every render of
 * every card belonging to an icon-less domain re-attempts two HTTP requests.
 */
api.get("/favicon", assetLimiter, async (req, res) => {
  const domain = normaliseDomain(req.query.domain);
  if (!domain) {
    res.status(400).end();
    return;
  }

  const cached = faviconCache.get(domain);
  if (cached) {
    if (!cached.body) {
      res.status(404).end();
      return;
    }
    sendFavicon(res, cached.body, cached.type);
    return;
  }

  const candidates = [`https://${domain}/favicon.ico`, `https://${domain}/favicon.png`];
  for (const candidate of candidates) {
    try {
      const { response } = await followedFetch(candidate, { timeoutMs: 6_000 });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.startsWith("image/")) {
        await drain(response);
        continue;
      }
      // An empty or implausibly large "icon" is a misconfigured server, not an icon — and
      // the ceiling is enforced during the transfer, so a host answering `/favicon.ico`
      // with a gigabyte cannot make this route hold a gigabyte before rejecting it.
      const body = await readCapped(response, MAX_FAVICON_BYTES).catch(() => null);
      if (!body?.byteLength) continue;
      faviconCache.set(domain, { body, type });
      sendFavicon(res, body, type);
      return;
    } catch {
      // Try the next candidate; a domain with no icon is an ordinary outcome.
    }
  }

  faviconCache.set(domain, { body: null, type: "" });
  res.status(404).end();
});

/**
 * Reduces an arbitrary `domain` parameter to a bare hostname.
 *
 * Callers pass hostnames, but a stray scheme or path would otherwise be spliced straight
 * into the candidate URLs above. Anything that is not a plausible hostname is rejected
 * rather than repaired — guessing at malformed input is how a proxy grows an open
 * redirect.
 */
function normaliseDomain(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const host = raw.replace(/^https?:\/\//, "").split("/")[0].split("?")[0];
  if (!host || host.length > 253) return null;
  if (!/^[a-z0-9.\-]+$/.test(host)) return null;
  if (!host.includes(".")) return null;
  return host;
}

function sendFavicon(res: Response, body: Buffer, type: string): void {
  res.setHeader("content-type", type);
  noStore(res);
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

/**
 * Liveness probe.
 *
 * The client polls this to decide whether server-backed features are offered at all, and
 * reports `screenshots` separately because a machine without Chrome can still read pages
 * and check links — degrading one capability must not disable the rest.
 */
api.get("/ping", (_req, res) => {
  res.json({
    ok: true,
    screenshots: Boolean(findChrome()),
    version: SERVER_VERSION,
  });
});

/**
 * Terminal 404 for the API namespace.
 *
 * Without it an unknown `/api/...` path falls through to the SPA catch-all and returns
 * `index.html` with a 200, so a client-side typo surfaces as "unexpected token < in
 * JSON" instead of a plain not-found.
 */
api.use((_req, res) => {
  res.status(404).json({ error: "No such endpoint" });
});
