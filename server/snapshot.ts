/**
 * Offline copies: one page, one file, readable with the network off.
 *
 * ## Why this is not a screenshot
 *
 * The app already caches a picture of every page, and a picture is the wrong artefact for
 * a link you saved to *read*. You cannot select a sentence out of it, follow a link in
 * it, search it, or hand it to anything else. A bookmark whose site has gone dark is
 * exactly the case where the text mattered, and exactly the case where all that survives
 * is a thumbnail.
 *
 * So this fetches the document and folds its subresources into it: stylesheets become
 * `<style>`, images and fonts become `data:` URIs, scripts are dropped. What comes out is
 * a single self-contained HTML file that opens as the real page.
 *
 * ## Why scripts are dropped
 *
 * Two reasons, and the second is the one that matters. A script in a saved copy will try
 * to reach the network it no longer has and will usually erase the page trying — SPAs
 * mount over their own server-rendered content and leave a blank div. And an archive of
 * an arbitrary third-party page is untrusted input that the user will later open: keeping
 * its scripts would mean storing executable code from anywhere on the web and running it
 * back later. The saved copy is a document, not an application.
 *
 * ## Budgets
 *
 * Everything here is bounded, because the input is a URL somebody else controls: a cap on
 * the document, a cap per subresource, a cap on the total, a cap on how many are fetched,
 * and a deadline over the whole job. A page that will not fit is saved without the
 * subresources that did not fit rather than failing — a copy with some images missing is
 * worth having; no copy is not.
 */
import { load } from "cheerio";
import type { SnapshotResult } from "../shared/types";
import { drain, followedFetch, mapWithConcurrency, readCapped, readTruncated } from "./safe-fetch";

/** Largest HTML document accepted. */
const MAX_DOCUMENT_BYTES = 3_000_000;
/** Largest single subresource inlined. Past this the original URL is left in place. */
const MAX_ASSET_BYTES = 2_000_000;
/** Ceiling on the finished file. */
const MAX_TOTAL_BYTES = 24_000_000;
/** How many subresources are fetched at all. */
const MAX_ASSETS = 120;
/** Parallel subresource fetches. */
const ASSET_CONCURRENCY = 6;
/** Whole-job deadline. */
const BUDGET_MS = 45_000;
/** Per-subresource timeout. */
const ASSET_TIMEOUT_MS = 8_000;

/** Fetches one subresource and returns it as a data URI, or `null` to leave it alone. */
async function inlineOne(
  url: string,
  remaining: () => number,
): Promise<{ uri: string; bytes: number } | null> {
  if (remaining() <= 0) return null;
  try {
    const { response } = await followedFetch(url, { timeoutMs: ASSET_TIMEOUT_MS });
    if (!response.ok) return null;

    // Bounded during the transfer rather than after it: a subresource that ignores or
    // misreports its length must not be able to spend the whole heap on its way to being
    // rejected. Over the ceiling is an ordinary "leave this one alone", not an error.
    const buffer = await readCapped(response, MAX_ASSET_BYTES).catch(() => null);
    if (!buffer?.byteLength) return null;
    // base64 is 4/3 the size of the bytes; check the *encoded* cost against the budget,
    // since that is what actually lands in the file.
    const encodedCost = Math.ceil(buffer.byteLength * 1.37);
    if (encodedCost > remaining()) return null;

    const type = (response.headers.get("content-type") ?? "application/octet-stream")
      .split(";")[0]
      .trim();
    return { uri: `data:${type};base64,${buffer.toString("base64")}`, bytes: encodedCost };
  } catch {
    return null;
  }
}

