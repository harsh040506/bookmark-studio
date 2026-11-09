/**
 * Keeps the website's library and the extension's library the same.
 *
 * A browser gives a website and an extension separate storage, so each holds its own copy
 * (`replica.ts` explains the merge rules). The website drives the exchange because it is
 * the side that can reach the other: through the bridge it asks the extension's service
 * worker for what changed there, writes it here, then sends what changed here. Each side
 * remembers how far it has read, so after the first exchange only changes travel.
 *
 * A round runs when the extension connects, when either side writes, when the tab comes
 * back into view, and once a minute as a safety net. Only one tab per site runs rounds at a
 * time (Web Locks), and a failing round backs off rather than retrying in a tight loop.
 *
 * Nothing here leaves the browser: both copies live in this browser profile.
 */
import { bridgeCall, onBridgeEvent } from "./bridge";
import * as db from "./db";
import { friendlyFailure } from "./failure";
import { log } from "./log";
import { readBatch, readCursor, type ReplicaCursor } from "./replica";
import { repairBookmark } from "./repair";
import { announceCommit } from "./sync";

/** Events the extension forwards to connected sites when its library changes. */
export const LIBRARY_CHANGED_EVENT = "libraryChanged";

interface PeerState {
  pull: ReplicaCursor | null;
  push: ReplicaCursor | null;
}

export type ReplicationState = "idle" | "copying" | "failed";
export interface ReplicationStatus {
  state: ReplicationState;
  /** When the last complete round finished. */
  lastAt?: number;
  /** A plain-language reason, when the last round failed. */
  problem?: string;
}

/** Pages per round before yielding; the next round continues where this one stopped. */
const MAX_PAGES = 50;
/** Hand the screen what arrived every few pages, so a big first copy shows progress. */
const DELIVER_EVERY = 8;
const HEARTBEAT_MS = 60_000;
const BACKOFF_MS = [15_000, 60_000, 300_000];

let status: ReplicationStatus = { state: "idle" };
const statusListeners = new Set<(status: ReplicationStatus) => void>();

function setStatus(next: ReplicationStatus): void {
  status = next;
  for (const listener of statusListeners) listener(status);
}

export function replicationStatus(): ReplicationStatus {
  return status;
}

