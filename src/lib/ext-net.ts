/**
 * The extension's browser-native answer to four network capabilities a page cannot
 * provide for itself: reading a page's own metadata, checking link health, finding an
 * archived copy, and (via `ext-shots.ts`) rendering a screenshot.
 *
 * A browser page ordinarily cannot read another origin's response headers or body under
 * CORS, and cannot drive a headless renderer. An extension page or service worker with
 * `host_permissions` is not subject to either restriction: cross-origin `fetch` responses
 * are readable in full, and `chrome.tabs`/`chrome.windows` stand in for a headless
 * browser. So every one of those capabilities is implemented here against the same
 * contracts (`PageMetadata`, `HealthResult`, `SnapshotResult`) the rest of the app
 * speaks, and nothing above `lib/api.ts` needs to know how any of it actually happens.
 */
import type { HealthResult, HealthStatus, PageMetadata } from "../../shared/types";
import {
  BlockedUrlError,
  ResponseTooLargeError,
  assertPlausiblyPublic,
  describeFetchFailure,
  drain,
  guardedFetch,
  isSafeHttpUrl,
  mapWithConcurrency,
  readCapped,
  readTruncated,
} from "./net-guard";
import { INERT_HANDLER_PREFIX, inertHtml } from "./inert-html";

const MAX_HTML_BYTES = 1_500_000;
const MAX_FAVICON_BYTES = 200_000;
const MAX_JSON_BYTES = 256_000;

/* ------------------------------------------------------------ small caches */

/** Session-only, in-memory. There is no separate long-lived process to hold a disk cache
 *  in, so a reload simply re-reads the web — the same trade-off the server makes on
 *  restart. */
class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}
  get(key: string): T | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }
  set(key: string, value: T): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

const metadataCache = new TtlCache<PageMetadata>(6 * 60 * 60 * 1000, 4000);
const healthCache = new TtlCache<HealthResult>(30 * 60 * 1000, 8000);
const frameableCache = new TtlCache<{ frameable: boolean; reason: string }>(6 * 60 * 60 * 1000, 4000);

/* -------------------------------------------------------------- metadata */

function metaContent(doc: Document, selector: string): string | undefined {
  return doc.querySelector(selector)?.getAttribute("content")?.trim() || undefined;
}

