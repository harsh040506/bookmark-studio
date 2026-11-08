/**
 * The bridge's content script — the extension's foot in the website's door.
 *
 * Injected (at `document_start`) only into the sites listed in `extension/sites.json`. It
 * announces itself to the page, relays the page's requests to the service worker, and
 * forwards bookmark change events back. It holds no state and makes no decisions: the
 * service worker re-validates every request (`bridge-host.ts`).
 *
 * Runs in Chrome's isolated world, so the page cannot reach `chrome.runtime` through it;
 * the only shared surface is `window.postMessage`, filtered to this window and origin.
 */
const CHANNEL = "bookmark-studio/bridge";
const PROTOCOL = 1;
const EVENTS_PORT = "bookmark-studio/events";

interface PageMessage {
  channel: string;
  dir: "to-ext";
  id?: number;
  op?: string;
  payload?: unknown;
}

declare global {
  interface Window {
    __bookmarkStudioBridge?: boolean;
  }
}

(() => {
  // Injected twice (manifest + reinjection after an install)? One copy is enough.
  if (window.__bookmarkStudioBridge) return;
  window.__bookmarkStudioBridge = true;

  const origin = window.location.origin;
  const version = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "0";
    }
  })();

  const post = (message: Record<string, unknown>) =>
    window.postMessage({ channel: CHANNEL, dir: "from-ext", ...message }, origin);

  /**
   * Announces the extension, saying whether this site is allowed to use it yet. Local addresses
   * need the person's approval (see bridge-host.ts); until then the page offers to ask for it.
   */
  const announce = () => {
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage({ type: "bridge-status" }, (status?: { served: boolean; approved: boolean }) => {
        if (chrome.runtime.lastError || !status?.served) return;
        post({ hello: { protocol: PROTOCOL, version, approved: status.approved } });
      });
    } catch {
      // The extension was reloaded underneath this page.
    }
  };

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  let port: chrome.runtime.Port | null = null;
  let wantEvents = false;

  const connect = (resumed: boolean) => {
    if (!alive()) return;
    try {
      port = chrome.runtime.connect({ name: EVENTS_PORT });
    } catch {
      port = null;
      return;
    }
    port.onMessage.addListener((message: { name: string; args: unknown[] }) => {
      post({ event: { name: `bookmarks.${message.name}`, args: message.args } });
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker restarted (or the extension was updated). Reconnect, and have the
      // page reconcile, since events may have been missed while nobody was listening.
      if (wantEvents) setTimeout(() => connect(true), 250);
    });
    if (resumed) post({ event: { name: "bookmarks.onImportEnded", args: [] } });
  };

  window.addEventListener("message", (event: MessageEvent<PageMessage>) => {
    if (event.source !== window || event.origin !== origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.dir !== "to-ext") return;

    if (data.op === "hello") {
      announce();
      return;
    }
    if (typeof data.id !== "number" || typeof data.op !== "string") return;
    const id = data.id;
    const reply = (ok: boolean, result?: unknown, error?: string) => post({ id, ok, result, error });

    if (!alive()) {
      reply(false, undefined, "The extension was updated. Reload this page to reconnect.");
      return;
    }

    if (data.op === "subscribe") {
      wantEvents = true;
      if (!port) connect(false);
      reply(true, true);
      return;
    }

    try {
      chrome.runtime.sendMessage(
        { type: "bridge", op: data.op, payload: data.payload },
        (response?: { ok: boolean; result?: unknown; error?: string }) => {
          const failure = chrome.runtime.lastError;
          if (failure || !response) {
            reply(false, undefined, failure?.message ?? "The extension did not answer");
            return;
          }
          reply(response.ok, response.result, response.error);
        },
      );
    } catch (error) {
      reply(false, undefined, error instanceof Error ? error.message : "The extension is unavailable");
    }
  });

  // Approving (or revoking) this site in the extension's window takes effect without a reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.approvedOrigins) announce();
    });
  } catch {
    // storage events unavailable: the page picks the change up on its next load
  }

  announce();
})();

export {};
