/**
 * `chrome.bookmarks`, wherever it can be reached from.
 *
 * Inside the extension this is simply `chrome.bookmarks`. On the website, with the extension
 * installed, it is a proxy with the same shape whose calls and events travel over the bridge
 * (`lib/bridge.ts`), so `lib/chrome-bookmarks.ts` — the two-way sync — runs unchanged in
 * both places. Anywhere else it is `null`.
 */
import { bridgeCall, bridgeConnected, onBridgeEvent } from "./bridge";
import { IS_EXTENSION } from "./env";

type Node = chrome.bookmarks.BookmarkTreeNode;
type Listener = (...args: never[]) => void;

interface EventLike<T extends Listener> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

export interface BookmarksApi {
  getTree(): Promise<Node[]>;
  create(details: { parentId?: string; title?: string; url?: string; index?: number }): Promise<Node>;
  update(id: string, changes: { title?: string; url?: string }): Promise<Node>;
  move(id: string, destination: { parentId?: string; index?: number }): Promise<Node>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
  onCreated: EventLike<(id: string, node: Node) => void>;
  onRemoved: EventLike<(id: string, info: chrome.bookmarks.BookmarkRemoveInfo) => void>;
  onChanged: EventLike<(id: string, info: chrome.bookmarks.BookmarkChangeInfo) => void>;
  onMoved: EventLike<(id: string, info: chrome.bookmarks.BookmarkMoveInfo) => void>;
  onChildrenReordered: EventLike<(id: string, info: chrome.bookmarks.BookmarkReorderInfo) => void>;
  onImportBegan: EventLike<() => void>;
  onImportEnded: EventLike<() => void>;
}

export const BOOKMARK_EVENTS = [
  "onCreated",
  "onRemoved",
  "onChanged",
  "onMoved",
  "onChildrenReordered",
  "onImportBegan",
  "onImportEnded",
] as const;

let bridged: BookmarksApi | null = null;
let subscribed = false;

function bridgedEvent<T extends Listener>(name: string): EventLike<T> {
  const listeners = new Set<T>();
  onBridgeEvent(`bookmarks.${name}`, (...args) => {
    for (const listener of listeners) (listener as unknown as (...a: unknown[]) => void)(...args);
  });
  return {
    addListener(listener) {
      listeners.add(listener);
      if (!subscribed) {
        subscribed = true;
        void bridgeCall("subscribe", { topic: "bookmarks" }).catch(() => {
          subscribed = false;
        });
      }
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
  };
}

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return bridgeCall<T>("bookmarks", { method, args }, 60_000);
}

function createBridged(): BookmarksApi {
  return {
    getTree: () => call("getTree"),
    create: (details) => call("create", details),
    update: (id, changes) => call("update", id, changes),
    move: (id, destination) => call("move", id, destination),
    remove: (id) => call("remove", id),
    removeTree: (id) => call("removeTree", id),
    onCreated: bridgedEvent("onCreated"),
    onRemoved: bridgedEvent("onRemoved"),
    onChanged: bridgedEvent("onChanged"),
    onMoved: bridgedEvent("onMoved"),
    onChildrenReordered: bridgedEvent("onChildrenReordered"),
    onImportBegan: bridgedEvent("onImportBegan"),
    onImportEnded: bridgedEvent("onImportEnded"),
  };
}

/** The bookmarks API for this page, or `null` when the browser's bookmarks are unreachable. */
export function bookmarksApi(): BookmarksApi | null {
  if (IS_EXTENSION && typeof chrome !== "undefined" && chrome.bookmarks) {
    return chrome.bookmarks as unknown as BookmarksApi;
  }
  if (bridgeConnected()) {
    bridged ??= createBridged();
    return bridged;
  }
  return null;
}
