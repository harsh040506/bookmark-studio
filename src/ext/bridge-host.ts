/**
 * The service-worker side of the website bridge.
 *
 * The content script in `bridge-content.ts` is injected only into the sites listed in
 * `extension/sites.json` (plus the deployed site a release was built for). It relays a
 * fixed set of operations here — a guarded fetch, a screenshot, one `chrome.bookmarks`
 * call, swapping library changes — and nothing else is reachable. The sender's URL is checked again on every message,
 * because a content script is the one part of an extension that shares a process with the
 * page it runs in.
 */
import { applyChanges, localReplica, readChanges } from "../lib/db";
import { assertPlausiblyPublic, readTruncated, refuseRedirectInto } from "../lib/net-guard";
import { readBatch, readCursor } from "../lib/replica";
import { repairBookmark } from "../lib/repair";
import { announceCommit } from "../lib/sync";

declare const __BRIDGE_SITES__: string[];

/** Chrome match patterns for the sites the bridge serves. Injected at build time. */
export const SERVED_SITES: string[] = typeof __BRIDGE_SITES__ !== "undefined" ? __BRIDGE_SITES__ : [];

const escapeRegExp = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** A Chrome match pattern (`https://*.example.com/app/*`) as a regular expression. */
export function patternToRegExp(pattern: string): RegExp | null {
  const match = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!match) return null;
  const [, scheme, host, path] = match;
  const schemePart = scheme === "*" ? "https?" : scheme;
  let hostPart: string;
  if (host === "*") hostPart = "[^/:]+";
  else if (host.startsWith("*.")) hostPart = `(?:[^/:]+\\.)?${escapeRegExp(host.slice(2))}`;
  else hostPart = escapeRegExp(host);
  const pathPart = path.split("*").map(escapeRegExp).join(".*");
  // Match patterns ignore the port; so does this.
  return new RegExp(`^${schemePart}://${hostPart}(?::\\d+)?${pathPart}$`);
}

export function isServedUrl(url: string | undefined, patterns: string[] = SERVED_SITES): boolean {
  if (!url) return false;
  return patterns.some((pattern) => patternToRegExp(pattern)?.test(url) ?? false);
}

/* ------------------------------------------------------------- approvals */

/**
 * Which served sites may actually use the bridge.
 *
 * The deployed website the extension was built for is trusted out of the box. A *local*
 * address (localhost, 127.0.0.1) is shared by every project a developer ever runs, so it is
 * served only after the person allows that exact origin once, in a window the extension opens
 * itself — a page cannot click that for them. Approvals live in `chrome.storage.local` and can
 * be revoked from the same window.
 */
const APPROVALS_KEY = "approvedOrigins";

export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return true;
  }
}

