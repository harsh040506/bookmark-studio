/**
 * Keeping two tabs of the same library from lying to each other.
 *
 * ## The failure this exists to stop
 *
 * Two tabs on one origin share one IndexedDB and, until this, neither observed the
 * other's writes. Each held the whole library in memory and wrote back from that copy, so
 * the second tab was not merely *stale* — it was authoritative about a library that had
 * moved. Delete forty bookmarks in tab A, favourite one in tab B, and tab B's commit
 * writes its own row set over the top: the forty come back, and nothing anywhere reports
 * that anything happened.
 *
 * That is the worst class of bug this app can have, because the user's evidence that the
 * delete worked — the grid, in tab A — is still on screen while the data underneath it is
 * being undone.
 *
 * ## What is sent, and what is deliberately not
 *
 * Ids and nothing else. The receiving tab re-reads the affected rows from IndexedDB, which
 * is the only copy both tabs agree on. Broadcasting the rows themselves would be faster
 * and would reintroduce the same problem one level down — two tabs exchanging their
 * private opinions of a row, with no tiebreak — and a `BroadcastChannel` message carrying
 * a few thousand favicon-bearing bookmarks is a structured clone nobody asked for.
 *
 * ## Why it degrades quietly
 *
 * `BroadcastChannel` is absent in some embedded browsers and in the test environment. It
 * is an improvement over the previous behaviour, not a requirement of it, so everything
 * here no-ops when the API is missing and the app behaves exactly as it did before.
 */

const CHANNEL_NAME = "smart-bookmark-studio";

/** What one tab tells the others after a write. */
export interface CommitNotice {
  kind: "commit";
  /** Rows written — the receiver re-reads these. */
  changed: string[];
  /** Rows deleted — the receiver drops these. */
  removed: string[];
  /** Which tab sent it, so a tab ignores its own echo. */
  origin: string;
  at: number;
}

/** Sent when a whole library is swapped, where per-row reconciliation is meaningless. */
export interface ReplaceNotice {
  kind: "replace";
  origin: string;
  at: number;
}

export type SyncNotice = CommitNotice | ReplaceNotice;

/**
 * This tab's identity for the life of the page.
 *
 * `BroadcastChannel` does not deliver a message back to the port that posted it, so this
 * is belt-and-braces — but the app also posts through a same-tab fallback path in tests,
 * and a tab that reacted to its own commit would re-read every row it had just written.
 */
const origin = `tab_${Math.random().toString(36).slice(2, 10)}`;

let channel: BroadcastChannel | null = null;
let listeners = new Set<(notice: SyncNotice) => void>();

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<SyncNotice>) => {
      const notice = event.data;
      if (!notice || notice.origin === origin) return;
      for (const listener of listeners) listener(notice);
    };
    return channel;
  } catch {
    return null;
  }
}

/** Announces a set of row-level changes to every other tab. */
export function announceCommit(change: { changed: string[]; removed: string[] }): void {
  if (!change.changed.length && !change.removed.length) return;
  const notice: CommitNotice = {
    kind: "commit",
    changed: change.changed,
    removed: change.removed,
    origin,
    at: Date.now(),
  };
  try {
    ensureChannel()?.postMessage(notice);
  } catch {
    // A closed channel, or a browser that refuses the clone. Neither is worth surfacing:
    // the local write has already succeeded and this is only the courtesy call.
  }
}

/** Announces that the whole library was replaced — an import, a restore, a reset. */
export function announceReplace(): void {
  const notice: ReplaceNotice = { kind: "replace", origin, at: Date.now() };
  try {
    ensureChannel()?.postMessage(notice);
  } catch {
    /* see above */
  }
}

/** Subscribes to changes made in other tabs. Returns an unsubscribe. */
export function subscribeSync(listener: (notice: SyncNotice) => void): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Closes the channel. For tests, and for a library that has been torn down. */
export function stopSync(): void {
  channel?.close();
  channel = null;
  listeners = new Set();
}