/**
 * Rewrites `url(...)` references inside a stylesheet.
 *
 * Stylesheets are where most of a page's images actually live — backgrounds, sprites,
 * webfonts — so a snapshot that only handled `<img>` would come back looking unstyled and
 * grey. References are resolved against the stylesheet's own URL, not the document's,
 * which is the bug that makes a naive implementation fetch every asset from the wrong
 * directory when the CSS is served from a CDN path.
 */
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

  await mapWithConcurrency([...targets.entries()], ASSET_CONCURRENCY, async ([href, absolute]) => {
    const asset = await inlineOne(absolute, remaining);
    if (!asset) {
      skipped += 1;
      // Left absolute rather than relative: offline it simply fails to load, but online
      // it still resolves, which is strictly better than a broken relative path.
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

export interface Snapshot extends SnapshotResult {
  /** The finished single-file document. */
  html: string;
}

/**
 * Captures one page as a self-contained document.
 *
 * Never throws for an ordinary failure — an unreachable page comes back with `error` set
 * and empty html, because the client records that on the bookmark as an attempt rather
 * than treating it as a transport fault to retry.
 */
export async function snapshot(target: string): Promise<Snapshot> {
  const started = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - started);

  let spent = 0;
  const remaining = () => Math.max(0, MAX_TOTAL_BYTES - spent);
  const spend = (bytes: number) => {
    spent += bytes;
  };

  let html: string;
  let finalUrl: string;
  try {
    const response = await followedFetch(target, { timeoutMs: 15_000 });
    if (!response.response.ok) {
      await drain(response.response);
      return empty(target, `HTTP ${response.response.status}`);
    }
    const contentType = response.response.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      await drain(response.response);
      return empty(target, "Not an HTML page");
    }
    // Read to the ceiling and stop, rather than buffering the document and slicing it.
    const buffer = await readTruncated(response.response, MAX_DOCUMENT_BYTES);
    html = new TextDecoder("utf-8").decode(buffer);
    finalUrl = response.finalUrl;
  } catch (error) {
    return empty(target, error instanceof Error ? error.message : "Fetch failed");
  }

  const $ = load(html);
  const base = $("base[href]").attr("href");
  const documentBase = (() => {
    try {
      return base ? new URL(base, finalUrl).toString() : finalUrl;
    } catch {
      return finalUrl;
    }
  })();

  let inlined = 0;
  let skipped = 0;

  /**
   * Everything executable comes out.
   *
   * `<script>` for the reasons in the module note; `<noscript>` because with the scripts
   * gone its content would double the page; and inline event handlers because they are
   * scripts wearing an attribute.
   */
  $("script, noscript").remove();
  $("*").each((_, element) => {
    const attributes = (element as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attributes)) {
      if (/^on/i.test(name)) $(element).removeAttr(name);
    }
  });

  const absolute = (href?: string): string | null => {
    if (!href) return null;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("#")) return null;
    try {
      return new URL(trimmed, documentBase).toString();
    } catch {
      return null;
    }
  };

  /* --------------------------------------------------------- stylesheets */

  const sheets = $('link[rel~="stylesheet"][href]').toArray();
  await mapWithConcurrency(sheets, ASSET_CONCURRENCY, async (element) => {
    if (timeLeft() <= 0) return;
    const href = absolute($(element).attr("href"));
    if (!href) return;
    try {
      const { response } = await followedFetch(href, { timeoutMs: ASSET_TIMEOUT_MS });
      if (!response.ok) {
        skipped += 1;
        return;
      }
      // `response.text()` reads whatever it is sent; this stops at the ceiling.
      const text = (await readTruncated(response, MAX_ASSET_BYTES)).toString("utf8");
      const result = await inlineStylesheet(text, href, remaining, spend);
      inlined += result.inlined + 1;
      skipped += result.skipped;
      spend(result.css.length);
      $(element).replaceWith(`<style data-origin="${escapeAttribute(href)}">${result.css}</style>`);
    } catch {
      skipped += 1;
    }
  });

  // Stylesheets written into the document itself carry the same url() references.
  const inlineSheets = $("style").toArray();
  for (const element of inlineSheets) {
    if (timeLeft() <= 0) break;
    const origin = $(element).attr("data-origin");
    if (origin) continue; // already handled above
    const result = await inlineStylesheet($(element).html() ?? "", documentBase, remaining, spend);
    inlined += result.inlined;
    skipped += result.skipped;
    $(element).text(result.css);
  }

  /* -------------------------------------------------------------- images */

  const images = $("img[src], img[data-src], source[srcset], video[poster]").toArray();
  const budgeted = images.slice(0, MAX_ASSETS);
  skipped += Math.max(0, images.length - budgeted.length);

  await mapWithConcurrency(budgeted, ASSET_CONCURRENCY, async (element) => {
    if (timeLeft() <= 0) return;
    const node = $(element);
    // `srcset` is dropped rather than inlined: a responsive set is several copies of one
    // picture, and storing all of them to satisfy a viewport query the offline file will
    // never re-run is the most expensive way to gain nothing.
    node.removeAttr("srcset");
    node.removeAttr("sizes");
    node.removeAttr("loading");

    const attribute = node.attr("src") ? "src" : node.attr("poster") ? "poster" : "data-src";
    const href = absolute(node.attr(attribute));
    if (!href) return;

    const asset = await inlineOne(href, remaining);
    if (!asset) {
      skipped += 1;
      node.attr(attribute, href);
      return;
    }
    spend(asset.bytes);
    inlined += 1;
    node.attr(attribute === "data-src" ? "src" : attribute, asset.uri);
    if (attribute === "data-src") node.removeAttr("data-src");
  });

  /* --------------------------------------------------- links and framing */

  // Links are made absolute so they still go somewhere from a file with no origin.
  $("a[href]").each((_, element) => {
    const href = absolute($(element).attr("href"));
    if (href) $(element).attr("href", href).attr("target", "_blank").attr("rel", "noreferrer");
  });
  // Frames would reach the network on open; there is nothing to inline into them.
  $("iframe, frame, embed, object").remove();

  /* ------------------------------------------------------------ preamble */

  const captured = new Date().toISOString();
  $("head").prepend(
    `<meta charset="utf-8">` +
      `<meta name="referrer" content="no-referrer">` +
      // Belt and braces: even with scripts stripped, the archive declares that it may
      // not fetch or execute anything if it is ever opened somewhere permissive.
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:;">` +
      `<meta name="sbs-archived-from" content="${escapeAttribute(finalUrl)}">` +
      `<meta name="sbs-archived-at" content="${captured}">`,
  );

  const output = $.html();
  return {
    url: target,
    finalUrl,
    html: output,
    bytes: Buffer.byteLength(output, "utf8"),
    inlined,
    skipped,
  };
}

function empty(url: string, error: string): Snapshot {
  return { url, html: "", bytes: 0, inlined: 0, skipped: 0, error };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
