/**
 * The page side of the extension bridge.
 *
 * ## Why a website needs the extension at all
 *
 * A web page cannot read another site's response (CORS), cannot open a window it is allowed
 * to photograph, and cannot see the browser's bookmarks. The extension can do all three. When
 * it is installed, its content script (`src/ext/bridge-content.ts`) is injected into the
 * pages this app is served from — and only those, see `extension/sites.json` — and relays a
 * small, fixed set of requests to the extension's service worker:
 *
 *   - `fetch`     — a guarded GET/HEAD of a public URL, body returned as base64
 *   - `capture`   — a screenshot of a public URL, returned as a data URL
 *   - `bookmarks` — one call on `chrome.bookmarks` (getTree, create, update, move, remove…)
 *   - `subscribe` — start forwarding `chrome.bookmarks` change events to this page
 *   - `library-id`, `library-pull`, `library-push` — swap library changes with the
 *     extension's own copy (`replication.ts`)
 *
 * So the website gets the same capabilities as the extension's own page. Each keeps its
 * own copy of the library, and the two are kept the same.
 *
 * ## The wire
 *
 * `window.postMessage` with an explicit target origin in both directions, a channel tag, and
 * a check that the message came from this very window. A message from any other frame or
 * origin is ignored by both sides.
 */

export const BRIDGE_CHANNEL = "bookmark-studio/bridge";
export const BRIDGE_PROTOCOL = 1;

export type BridgeOp =
  | "hello"
  | "fetch"
  | "capture"
  | "bookmarks"
  | "subscribe"
  | "request-access"
  | "request-page-access"
  | "library-id"
  | "library-pull"
  | "library-push";

interface BridgeReply {
  channel: typeof BRIDGE_CHANNEL;
  dir: "from-ext";
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  /** Present on unsolicited announcements. */
  hello?: { protocol: number; version: string; approved?: boolean; pageAccess?: boolean };
  event?: { name: string; args: unknown[] };
}

let announced: { protocol: number; version: string; approved?: boolean; pageAccess?: boolean } | null = null;
const statusListeners = new Set<() => void>();
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const helloWaiters = new Set<() => void>();

function isReply(data: unknown): data is BridgeReply {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as BridgeReply).channel === BRIDGE_CHANNEL &&
    (data as BridgeReply).dir === "from-ext"
  );
}

let listening = false;
function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!isReply(data)) return;

    if (data.hello) {
      const changed =
        !announced || announced.approved !== data.hello.approved || announced.pageAccess !== data.hello.pageAccess;
      announced = data.hello;
      for (const wake of helloWaiters) wake();
      helloWaiters.clear();
      if (changed) for (const listener of statusListeners) listener();
      return;
    }
    if (data.event) {
      const listeners = eventListeners.get(data.event.name);
      if (listeners) for (const listener of listeners) listener(...data.event.args);
      return;
    }
    if (typeof data.id !== "number") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || "The extension could not do that"));
  });
}

/** Whether the extension has announced itself in this page AND this site may use it. */
export function bridgeConnected(): boolean {
  listen();
  return announced !== null && announced.approved !== false;
}

/** The extension is installed, but this (local) site has not been allowed to use it yet. */
export function bridgeNeedsApproval(): boolean {
  listen();
  return announced !== null && announced.approved === false;
}

/** Asks the extension to open its "Allow this site?" window. */
/**
 * Whether the extension may read other sites' pages. An extension too old to report it
 * had that access at install time, so a missing answer means yes.
 */
export function bridgePageAccess(): boolean {
  listen();
  return announced?.pageAccess !== false;
}

/** Opens the extension's own window that asks Chrome for page access. */
export function requestBridgePageAccess(): Promise<unknown> {
  return bridgeCall("request-page-access", null, 15_000);
}

export function requestBridgeAccess(): Promise<unknown> {
  return bridgeCall("request-access", null, 15_000);
}

/** Called when the extension appears, or this site is allowed or revoked. */
export function onBridgeStatus(listener: () => void): () => void {
  listen();
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function bridgeVersion(): string | null {
  return announced?.version ?? null;
}

/**
 * Asks the content script to announce itself and waits up to `timeoutMs` for it.
 *
 * Resolves `false` when nothing answers — the extension is not installed, is disabled, or
 * this origin is not one it serves.
 */
export function waitForBridge(timeoutMs = 400): Promise<boolean> {
  listen();
  if (announced) return Promise.resolve(true);
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      helloWaiters.delete(wake);
      resolve(false);
    }, timeoutMs);
    helloWaiters.add(wake);
    window.postMessage({ channel: BRIDGE_CHANNEL, dir: "to-ext", op: "hello" }, window.location.origin);
  });
}

/** One request to the extension, with a deadline. */
export function bridgeCall<T>(op: BridgeOp, payload: unknown, timeoutMs = 30_000): Promise<T> {
  listen();
  if (!announced) return Promise.reject(new Error("The Bookmark Studio extension is not connected"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The extension did not answer in time"));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    window.postMessage(
      { channel: BRIDGE_CHANNEL, dir: "to-ext", id, op, payload },
      window.location.origin,
    );
  });
}

/** Listens for an event the extension forwards (bookmark changes). */
export function onBridgeEvent(name: string, listener: (...args: unknown[]) => void): () => void {
  listen();
  let set = eventListeners.get(name);
  if (!set) {
    set = new Set();
    eventListeners.set(name, set);
  }
  set.add(listener);
  return () => set?.delete(listener);
}

/* ------------------------------------------------------------------ helpers */

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Test-only: forget the announcement and every pending call. */
export function resetBridgeForTests(): void {
  announced = null;
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  eventListeners.clear();
  helloWaiters.clear();
}