export function onReplicationStatus(listener: (status: ReplicationStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

const peerKey = (peer: string) => `replica.peer.${peer}`;

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** Sends this tab's pending changes to the screen and to the site's other tabs. */
function deliver(pending: { changed: Set<string>; removed: Set<string>; shell: boolean }): void {
  if (!pending.changed.size && !pending.removed.size && !pending.shell) return;
  announceCommit(
    { changed: [...pending.changed], removed: [...pending.removed], shell: pending.shell },
    { here: true },
  );
  pending.changed.clear();
  pending.removed.clear();
  pending.shell = false;
}

/**
 * One exchange with the extension. Returns `true` when there is more to do right away.
 * Exported for tests; the app calls `startReplication`.
 */
export async function replicateOnce(): Promise<boolean> {
  const peer = await bridgeCall<unknown>("library-id", null, 15_000);
  if (!isId(peer)) throw new Error("The extension did not say which library it holds");
  const me = await db.localReplica();
  if (peer === me) return false;

  const saved = await db.getMeta<PeerState>(peerKey(peer));
  const state: PeerState = { pull: readCursor(saved?.pull), push: readCursor(saved?.push) };
  // The first meeting matches bookmarks by address, so a file imported on both sides is
  // not shown twice. Built once per round, and only while that first full read lasts.
  const byUrl = !state.pull || state.pull.phase === "scan" ? await db.localRowsByUrl() : undefined;

  const pending = { changed: new Set<string>(), removed: new Set<string>(), shell: false };
  let pages = 0;
  let pulled = false;
  try {
    for (let fresh = true; pages < MAX_PAGES; fresh = false) {
      const page = await bridgeCall<Record<string, unknown>>("library-pull", { requester: me, cursor: state.pull, fresh });
      const batch = readBatch(page, peer, repairBookmark);
      const applied = await db.applyChanges(batch, byUrl);
      for (const id of applied.changed) pending.changed.add(id);
      for (const id of applied.removed) {
        pending.removed.add(id);
        pending.changed.delete(id);
      }
      pending.shell ||= applied.shell;
      state.pull = readCursor(page?.cursor) ?? state.pull;
      await db.setMeta(peerKey(peer), state);
      pages += 1;
      if (pages % DELIVER_EVERY === 0) deliver(pending);
      if (page?.done === true) {
        pulled = true;
        break;
      }
    }
  } finally {
    deliver(pending);
  }
  // Sending waits until everything from the other side has been merged here, so a
  // bookmark matched by address on first contact goes back under its shared id.
  if (!pulled) return true;

  for (let fresh = true; pages < MAX_PAGES; fresh = false) {
    const page = await db.readChanges(state.push, (by) => by === me, fresh);
    if (page.rows.length || page.tombstones.length || page.shell.length) {
      await bridgeCall("library-push", { from: me, rows: page.rows, tombstones: page.tombstones, shell: page.shell });
    }
    state.push = page.cursor;
    await db.setMeta(peerKey(peer), state);
    pages += 1;
    if (page.done) return false;
  }
  return true;
}

/** Runs `task` in at most one tab of this site at a time; other tabs skip the round. */
async function exclusively(task: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return task();
  await locks.request("bookmark-studio-replication", { ifAvailable: true }, async (lock) => {
    if (lock) await task();
  });
}

/**
 * Starts keeping this website's library and the connected extension's library the same.
 * Returns a stop function.
 */
export function startReplication(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let failures = 0;
  let me: string | null = null;
  void db.localReplica().then((id) => (me = id)).catch(() => undefined);

  const schedule = (delay: number) => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  };

  const run = async () => {
    if (stopped || running) return;
    running = true;
    again = false;
    let more = false;
    setStatus({ ...status, state: "copying" });
    try {
      await exclusively(async () => {
        more = await replicateOnce();
      });
      failures = 0;
      setStatus({ state: "idle", lastAt: Date.now() });
    } catch (error) {
      failures += 1;
      const problem = friendlyFailure(error);
      log.warn("replication.failed", { failures, error: error instanceof Error ? error.message : String(error) });
      setStatus({ ...status, state: "failed", problem });
    } finally {
      running = false;
    }
    if (stopped) return;
    if (failures) schedule(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!);
    else if (more || again) schedule(50);
    else schedule(HEARTBEAT_MS);
  };

  // Ask the extension to forward its events here, then listen for library changes.
  void bridgeCall("subscribe", null, 5_000).catch(() => undefined);
  const offEvent = onBridgeEvent(LIBRARY_CHANGED_EVENT, (from) => {
    // A change this site just sent comes back as an event; nothing new to collect.
    if (from === me) return;
    schedule(300);
  });
  const offWrite = db.onLibraryWrite((fromReplica) => {
    if (!fromReplica) schedule(1_500);
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") schedule(200);
  };
  document.addEventListener("visibilitychange", onVisible);
  schedule(0);

  return () => {
    stopped = true;
    clearTimeout(timer);
    offEvent();
    offWrite();
    document.removeEventListener("visibilitychange", onVisible);
    setStatus({ state: "idle" });
  };
}

/**
 * In the extension's own page: tells the service worker after each write, so a connected
 * website collects the change straight away instead of at its next heartbeat.
 */
export function startExtensionChangeNotices(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = db.onLibraryWrite(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: "library-changed" }, () => void chrome.runtime.lastError);
      } catch {
        // The extension is reloading; the website's heartbeat picks the change up.
      }
    }, 500);
  });
  return () => {
    clearTimeout(timer);
    off();
  };
}