function absoluteUrl(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

/** Reads a page's own title, description, headings and body text via `DOMParser`. */
function extractMetadata(html: string, finalUrl: string): Omit<PageMetadata, "url"> {
  const doc = new DOMParser().parseFromString(inertHtml(html), "text/html");

  const title =
    metaContent(doc, 'meta[property="og:title"]') ||
    metaContent(doc, 'meta[name="twitter:title"]') ||
    doc.querySelector("title")?.textContent?.trim() ||
    undefined;

  const description =
    metaContent(doc, 'meta[name="description"]') ||
    metaContent(doc, 'meta[property="og:description"]') ||
    metaContent(doc, 'meta[name="twitter:description"]') ||
    undefined;

  const image =
    metaContent(doc, 'meta[property="og:image:secure_url"]') ||
    metaContent(doc, 'meta[property="og:image"]') ||
    metaContent(doc, 'meta[name="twitter:image"]') ||
    metaContent(doc, 'meta[name="twitter:image:src"]') ||
    undefined;

  const iconHref =
    doc.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") ||
    doc.querySelector('link[rel="icon"]')?.getAttribute("href") ||
    doc.querySelector('link[rel="shortcut icon"]')?.getAttribute("href") ||
    undefined;

  const keywords = (metaContent(doc, 'meta[name="keywords"]') || "")
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 12);

  const author =
    metaContent(doc, 'meta[name="author"]') ||
    metaContent(doc, 'meta[property="article:author"]') ||
    doc.querySelector('[rel="author"]')?.textContent?.trim() ||
    undefined;

  const publishedAt =
    metaContent(doc, 'meta[property="article:published_time"]') ||
    metaContent(doc, 'meta[name="date"]') ||
    doc.querySelector("time[datetime]")?.getAttribute("datetime") ||
    undefined;

  const lang = doc.querySelector("html")?.getAttribute("lang")?.split("-")[0] || undefined;
  const feedHref =
    doc.querySelector('link[type="application/rss+xml"]')?.getAttribute("href") ||
    doc.querySelector('link[type="application/atom+xml"]')?.getAttribute("href") ||
    undefined;

  const generator = metaContent(doc, 'meta[name="generator"]') ?? "";
  const tech = [
    generator.split(/[\s\d.]/)[0],
    /__NEXT_DATA__|\/_next\//.test(html) ? "Next.js" : "",
    /__NUXT__/.test(html) ? "Nuxt" : "",
    /data-svelte|__SVELTEKIT/.test(html) ? "SvelteKit" : "",
    /ng-version=/.test(html) ? "Angular" : "",
    /wp-content|wp-includes/.test(html) ? "WordPress" : "",
    /cdn\.shopify\.com/.test(html) ? "Shopify" : "",
    /webflow/i.test(generator) || /assets\.website-files\.com/.test(html) ? "Webflow" : "",
    /framerusercontent\.com/.test(html) ? "Framer" : "",
    /tailwind/i.test(html) ? "Tailwind" : "",
  ]
    .map((entry) => entry.trim())
    .filter((entry, position, all) => entry.length > 1 && all.indexOf(entry) === position)
    .slice(0, 6);

  const headings: string[] = [];
  for (const element of doc.querySelectorAll("h1, h2, h3")) {
    if (headings.length >= 12) break;
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 2 && text.length < 120) headings.push(text);
  }

  // Same removal cheerio performed in place, ahead of extracting body text.
  doc.querySelectorAll("script, style, noscript, svg, nav, footer, header, form").forEach((el) => el.remove());
  const paragraphs: string[] = [];
  let collected = 0;
  for (const element of doc.querySelectorAll("h1, h2, p, li")) {
    if (collected >= 3000) break;
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 40) {
      paragraphs.push(text);
      collected += text.length;
    }
  }
  const wordCount = paragraphs.join(" ").split(/\s+/).length;

  const selfHost = (() => {
    try {
      return new URL(finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const linksByHost = new Map<string, { url: string; text?: string }>();
  for (const element of doc.querySelectorAll("a[href]")) {
    if (linksByHost.size >= 40) break;
    const href = absoluteUrl(element.getAttribute("href"), finalUrl);
    if (!href) continue;
    let host: string;
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      host = parsed.hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (!host || host === selfHost || linksByHost.has(host)) continue;
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    linksByHost.set(host, { url: href, text: text || undefined });
  }

  const fonts = new Set<string>();
  for (const match of html.matchAll(/font-family\s*:\s*([^;}"']+)/gi)) {
    if (fonts.size >= 8) break;
    const first = match[1].split(",")[0]?.replace(/["']/g, "").trim();
    if (first && first.length < 40 && !/^(inherit|initial|unset|var\()/i.test(first)) fonts.add(first);
  }
  for (const match of html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^&"'>]+)/gi)) {
    if (fonts.size >= 8) break;
    fonts.add(decodeURIComponent(match[1].split(":")[0]).replace(/\+/g, " "));
  }

  const gradients = new Set<string>();
  for (const match of html.matchAll(
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
    siteName: metaContent(doc, 'meta[property="og:site_name"]'),
    image: absoluteUrl(image, finalUrl),
    icon: absoluteUrl(iconHref, finalUrl),
    keywords,
    headings,
    author,
    publishedAt,
    type: metaContent(doc, 'meta[property="og:type"]'),
    lang,
    readingMinutes: wordCount > 80 ? Math.max(1, Math.round(wordCount / 220)) : undefined,
    tech,
    feedUrl: absoluteUrl(feedHref, finalUrl),
    text: paragraphs.join(" ").slice(0, 3000) || undefined,
    links: linksByHost.size ? [...linksByHost.values()] : undefined,
    fonts: fonts.size ? [...fonts] : undefined,
    gradients: gradients.size ? [...gradients] : undefined,
  };
}

export async function extFetchMetadata(target: string): Promise<PageMetadata> {
  const cached = metadataCache.get(target);
  if (cached) return cached;

  try {
    const { response, finalUrl } = await guardedFetch(target, { timeoutMs: 12_000 });
    if (!response.ok) {
      await drain(response);
      return { url: target, finalUrl, keywords: [], error: `HTTP ${response.status}` };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      await drain(response);
      const nonHtml: PageMetadata = { url: target, finalUrl, keywords: [] };
      metadataCache.set(target, nonHtml);
      return nonHtml;
    }
    const buffer = await readTruncated(response, MAX_HTML_BYTES);
    const html = new TextDecoder("utf-8").decode(buffer);
    const parsed: PageMetadata = { url: target, ...extractMetadata(html, finalUrl) };
    metadataCache.set(target, parsed);
    return parsed;
  } catch (error) {
    return { url: target, keywords: [], error: describeFetchFailure(error) };
  }
}

/* ---------------------------------------------------------------- health */

function statusToHealth(code: number): HealthStatus {
  if (code >= 200 && code < 300) return "live";
  if (code === 401 || code === 403 || code === 402 || code === 429) return "blocked";
  if (code >= 400) return "dead";
  return "live";
}

async function checkOne(url: string): Promise<HealthResult> {
  const cached = healthCache.get(url);
  if (cached) return cached;

  const started = Date.now();
  const attempt = (method: "HEAD" | "GET") =>
    guardedFetch(url, {
      method,
      timeoutMs: 9_000,
      headers: method === "GET" ? { range: "bytes=0-2048" } : undefined,
    });

  try {
    let { response, finalUrl, redirected } = await attempt("HEAD");
    if (response.status === 405 || response.status === 501 || response.status >= 500) {
      ({ response, finalUrl, redirected } = await attempt("GET"));
    }
    await drain(response);

    const status: HealthStatus =
      redirected && response.status < 400 ? "redirected" : statusToHealth(response.status);

    const result: HealthResult = {
      url,
      status,
      httpCode: response.status,
      finalUrl,
      // A browser's high-level `fetch` does not expose the hop count of an automatic
      // redirect chain, only whether one happened at all.
      redirectCount: redirected ? 1 : 0,
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
    healthCache.set(url, result);
    return result;
  }
}

export async function extCheckHealth(urls: string[]): Promise<{ results: HealthResult[] }> {
  const targets = [...new Set(urls)].slice(0, 100);
  const results = await mapWithConcurrency(targets, 8, checkOne);
  return { results };
}

/* --------------------------------------------------------------- archive */

export async function extFetchArchiveUrl(
  target: string,
): Promise<{ archiveUrl?: string; timestamp?: string }> {
  try {
    const endpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(target)}`;
    const { response } = await guardedFetch(endpoint, { timeoutMs: 8_000 });
    if (!response.ok) {
      await drain(response);
      return { archiveUrl: undefined };
    }
    const bytes = await readCapped(response, MAX_JSON_BYTES);
    const payload = JSON.parse(new TextDecoder("utf-8").decode(bytes) || "{}") as unknown;
    const closest =
      payload && typeof payload === "object"
        ? (payload as { archived_snapshots?: { closest?: unknown } }).archived_snapshots?.closest
        : undefined;
    const snapshotUrl = closest && typeof closest === "object" ? (closest as { url?: unknown }).url : undefined;
    const timestamp =
      closest && typeof closest === "object" ? (closest as { timestamp?: unknown }).timestamp : undefined;
    return {
      archiveUrl: isSafeHttpUrl(snapshotUrl) ? snapshotUrl : undefined,
      timestamp: typeof timestamp === "string" ? timestamp.slice(0, 32) : undefined,
    };
  } catch {
    return { archiveUrl: undefined };
  }
}

/* ------------------------------------------------------------- frameable */

export function evaluateFraming(
  xFrameOptions: string | null,
  csp: string | null,
): { frameable: boolean; reason: string } {
  const xfo = xFrameOptions?.trim().toLowerCase();
  if (xfo === "deny") return { frameable: false, reason: "X-Frame-Options: DENY" };
  if (xfo === "sameorigin") return { frameable: false, reason: "X-Frame-Options: SAMEORIGIN" };
  if (xfo?.startsWith("allow-from")) return { frameable: false, reason: "X-Frame-Options restricts the origin" };

  const directive = csp
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("frame-ancestors"));

  if (directive) {
    const sources = directive.split(/\s+/).slice(1).map((source) => source.toLowerCase());
    if (sources.includes("*")) return { frameable: true, reason: "frame-ancestors *" };
    if (sources.includes("'none'")) return { frameable: false, reason: "frame-ancestors 'none'" };
    return { frameable: false, reason: `frame-ancestors ${sources.join(" ")}` };
  }
  return { frameable: true, reason: "no framing restriction" };
}

export async function extCheckFrameable(target: string): Promise<{ frameable: boolean; reason: string }> {
  const cached = frameableCache.get(target);
  if (cached) return cached;
  try {
    const { response } = await guardedFetch(target, { method: "GET", timeoutMs: 8_000 });
    const value = evaluateFraming(
      response.headers.get("x-frame-options"),
      response.headers.get("content-security-policy"),
    );
    await drain(response);
    frameableCache.set(target, value);
    return value;
  } catch {
    return { frameable: false, reason: "unreachable" };
  }
}

/* --------------------------------------------------------------- favicon */

function normaliseDomain(value: string): string | null {
  const raw = value.trim().toLowerCase();
  const host = raw.replace(/^https?:\/\//, "").split("/")[0].split("?")[0];
  if (!host || host.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (!host.includes(".")) return null;
  return host;
}

/**
 * Fetches a domain's favicon straight from the site, trying `.ico` then `.png`.
 *
 * Direct rather than through a third-party favicon service, for the same reason the
 * server proxied it: asking somebody else for an icon per domain hands them the list of
 * sites this library has saved.
 */
export async function extFetchFavicon(domainRaw: string): Promise<Blob | null> {
  const domain = normaliseDomain(domainRaw);
  if (!domain) return null;

  const candidates = [`https://${domain}/favicon.ico`, `https://${domain}/favicon.png`];
  for (const candidate of candidates) {
    try {
      const { response } = await guardedFetch(candidate, { timeoutMs: 6_000 });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.startsWith("image/")) {
        await drain(response);
        continue;
      }
      const bytes = await readCapped(response, MAX_FAVICON_BYTES).catch(() => null);
      if (!bytes?.byteLength) continue;
      return new Blob([bytes], { type });
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/* -------------------------------------------------------------- snapshot */

export interface SnapshotOutcome {
  finalUrl?: string;
  html: string;
  bytes: number;
  inlined: number;
  skipped: number;
  error?: string;
}

const SNAPSHOT_MAX_DOCUMENT_BYTES = 3_000_000;
const SNAPSHOT_MAX_ASSET_BYTES = 2_000_000;
const SNAPSHOT_MAX_TOTAL_BYTES = 24_000_000;
const SNAPSHOT_MAX_ASSETS = 120;
const SNAPSHOT_ASSET_CONCURRENCY = 6;
const SNAPSHOT_BUDGET_MS = 45_000;
const SNAPSHOT_ASSET_TIMEOUT_MS = 8_000;

function bufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function inlineOne(url: string, remaining: () => number): Promise<{ uri: string; bytes: number } | null> {
  if (remaining() <= 0) return null;
  try {
    const { response } = await guardedFetch(url, { timeoutMs: SNAPSHOT_ASSET_TIMEOUT_MS });
    if (!response.ok) return null;
    const bytes = await readCapped(response, SNAPSHOT_MAX_ASSET_BYTES).catch(() => null);
    if (!bytes?.byteLength) return null;
    const encodedCost = Math.ceil(bytes.byteLength * 1.37);
    if (encodedCost > remaining()) return null;
    const type = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
    return { uri: `data:${type};base64,${bufferToBase64(bytes)}`, bytes: encodedCost };
  } catch {
    return null;
  }
}

async function inlineStylesheet(
  css: string,
  baseUrl: string,
  remaining: () => number,
  spend: (bytes: number) => void,
): Promise<{ css: string; inlined: number; skipped: number }> {
  const references = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
  const targets = new Map<string, string>();
  for (const [, , raw] of references) {
    const href = raw.trim();
    if (!href || href.startsWith("data:") || href.startsWith("#")) continue;
    try {
      targets.set(href, new URL(href, baseUrl).toString());
    } catch {
      // A malformed reference is left exactly as the author wrote it.
    }
  }

  let inlined = 0;
  let skipped = 0;
  const resolved = new Map<string, string>();
  await mapWithConcurrency([...targets.entries()], SNAPSHOT_ASSET_CONCURRENCY, async ([href, absolute]) => {
    const asset = await inlineOne(absolute, remaining);
    if (!asset) {
      skipped += 1;
      resolved.set(href, absolute);
      return;
    }
    spend(asset.bytes);
    inlined += 1;
    resolved.set(href, asset.uri);
  });

  const rewritten = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, raw) => {
    const replacement = resolved.get(String(raw).trim());
    return replacement ? `url(${quote}${replacement}${quote})` : match;
  });
  return { css: rewritten, inlined, skipped };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Builds an offline snapshot. Fetches a page and its subresources directly (CORS does
 * not apply to an extension page with host permissions) and folds them into one
 * self-contained document, using `DOMParser`/`XMLSerializer`.
 */
export async function extSnapshot(target: string): Promise<SnapshotOutcome> {
  const started = Date.now();
  const timeLeft = () => SNAPSHOT_BUDGET_MS - (Date.now() - started);
  let spent = 0;
  const remaining = () => Math.max(0, SNAPSHOT_MAX_TOTAL_BYTES - spent);
  const spend = (bytes: number) => {
    spent += bytes;
  };

  let html: string;
  let finalUrl: string;
  try {
    const { response, finalUrl: resolved } = await guardedFetch(target, { timeoutMs: 15_000 });
    if (!response.ok) {
      await drain(response);
      return { html: "", bytes: 0, inlined: 0, skipped: 0, error: `HTTP ${response.status}` };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      await drain(response);
      return { html: "", bytes: 0, inlined: 0, skipped: 0, error: "Not an HTML page" };
    }
    const buffer = await readTruncated(response, SNAPSHOT_MAX_DOCUMENT_BYTES);
    html = new TextDecoder("utf-8").decode(buffer);
    finalUrl = resolved;
  } catch (error) {
    return { html: "", bytes: 0, inlined: 0, skipped: 0, error: describeFetchFailure(error) };
  }

  const doc = new DOMParser().parseFromString(inertHtml(html), "text/html");
  const base = doc.querySelector("base[href]")?.getAttribute("href");
  const documentBase = (() => {
    try {
      return base ? new URL(base, finalUrl).toString() : finalUrl;
    } catch {
      return finalUrl;
    }
  })();

  let inlined = 0;
  let skipped = 0;

  doc.querySelectorAll("script, noscript").forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name.startsWith(INERT_HANDLER_PREFIX)) element.removeAttribute(attribute.name);
    }
  });

  const absolute = (href?: string | null): string | null => {
    if (!href) return null;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("#")) return null;
    try {
      return new URL(trimmed, documentBase).toString();
    } catch {
      return null;
    }
  };

  /* stylesheets */
  const sheets = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')];
  await mapWithConcurrency(sheets, SNAPSHOT_ASSET_CONCURRENCY, async (element) => {
    if (timeLeft() <= 0) return;
    const href = absolute(element.getAttribute("href"));
    if (!href) return;
    try {
      const { response } = await guardedFetch(href, { timeoutMs: SNAPSHOT_ASSET_TIMEOUT_MS });
      if (!response.ok) {
        skipped += 1;
        return;
      }
      const text = new TextDecoder("utf-8").decode(await readTruncated(response, SNAPSHOT_MAX_ASSET_BYTES));
      const result = await inlineStylesheet(text, href, remaining, spend);
      inlined += result.inlined + 1;
      skipped += result.skipped;
      spend(result.css.length);
      const style = doc.createElement("style");
      style.setAttribute("data-origin", escapeAttribute(href));
      style.textContent = result.css;
      element.replaceWith(style);
    } catch {
      skipped += 1;
    }
  });

  const inlineSheets = [...doc.querySelectorAll("style")];
  for (const element of inlineSheets) {
    if (timeLeft() <= 0) break;
    if (element.getAttribute("data-origin")) continue;
    const result = await inlineStylesheet(element.textContent ?? "", documentBase, remaining, spend);
    inlined += result.inlined;
    skipped += result.skipped;
    element.textContent = result.css;
  }

  /* images */
  const images = [...doc.querySelectorAll('img[src], img[data-src], source[srcset], video[poster]')];
  const budgeted = images.slice(0, SNAPSHOT_MAX_ASSETS);
  skipped += Math.max(0, images.length - budgeted.length);

  await mapWithConcurrency(budgeted, SNAPSHOT_ASSET_CONCURRENCY, async (node) => {
    if (timeLeft() <= 0) return;
    node.removeAttribute("srcset");
    node.removeAttribute("sizes");
    node.removeAttribute("loading");

    const attribute = node.getAttribute("src") ? "src" : node.getAttribute("poster") ? "poster" : "data-src";
    const href = absolute(node.getAttribute(attribute));
    if (!href) return;

    const asset = await inlineOne(href, remaining);
    if (!asset) {
      skipped += 1;
      node.setAttribute(attribute, href);
      return;
    }
    spend(asset.bytes);
    inlined += 1;
    node.setAttribute(attribute === "data-src" ? "src" : attribute, asset.uri);
    if (attribute === "data-src") node.removeAttribute("data-src");
  });

  /* links and framing */
  doc.querySelectorAll("a[href]").forEach((element) => {
    const href = absolute(element.getAttribute("href"));
    if (href) {
      element.setAttribute("href", href);
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer");
    }
  });
  doc.querySelectorAll("iframe, frame, embed, object").forEach((el) => el.remove());

  const captured = new Date().toISOString();
  const preamble = doc.createElement("template");
  preamble.innerHTML =
    `<meta charset="utf-8">` +
    `<meta name="referrer" content="no-referrer">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:;">` +
    `<meta name="sbs-archived-from" content="${escapeAttribute(finalUrl)}">` +
    `<meta name="sbs-archived-at" content="${captured}">`;
  doc.head.prepend(...preamble.content.childNodes);

  const output = "<!doctype html>\n" + doc.documentElement.outerHTML;
  return {
    finalUrl,
    html: output,
    bytes: new TextEncoder().encode(output).byteLength,
    inlined,
    skipped,
  };
}

export { BlockedUrlError, ResponseTooLargeError, assertPlausiblyPublic, describeFetchFailure };