export async function approvedOrigins(): Promise<string[]> {
  try {
    const stored = await chrome.storage.local.get(APPROVALS_KEY);
    const list = stored[APPROVALS_KEY];
    return Array.isArray(list) ? list.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export async function isApproved(url: string | undefined): Promise<boolean> {
  const origin = originOf(url);
  if (!origin || !isServedUrl(url)) return false;
  if (!isLocalOrigin(origin)) return true;
  return (await approvedOrigins()).includes(origin);
}

export async function setApproval(origin: string, allowed: boolean): Promise<void> {
  const current = await approvedOrigins();
  const next = allowed ? [...new Set([...current, origin])] : current.filter((value) => value !== origin);
  await chrome.storage.local.set({ [APPROVALS_KEY]: next });
}

const lastPrompt = new Map<string, number>();
/** Opens the approval window for an origin (at most once every 10 seconds per origin). */
export async function promptForApproval(origin: string): Promise<void> {
  const now = Date.now();
  if (now - (lastPrompt.get(origin) ?? 0) < 10_000) return;
  lastPrompt.set(origin, now);
  await chrome.windows.create({
    url: chrome.runtime.getURL(`approve.html?origin=${encodeURIComponent(origin)}`),
    type: "popup",
    width: 440,
    height: 380,
    focused: true,
  });
}

let lastPageAccessPrompt = 0;
/**
 * Opens the extension's window that asks for page access. Chrome only shows its own
 * permission dialog in answer to a click on an extension page, so the website cannot ask
 * directly; this window holds the button.
 */
export async function promptForPageAccess(): Promise<void> {
  const now = Date.now();
  if (now - lastPageAccessPrompt < 10_000) return;
  lastPageAccessPrompt = now;
  await chrome.windows.create({
    url: chrome.runtime.getURL("approve.html?mode=pages"),
    type: "popup",
    width: 440,
    height: 400,
    focused: true,
  });
}

const MAX_BRIDGE_BYTES = 8 * 1024 * 1024;
const BOOKMARK_METHODS = new Set(["getTree", "create", "update", "move", "remove", "removeTree"]);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

interface FetchPayload {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * A number from the page, or the fallback. The page is untrusted: `NaN` here once meant a
 * size ceiling that every comparison passed, so a read had no limit at all.
 */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(number, min), max);
}

export async function bridgeFetch(payload: FetchPayload) {
  if (!payload || typeof payload !== "object" || typeof payload.url !== "string") {
    throw new Error("That request was malformed");
  }
  const url = assertPlausiblyPublic(payload.url);
  const method = payload.method === "HEAD" ? "HEAD" : "GET";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampNumber(payload.timeoutMs, 10_000, 1_000, 60_000));
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload.headers ?? {})) {
      // Content negotiation and ranges only; nothing that could carry identity.
      if (/^(accept|accept-language|range)$/i.test(key) && typeof value === "string") headers[key] = value;
    }
    const response = await fetch(url.toString(), {
      method,
      headers,
      redirect: "follow",
      referrerPolicy: "no-referrer",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.url) await refuseRedirectInto(response.url, response);
    const limit = clampNumber(payload.maxBytes, 2_000_000, 0, MAX_BRIDGE_BYTES);
    const body = method === "HEAD" ? new Uint8Array(0) : await readTruncated(response, limit);
    return {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      url: response.url,
      redirected: response.redirected,
      body: bytesToBase64(body),
      truncated: body.byteLength >= limit,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function bridgeBookmarks(payload: { method: string; args: unknown[] }): Promise<unknown> {
  const method = payload?.method;
  const args = Array.isArray(payload?.args) ? payload.args : [];
  if (typeof method !== "string" || !BOOKMARK_METHODS.has(method)) {
    throw new Error(`Unsupported bookmarks call: ${String(method)}`);
  }
  // A site can only write the kinds of address the importers accept; never `javascript:`.
  if (method === "create" || method === "update") {
    const details = (method === "create" ? args[0] : args[1]) as { url?: unknown } | undefined;
    if (details && details.url !== undefined && !isWritableBookmarkUrl(details.url)) {
      throw new Error("Only web addresses can be saved as bookmarks");
    }
  }
  const api = chrome.bookmarks as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return api[method].apply(chrome.bookmarks, args);
}

export function isWritableBookmarkUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    return ["http:", "https:", "ftp:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/*
  Bookmark change events, forwarded to every connected site.

  Registered at the top level so a change made while the service worker was asleep still
  wakes it; the content scripts reconnect whenever the worker restarts and tell the page,
  which then reconciles from the whole tree rather than trusting that nothing was missed.
*/
export const EVENTS_PORT = "bookmark-studio/events";
const ports = new Set<chrome.runtime.Port>();

/** Sends an event to every connected site. */
export function forwardEvent(name: string, args: unknown[]): void {
  for (const port of ports) {
    try {
      port.postMessage({ name, args });
    } catch {
      ports.delete(port);
    }
  }
}

/** Same name as `LIBRARY_CHANGED_EVENT` in `lib/replication.ts`, kept apart so the
 *  service worker does not bundle the page-side client. */
const LIBRARY_CHANGED = "libraryChanged";

const isReplicaId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/**
 * The extension's half of sharing one library with a website (see `lib/replication.ts`).
 *
 * The extension's library lives in this extension's own database, which the service
 * worker can open even when no extension window is. Every batch is validated row by row
 * before it is written; open extension windows are told which rows changed, and other
 * connected sites are told there is something to collect.
 */
export async function bridgeLibrary(op: string, payload: unknown): Promise<unknown> {
  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (op === "library-id") return localReplica();
  if (op === "library-pull") {
    if (!isReplicaId(body.requester)) throw new Error("Missing requester");
    const requester = body.requester;
    return readChanges(readCursor(body.cursor), (by) => by !== requester, body.fresh === true);
  }
  if (op === "library-push") {
    if (!isReplicaId(body.from)) throw new Error("Missing sender");
    const batch = readBatch(body, body.from, repairBookmark);
    const applied = await applyChanges(batch);
    announceCommit(applied);
    if (applied.changed.length || applied.removed.length || applied.shell) forwardEvent(LIBRARY_CHANGED, [body.from]);
    return { changed: applied.changed.length, removed: applied.removed.length };
  }
  throw new Error(`Unknown request: ${op}`);
}

/** The extension's own window wrote to its library: let connected sites collect it. */
export async function announceLibraryChange(): Promise<void> {
  forwardEvent(LIBRARY_CHANGED, [await localReplica()]);
}

export function installBookmarkForwarding(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== EVENTS_PORT) return;
    void isApproved(port.sender?.url).then((approved) => {
      if (!approved) {
        port.disconnect();
        return;
      }
      ports.add(port);
      port.onDisconnect.addListener(() => ports.delete(port));
    });
  });

  const forward =
    (name: string) =>
    (...args: unknown[]) => {
      for (const port of ports) {
        try {
          port.postMessage({ name, args });
        } catch {
          ports.delete(port);
        }
      }
    };

  // Optional chaining: Firefox lacks the reorder and import events, and a missing event
  // must not throw and take every other listener in the service worker down with it.
  const events = chrome.bookmarks as unknown as Record<string, { addListener?: (fn: (...args: unknown[]) => void) => void } | undefined>;
  for (const name of ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportBegan", "onImportEnded"]) {
    events[name]?.addListener?.(forward(name));
  }
}

/** Injects the bridge into served sites that were already open when the extension arrived. */
export async function injectIntoOpenTabs(): Promise<void> {
  if (!SERVED_SITES.length) return;
  try {
    const tabs = await chrome.tabs.query({ url: SERVED_SITES });
    await Promise.all(
      tabs.map((tab) =>
        tab.id === undefined
          ? undefined
          : chrome.scripting
              .executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] })
              .catch(() => undefined),
      ),
    );
  } catch {
    // Not fatal: those tabs pick the bridge up on their next load.
  }
}
