/**
 * Screenshot capture.
 *
 * There is no headless Chrome to launch — an extension has no child process at all — but
 * it already runs inside the one thing headless Chrome exists to imitate: a real browser.
 * `src/ext/background.ts` opens a real popup window in a corner of the screen, unfocused
 * so it never interrupts you, lets the page settle, and captures it with
 * `chrome.tabs.captureVisibleTab`. This module is the page-side half of that: it sends the
 * request, and bridges the result into the asset store's existing fetch path so nothing
 * above `lib/api.ts` has to know how capture actually happens.
 *
 * ## The pseudo-URL bridge
 *
 * `lib/assets.ts`'s `ensureAsset(key, remoteUrl)` only knows how to get bytes one way:
 * `fetch(remoteUrl)`. A captured screenshot has no such URL — the bytes come back from a
 * `chrome.runtime` message, not a network response. So a capture already in hand is
 * parked here under the same key `assetKey("shot", …)` computes, and `remoteUrl` is set
 * to a `ext-shot://` address that carries no meaning to `fetch` at all. `lib/assets.ts`
 * recognises that scheme and calls `consumePendingShot` instead of `fetch`, which is the
 * one place this bridge is visible outside this file.
 */
import type { DeviceName } from "../../shared/types";
import { bridgeCall } from "./bridge";
import { IS_EXTENSION } from "./env";

const PENDING_TTL_MS = 90_000;

interface Pending {
  blob: Blob;
  capturedAt: number;
  at: number;
}

const ready = new Map<string, Pending>();

/** Staged shots nobody has claimed are dropped after their TTL, so a long sweep can't hoard blobs. */
function pruneReady(now = Date.now()): void {
  for (const [key, entry] of ready) if (now - entry.at > PENDING_TTL_MS) ready.delete(key);
}

/**
 * Captures this page has in flight at once, matching the extension's own limit of five.
 *
 * The extension enforces the real cap across every tab. This one keeps a single tab from
 * queueing dozens of requests behind it: a request waiting in the extension's queue still
 * runs down this page's timeout, which made the page give up and retry captures that were
 * merely waiting their turn, piling more work onto the queue.
 */
const MAX_IN_FLIGHT = 5;
let inFlight = 0;
const queued: (() => void)[] = [];

async function withCaptureSlot<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight < MAX_IN_FLIGHT && !queued.length) inFlight += 1;
  else await new Promise<void>((resolve) => queued.push(resolve));
  try {
    return await work();
  } finally {
    const next = queued.shift();
    if (next) next();
    else inFlight -= 1;
  }
}

function shotKey(url: string, device: DeviceName): string {
  return `shot:${device}:${url}`;
}

export function extShotRemote(url: string, device: DeviceName): string {
  return `ext-shot://${device}/${encodeURIComponent(url)}`;
}

export function isExtShotRemote(remote: string): boolean {
  return remote.startsWith("ext-shot://");
}

function parseExtShotRemote(remote: string): { url: string; device: DeviceName } | null {
  const match = /^ext-shot:\/\/([^/]+)\/(.+)$/.exec(remote);
  if (!match) return null;
  const device = match[1] as DeviceName;
  try {
    return { url: decodeURIComponent(match[2]), device };
  } catch {
    return null;
  }
}

interface CaptureResponse {
  ok: boolean;
  dataUrl?: string;
  capturedAt?: number;
  error?: string;
  kind?: "timeout" | "unavailable" | "blocked" | "failed";
}

function sendCaptureRequest(url: string, device: DeviceName): Promise<CaptureResponse> {
  // On the website the same request goes to the extension through the bridge.
  if (!IS_EXTENSION) {
    return bridgeCall<CaptureResponse>("capture", { url, device }, 60_000).catch(
      (error: unknown): CaptureResponse => ({
        ok: false,
        error: error instanceof Error ? error.message : "The extension could not capture that page",
        kind: "failed",
      }),
    );
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "ext-capture", url, device }, (response: CaptureResponse | undefined) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || !response) {
          resolve({ ok: false, error: lastError?.message ?? "No response from the extension", kind: "failed" });
          return;
        }
        resolve(response);
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : "Failed to reach the extension" });
    }
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

/**
 * Performs a real capture through the background worker and parks the bytes for
 * `lib/assets.ts` to pick up. Used by `captureScreenshots` and `renderScreenshot`.
 */
export async function captureAndStage(
  url: string,
  device: DeviceName,
): Promise<{ ok: boolean; capturedAt?: number; error?: string }> {
  const key = shotKey(url, device);
  const result = await withCaptureSlot(() => sendCaptureRequest(url, device));
  if (!result.ok || !result.dataUrl) {
    return { ok: false, error: result.error };
  }
  const blob = await dataUrlToBlob(result.dataUrl);
  const capturedAt = result.capturedAt ?? Date.now();
  pruneReady();
  ready.set(key, { blob, capturedAt, at: Date.now() });
  return { ok: true, capturedAt };
}

/**
 * Called from `lib/assets.ts` when a `ext-shot://` remote is asked for. Returns the
 * staged bytes from a capture already performed by `captureAndStage`, or `null` — this
 * never triggers a capture of its own, matching the "cached mode never renders" contract
 * the server-backed build honours for the same call site.
 */
export async function consumePendingShot(remote: string): Promise<Blob | null> {
  const parsed = parseExtShotRemote(remote);
  if (!parsed) return null;
  const key = shotKey(parsed.url, parsed.device);
  const entry = ready.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > PENDING_TTL_MS) {
    ready.delete(key);
    return null;
  }
  ready.delete(key);
  return entry.blob;
}
