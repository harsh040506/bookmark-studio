/**
 * Thin client for the app's network capabilities.
 *
 * ## Three backends behind one seam
 *
 * Every function below asks `lib/runtime.ts` who is answering today:
 *
 *   - **extension / bridge** — the browser-native readers in `lib/ext-net.ts` and the
 *     capture window in `lib/ext-shots.ts`. Inside the extension they fetch directly; on
 *     the website the same readers run over the bridge transport (`lib/transport.ts`).
 *   - **server** — the optional local server's `/api/*` routes (`server/routes.ts`).
 *   - **offline** — nothing can be fetched; each call fails with a readable reason and
 *     the interface explains how to switch the capability on.
 *
 * The library imports, organises, searches and exports with the network off entirely;
 * only enrichment, link checks, previews and offline copies need a backend.
 */
import type { DeviceName, HealthResult, PageMetadata } from "../../shared/types";
import { getRuntime } from "./runtime";
import {
  extCheckFrameable,
  extCheckHealth,
  extFetchArchiveUrl,
  extFetchFavicon,
  extFetchMetadata,
  extSnapshot,
} from "./ext-net";
import { captureAndStage, extShotRemote } from "./ext-shots";

/**
 * One JSON request, with a deadline and a readable failure.
 *
 * The timeout is the point. `fetch` has no default one, so a local server that has hung —
 * mid-render, mid-restart — leaves a promise pending forever, and every caller that
 * awaited it is stuck with it: a job whose progress bar never moves again, a pipeline lane
 * that never frees its slot. An abort turns that into an ordinary error the caller
 * already knows how to handle.
 */
async function requestJson<T>(input: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.ok) {
      // Servers here answer failures as JSON with an `error`; use it when it is there,
      // because "Request failed: 503" tells a user nothing they can act on.
      const body = await response
        .clone()
        .json()
        .then((value: { error?: unknown; reference?: unknown }) => value)
        .catch(() => undefined);
      const detail = typeof body?.error === "string" ? body.error : undefined;
      const reference = typeof body?.reference === "string" ? ` (reference ${body.reference})` : "";
      const fallback =
        response.status === 429
          ? "The local server is busy. It will catch up shortly."
          : response.status >= 500
            ? "The local server ran into a problem."
            : `The request was refused (${response.status}).`;
      throw new ApiError(`${detail ?? fallback}${reference}`, response.status);
    }
    // A 200 that is not JSON is a proxy or error page in front of the server, not an answer.
    return (await response.json().catch(() => {
      throw new ApiError("The local server sent an answer the app could not read", response.status);
    })) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("The local server did not answer in time", 0);
    }
    if (error instanceof TypeError) {
      // fetch() rejects with a TypeError when the connection itself fails.
      throw new ApiError("The local server could not be reached. Is it still running?", 0);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** An error that carries the status, so callers can tell "not yet" from "never". */
/** Whether the browser-native readers carry the request (extension page or bridge). */
function browserNet(): boolean {
  const net = getRuntime().net;
  return net === "extension" || net === "bridge";
}

/** Whether nothing at all can reach other sites from this page. */
export function isOffline(): boolean {
  return getRuntime().net === "offline";
}

/** Resolves an `/api/...` path against the page, so the app works under any base path. */
function apiUrl(path: string): string {
  if (typeof document === "undefined") return path;
  return new URL(path.replace(/^\//, ""), document.baseURI).toString();
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ServerStatus {
  online: boolean;
  /** Whether a Chrome/Edge install was found for screenshot capture. */
  screenshots: boolean;
}

export async function getServerStatus(): Promise<ServerStatus> {
  const runtime = getRuntime();
  if (runtime.net === "extension" || runtime.net === "bridge") {
    // Without page access every request would fail; report it as not connected so the
    // background queue waits instead of abandoning the whole library.
    return { online: runtime.pageAccess, screenshots: runtime.pageAccess && runtime.screenshots };
  }
  if (runtime.net === "offline") return { online: false, screenshots: false };
  try {
    // A short deadline: this is a liveness probe, and one that takes thirty seconds to
    // report "offline" has told the interface nothing useful for thirty seconds.
    const result = await requestJson<{ ok: boolean; screenshots?: boolean }>(apiUrl("/api/ping"),
      undefined,
      4_000,
    );
    return { online: Boolean(result.ok), screenshots: Boolean(result.screenshots) };
  } catch {
    return { online: false, screenshots: false };
  }
}

export async function isServerAvailable(): Promise<boolean> {
  return (await getServerStatus()).online;
}

export function fetchMetadata(url: string): Promise<PageMetadata> {
  if (browserNet()) return extFetchMetadata(url);
  return requestJson<PageMetadata>(apiUrl(`/api/metadata?url=${encodeURIComponent(url)}`), undefined, 25_000);
}

/** The server caps a batch at 100 URLs, so callers should chunk before calling. */
export function checkHealth(urls: string[]): Promise<{ results: HealthResult[] }> {
  if (browserNet()) return extCheckHealth(urls);
  return requestJson<{ results: HealthResult[] }>(apiUrl("/api/health"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls }),
  });
}

/**
 * Whether a site allows being embedded. Answered from response headers, because a
 * blocked iframe still fires `load` and cannot be inspected cross-origin.
 */
export function checkFrameable(url: string): Promise<{ frameable: boolean; reason: string }> {
  if (browserNet()) return extCheckFrameable(url);
  return requestJson<{ frameable: boolean; reason: string }>(apiUrl(`/api/frameable?url=${encodeURIComponent(url)}`),
  );
}

export function fetchArchiveUrl(url: string): Promise<{ archiveUrl?: string }> {
  if (browserNet()) return extFetchArchiveUrl(url);
  return requestJson<{ archiveUrl?: string }>(apiUrl(`/api/archive?url=${encodeURIComponent(url)}`));
}

/**
 * Routes a remote image through this origin to dodge hotlink and CORS restrictions.
 *
 * In the extension build there is no separate origin to route through, and none is
 * needed: `fetch` from an extension page with host permissions is not subject to CORS,
 * so the asset store can read the bytes directly from the original URL.
 */
export function proxiedImage(url: string): string {
  if (browserNet()) return url;
  return apiUrl(`/api/image?url=${encodeURIComponent(url)}`);
}

/**
 * Screenshot URL for an <img> tag.
 *
 * `cached` never triggers a render, so a grid of hundreds of cards costs nothing and
 * simply comes back empty for pages not captured yet. `render` captures on demand.
 *
 * In the extension build this returns a pseudo-URL (`ext-shot://…`) rather than a
 * fetchable address — `lib/assets.ts` recognises the scheme and resolves it against a
 * capture already staged by `captureScreenshots`/`renderScreenshot`, rather than
 * fetching it. See `lib/ext-shots.ts` for why.
 */
export function screenshotUrl(
  url: string,
  device: DeviceName = "desktop",
  mode: "cached" | "render" = "cached",
  refresh = false,
): string {
  if (browserNet()) return extShotRemote(url, device);
  const params = new URLSearchParams({ url, device, mode });
  if (refresh) params.set("refresh", "1");
  return apiUrl(`/api/screenshot?${params.toString()}`);
}

export interface CaptureOutcome {
  url: string;
  ok: boolean;
  capturedAt?: number;
  fromCache?: boolean;
}

/**
 * Batch screenshot capture. The server caps a request at 25 URLs.
 *
 * The deadline scales with the batch, because each URL is a real page load in a real
 * browser plus a settle delay — a fixed timeout that suits one page aborts a batch of six
 * that was going to succeed.
 */
export async function captureScreenshots(
  urls: string[],
  device: DeviceName = "desktop",
): Promise<{ results: CaptureOutcome[] }> {
  if (browserNet()) {
    // Capped and de-duplicated the way the server's route validates its own batch body.
    const targets = [...new Set(urls)].slice(0, 25);
    const results = await Promise.all(
      targets.map(async (url): Promise<CaptureOutcome> => {
        const outcome = await captureAndStage(url, device);
        return { url, ok: outcome.ok, capturedAt: outcome.capturedAt, fromCache: false };
      }),
    );
    return { results };
  }
  return requestJson<{ results: CaptureOutcome[] }>(apiUrl("/api/screenshot/batch"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls, device }),
    },
    Math.min(180_000, 20_000 + urls.length * 15_000),
  );
}

