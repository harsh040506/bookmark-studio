/**
 * The extension's background service worker.
 *
 * Two jobs, and only two: open the app when the toolbar icon is clicked, and capture a
 * screenshot when the app asks for one.
 *
 * ## Why a screenshot is a real tab, not a headless render
 *
 * There is no separate headless Chrome to launch, because there is no Node process here
 * at all — an extension is *inside* a browser already. So a capture opens an ordinary
 * popup window, points it at the page, lets it settle, and reads the pixels back with
 * `chrome.tabs.captureVisibleTab`. This also sidesteps the reason ~85% of sites
 * cannot be *framed* for a live preview (`X-Frame-Options`, `frame-ancestors`): those
 * headers govern embedding, not navigation, and a popup window navigates to the page
 * exactly as a normal tab would.
 *
 * ## Why the window is briefly visible, and how it stays out of the way
 *
 * Chrome refuses to create or capture a window that is not substantially within the
 * visible screen — a fully off-desktop position, the obvious way to hide it, is rejected
 * outright (`left`/`top` past the display errors instead of clamping), and
 * `captureVisibleTab` needs the window un-minimized to have any pixels to read. There is
 * no fully invisible way inside the extension platform to render a real page without a
 * window at all. What we *can* do: read the real screen size — via a one-line script
 * injected into the tab that asked for the capture, since there is no permission that
 * hands an extension display geometry for free — and position the popup at that screen's
 * bottom-right corner instead of Chrome's default centre, and pass `focused: false` so it
 * never steals keyboard input or jumps in front of whatever the user is doing. When the
 * screen size can't be read (the asking tab is gone, or the read fails) it falls back to
 * Chrome's default centred placement rather than risk the "not enough of the window is
 * on screen" error a bad guess would throw. It still exists as a real window for the
 * short time the page takes to settle — a corner-of-desktop flicker, not a popup stealing
 * the screen — then it closes itself.
 */
import { assertPlausiblyPublic, BlockedUrlError } from "../lib/net-guard";
import {
  bridgeBookmarks,
  bridgeFetch,
  injectIntoOpenTabs,
  installBookmarkForwarding,
  isApproved,
  isServedUrl,
  originOf,
  promptForApproval,
} from "./bridge-host";

type DeviceName = "desktop" | "tablet" | "mobile";

const DEVICES: Record<DeviceName, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 414, height: 896 },
};

const NAVIGATION_TIMEOUT_MS = 20_000;
const SETTLE_DELAY_MS = 2_000;
const CAPTURE_BUDGET_MS = 45_000;
/**
 * Capture windows open at once. Each one is a real, if unfocused, OS window sitting in a
 * screen corner, so this is also a cap on how many of those corner-flicker windows could
 * ever be visible to the user at the same instant — kept at 5 for that reason as much as
 * for memory.
 */
const MAX_CONCURRENT_CAPTURES = 5;

let active = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_CAPTURES) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(): void {
  active -= 1;
  waiting.shift()?.();
}

class CaptureTimeout extends Error {}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CaptureTimeout("Capture timed out")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForComplete(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onUpdated = (id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId) return;
      if (changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (id: number) => {
      if (id !== tabId) return;
      cleanup();
      reject(new Error("Tab closed before it finished loading"));
    };
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Where to put a `width` × `height` popup so it sits in the bottom-right corner of the
 * screen the asking tab is actually on, or `undefined` to fall back to Chrome's default
 * centred placement.
 *
 * There is no extension API that hands over display geometry without a dedicated
 * permission this project doesn't otherwise need, so this reads it the way any web page
 * would — `screen.availWidth`/`availHeight` — via a one-line script injected into the tab
 * that requested the capture. That tab is always an extension page (see the
 * `ext-capture` listener below), so no host permission is needed to run it. Every
 * failure mode here — the tab closed, the script threw, the numbers came back nonsensical
 * — resolves to `undefined` rather than a guess, because handing `chrome.windows.create`
 * a bad position throws ("not enough of the window is on screen") instead of clamping it.
 */
async function screenCorner(
  tabId: number | undefined,
  width: number,
  height: number,
): Promise<{ left: number; top: number } | undefined> {
  if (tabId === undefined) return undefined;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: screen.availWidth, height: screen.availHeight }),
    });
    const size = injection?.result;
    if (!size || !(size.width > 0) || !(size.height > 0)) return undefined;
    return {
      left: Math.max(0, Math.round(size.width - width)),
      top: Math.max(0, Math.round(size.height - height)),
    };
  } catch {
    return undefined;
  }
}

