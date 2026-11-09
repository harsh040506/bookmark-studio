/**
 * Which backend answers the questions a browser tab cannot answer for itself.
 *
 * | Running as                         | Network (pages, links, images)  | Screenshots           | Browser bookmarks |
 * | ---------------------------------- | ------------------------------- | --------------------- | ----------------- |
 * | The extension's own page           | direct (`extension`)            | capture window        | yes, two-way      |
 * | Website, extension installed       | relayed (`bridge`)              | capture window        | yes, opt-in       |
 * | Served by the local server         | `/api/*` (`server`)             | headless Chrome       | via the extension |
 * | Website, nothing else              | none (`offline`)                | none                  | no                |
 *
 * Everything else — importing, searching, organising, exporting, the visual index of
 * uploaded pictures — runs entirely in the tab and works identically in every row.
 *
 * Detection runs once before the first paint (`probeRuntime`, bounded to well under a
 * second) and again whenever the tab regains focus while something is missing, so
 * installing the extension or starting the server is noticed without a reload.
 */
import {
  bridgeConnected,
  bridgeNeedsApproval,
  bridgePageAccess,
  bridgeVersion,
  onBridgeStatus,
  requestBridgePageAccess,
  waitForBridge,
} from "./bridge";
import { log } from "./log";
import { IS_EXTENSION } from "./env";

export type NetBackend = "extension" | "bridge" | "server" | "offline";

export interface RuntimeState {
  /** Who fetches other sites' pages for us. */
  net: NetBackend;
  /** Whether screenshots can be captured, and by what. */
  screenshots: boolean;
  /** Whether `chrome.bookmarks` is reachable (directly or through the bridge). */
  browserBookmarks: boolean;
  /** Whether the companion extension is reachable from this page. */
  extension: boolean;
  extensionVersion: string | null;
  /** The extension is installed but this local site still needs to be allowed in it. */
  extensionNeedsApproval: boolean;
  /**
   * Whether the extension may read other sites' pages. Asked for on first use rather than
   * at install; until granted, page reading, link checks and previews wait. Always true
   * for the local server and when nothing is connected (nothing to ask).
   */
  pageAccess: boolean;
  /** Whether the optional local server answered. */
  server: boolean;
  /** Set once the first probe has finished. */
  probed: boolean;
}

let state: RuntimeState = IS_EXTENSION
  ? {
      net: "extension",
      screenshots: true,
      browserBookmarks: true,
      extension: true,
      extensionVersion: chromeVersion(),
      extensionNeedsApproval: false,
      // Checked by the first probe; assumed missing so nothing is fetched before then.
      pageAccess: false,
      server: false,
      probed: true,
    }
  : {
      net: "offline",
      screenshots: false,
      browserBookmarks: false,
      extension: false,
      extensionVersion: null,
      extensionNeedsApproval: false,
      pageAccess: true,
      server: false,
      probed: false,
    };

const listeners = new Set<(next: RuntimeState) => void>();

function chromeVersion(): string | null {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return null;
  }
}

export function getRuntime(): RuntimeState {
  return state;
}

export function subscribeRuntime(listener: (next: RuntimeState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: RuntimeState): void {
  const changed = (Object.keys(next) as (keyof RuntimeState)[]).some((key) => next[key] !== state[key]);
  state = next;
  if (changed) for (const listener of listeners) listener(state);
}

async function pingServer(): Promise<{ ok: boolean; screenshots: boolean }> {
  if (typeof fetch === "undefined" || typeof location === "undefined") {
    return { ok: false, screenshots: false };
  }
  // Only same-origin: the local server serves the app and the API from one origin.
  if (location.protocol !== "http:" && location.protocol !== "https:") return { ok: false, screenshots: false };
  // The local server marks the page it serves. Without the mark this is a static host,
  // where the request could only 404 (and log an error) on every load and focus.
  if (!import.meta.env.DEV && !document.querySelector('meta[name="bookmark-studio-server"]')) {
    return { ok: false, screenshots: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(new URL("api/ping", document.baseURI).toString(), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, screenshots: false };
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("json")) return { ok: false, screenshots: false };
    const body = (await response.json()) as { ok?: boolean; screenshots?: boolean; app?: string };
    return { ok: Boolean(body.ok), screenshots: Boolean(body.screenshots) };
  } catch {
    return { ok: false, screenshots: false };
  } finally {
    clearTimeout(timer);
  }
}

let probing: Promise<RuntimeState> | null = null;

/** Detects the backend. Safe to call repeatedly; concurrent calls share one probe. */
async function extensionPageAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch (error) {
    log.warn("runtime.permission-check-failed", { error });
    return false;
  }
}