/**
 * Renders one page now, bypassing the disk cache.
 *
 * Used by the per-bookmark "refresh screenshot" action. The bytes are staged for the
 * asset store to pick up on its next read of the same key, so there is exactly one path
 * by which a screenshot reaches the screen.
 */
export async function renderScreenshot(
  url: string,
  device: DeviceName = "desktop",
): Promise<boolean> {
  if (browserNet()) {
    const outcome = await captureAndStage(url, device);
    return outcome.ok;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(screenshotUrl(url, device, "render", true), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function screenshotCacheStats(): Promise<{
  files: number;
  bytes: number;
  available: boolean;
}> {
  if (browserNet()) {
    // There is no separate on-disk cache in this build — every captured screenshot lives
    // in the same asset store as every other stored image, reported by `assetStats()`.
    return Promise.resolve({ files: 0, bytes: 0, available: true });
  }
  return requestJson(apiUrl("/api/screenshot/cache"));
}

export function clearScreenshotCache(): Promise<{ cleared: number }> {
  if (browserNet()) return Promise.resolve({ cleared: 0 });
  return requestJson(apiUrl("/api/screenshot/cache"), { method: "DELETE" });
}

/**
 * Fetches (or, in the extension build, builds) an offline snapshot response.
 *
 * Kept as a `Response` in both branches so `saveOfflineCopy` in `hooks/useLibrary.ts` can
 * read it identically — `.ok`, `.headers.get(...)`, `.json()`, `.blob()` — regardless of
 * which backend produced it.
 */
export async function requestSnapshot(url: string): Promise<Response> {
  if (browserNet()) {
    const result = await extSnapshot(url);
    if (result.error || !result.html) {
      return new Response(JSON.stringify({ error: result.error ?? "Nothing to archive" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(result.html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-snapshot-inlined": String(result.inlined),
        "x-snapshot-skipped": String(result.skipped),
        "x-snapshot-bytes": String(result.bytes),
      },
    });
  }
  return fetch(apiUrl(`/api/snapshot?url=${encodeURIComponent(url)}`), { cache: "no-store" });
}

/** Favicon bytes for a domain, fetched directly in the extension build. Used by
 *  `lib/assets.ts` when a `ext-fav://` remote is asked for. */
export function fetchFaviconBlob(domain: string): Promise<Blob | null> {
  return extFetchFavicon(domain);
}