interface CaptureOk {
  ok: true;
  dataUrl: string;
  capturedAt: number;
}
interface CaptureFail {
  ok: false;
  error: string;
  kind: "timeout" | "blocked" | "failed";
}

async function captureOnce(
  rawUrl: string,
  device: DeviceName,
  askingTabId: number | undefined,
): Promise<CaptureOk | CaptureFail> {
  try {
    assertPlausiblyPublic(rawUrl);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof BlockedUrlError ? error.message : "Blocked URL",
      kind: "blocked",
    };
  }

  const viewport = DEVICES[device] ?? DEVICES.desktop;
  // Read before `acquire()`: this only touches the asking tab, not the capture window, so
  // there's no reason to make it wait behind other captures for a semaphore slot.
  const corner = await screenCorner(askingTabId, viewport.width, viewport.height);
  await acquire();

  let windowId: number | undefined;
  try {
    const run = (async (): Promise<CaptureOk> => {
      const win = await chrome.windows.create({
        url: rawUrl,
        type: "popup",
        width: viewport.width,
        height: viewport.height,
        focused: false,
        ...corner,
      });
      windowId = win.id;
      const tab = win.tabs?.[0];
      if (!win.id || !tab?.id) throw new Error("Could not open a capture window");

      if (tab.status !== "complete") {
        await withDeadline(waitForComplete(tab.id), NAVIGATION_TIMEOUT_MS);
      }
      await delay(SETTLE_DELAY_MS);

      await chrome.scripting
        .insertCSS({
          target: { tabId: tab.id },
          css: `*, *::before, *::after {
            animation: none !important;
            transition: none !important;
            scroll-behavior: auto !important;
            caret-color: transparent !important;
          }`,
        })
        .catch(() => undefined);

      const dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: "jpeg", quality: 82 });
      return { ok: true, dataUrl, capturedAt: Date.now() };
    })();

    return await withDeadline(run, CAPTURE_BUDGET_MS);
  } catch (error) {
    if (error instanceof CaptureTimeout) {
      return { ok: false, error: "That page took too long to render", kind: "timeout" };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not capture that page",
      kind: "failed",
    };
  } finally {
    if (windowId !== undefined) {
      await chrome.windows.remove(windowId).catch(() => undefined);
    }
    release();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object" || sender.id !== chrome.runtime.id) return undefined;

  if (message.type === "ext-capture") {
    // From the extension's own page only; content scripts go through the bridge below.
    if (!sender.url?.startsWith(chrome.runtime.getURL(""))) return undefined;
    const { url, device } = message as { url: string; device: DeviceName };
    captureOnce(url, DEVICES[device] ? device : "desktop", sender.tab?.id).then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (message.type === "bridge-status") {
    if (!isServedUrl(sender.url)) {
      sendResponse({ served: false, approved: false });
      return undefined;
    }
    void isApproved(sender.url).then((approved) => sendResponse({ served: true, approved }));
    return true;
  }

  if (message.type === "bridge") {
    if (!isServedUrl(sender.url)) {
      sendResponse({ ok: false, error: "This site is not one Bookmark Studio serves" });
      return undefined;
    }
    const run = async (): Promise<unknown> => {
      const origin = originOf(sender.url);
      if (message.op === "request-access") {
        if (origin && !(await isApproved(sender.url))) await promptForApproval(origin);
        return true;
      }
      if (!(await isApproved(sender.url))) {
        throw new Error("This site hasn't been allowed to use the Bookmark Studio extension yet.");
      }
      switch (message.op) {
        case "fetch":
          return bridgeFetch(message.payload);
        case "capture": {
          const { url, device } = message.payload as { url: string; device: DeviceName };
          return captureOnce(url, DEVICES[device] ? device : "desktop", sender.tab?.id);
        }
        case "bookmarks":
          return bridgeBookmarks(message.payload);
        default:
          throw new Error(`Unknown request: ${String(message.op)}`);
      }
    };
    run()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Request failed" }),
      );
    return true;
  }
  return undefined;
});

installBookmarkForwarding();

/* --------------------------------------------------------------- opening the app */

async function openApp(): Promise<void> {
  const appUrl = chrome.runtime.getURL("index.html");
  const [existing] = await chrome.tabs.query({ url: appUrl });
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: appUrl });
}

chrome.action.onClicked.addListener(() => void openApp());

chrome.runtime.onInstalled.addListener((details) => {
  void injectIntoOpenTabs();
  if (details.reason === "install") void openApp();
});