export function probeRuntime(): Promise<RuntimeState> {
  if (IS_EXTENSION) {
    return extensionPageAccess().then((pageAccess) => {
      publish({ ...state, pageAccess });
      return state;
    });
  }
  if (probing) return probing;
  probing = (async () => {
    const [, server] = await Promise.all([waitForBridge(bridgeConnected() ? 0 : 450), pingServer()]);
    const bridge = bridgeConnected();
    /*
      The server wins the network when both are present: it renders screenshots headlessly
      (no capture window) and re-checks every redirect hop against private addresses after
      a real DNS lookup, which a browser cannot do. The extension still provides the
      browser's bookmarks either way.
    */
    const net: NetBackend = server.ok ? "server" : bridge ? "bridge" : "offline";
    publish({
      net,
      screenshots: server.ok ? server.screenshots : bridge,
      browserBookmarks: bridge,
      extension: bridge,
      extensionVersion: bridge || bridgeNeedsApproval() ? bridgeVersion() : null,
      extensionNeedsApproval: bridgeNeedsApproval(),
      // The server reads pages itself, so the extension's permission only matters without it.
      pageAccess: server.ok || !bridge || bridgePageAccess(),
      server: server.ok,
      probed: true,
    });
    return state;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

let watching = false;
/** Re-probes when the tab regains focus, so a newly installed extension is noticed. */
export function watchRuntime(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  if (IS_EXTENSION) {
    try {
      chrome.permissions.onAdded.addListener(() => void probeRuntime());
      chrome.permissions.onRemoved.addListener(() => void probeRuntime());
    } catch (error) {
      log.warn("runtime.permission-watch-failed", { error });
    }
    return;
  }
  const recheck = () => {
    if (document.visibilityState !== "visible") return;
    void probeRuntime();
  };
  window.addEventListener("focus", recheck);
  // Allowing the site in the extension's window re-announces the bridge: pick that up at once.
  onBridgeStatus(() => void probeRuntime());
  document.addEventListener("visibilitychange", recheck);
  // A slow heartbeat for a server that was started or stopped while the tab stayed focused.
  setInterval(recheck, 30_000);
}

/** Whether other sites can be read from this page at all. */
export function canReachNetwork(): boolean {
  return state.net !== "offline" && state.pageAccess;
}

/** The extension is connected but has not been allowed to read pages yet. */
export function needsPageAccess(current: RuntimeState = state): boolean {
  return (current.net === "extension" || current.net === "bridge") && !current.pageAccess;
}

/**
 * Asks for permission to read pages. Must be called straight from a click: Chrome only
 * shows its prompt for a user gesture, and an `await` before the request loses it.
 * Resolves to whether access is now granted (always `false` from the website, where the
 * extension's own window finishes the job and the bridge re-announces).
 */
export function requestPageAccess(): Promise<boolean> {
  if (IS_EXTENSION) {
    let request: Promise<boolean>;
    try {
      request = chrome.permissions.request({ origins: ["<all_urls>"] });
    } catch (error) {
      log.warn("runtime.permission-request-failed", { error });
      return Promise.resolve(false);
    }
    return request
      .then(async (granted) => {
        await probeRuntime();
        return granted;
      })
      .catch((error: unknown) => {
        log.warn("runtime.permission-request-failed", { error });
        return false;
      });
  }
  return requestBridgePageAccess()
    .then(() => false)
    .catch((error: unknown) => {
      log.warn("runtime.permission-request-failed", { error });
      return false;
    });
}

/** Human description of the current backend, for Settings and toasts. */
export function describeRuntime(current: RuntimeState = state): { title: string; detail: string } {
  if (needsPageAccess(current)) {
    return {
      title: "Allow reading pages",
      detail:
        "The extension needs your permission, once, to open the pages you have bookmarked. Until then previews, link checks and page search wait.",
    };
  }
  switch (current.net) {
    case "extension":
      return {
        title: "Running in the extension",
        detail: "Page reading, link checks, screenshots and two-way bookmark sync are all on.",
      };
    case "bridge":
      return {
        title: "Connected to the extension",
        detail: "The extension reads pages, checks links and captures previews for this site.",
      };
    case "server":
      return {
        title: "Connected to the local server",
        detail: current.screenshots
          ? "The server reads pages, checks links and renders previews in headless Chrome."
          : "The server reads pages and checks links. Install Chrome or Edge for screenshots.",
      };
    default:
      if (current.extensionNeedsApproval) {
        return {
          title: "Extension found — allow this site",
          detail: "The Bookmark Studio extension is installed. Allow this site in it once to turn on previews, link checks and bookmark sync.",
        };
      }
      return {
        title: "Working offline",
        detail:
          "Import, search, organise and export all work. To read pages, check links and capture previews, add the extension or run the local server.",
      };
  }
}

/** Test-only override. */
export function setRuntimeForTests(patch: Partial<RuntimeState>): void {
  publish({ ...state, ...patch });
}
