/**
 * The app's own image store.
 *
 * ## Why this exists
 *
 * Every preview in this library — the screenshot of a page, its `og:image`, its favicon —
 * used to be an `<img src="/api/…">` and therefore lived in the browser's HTTP cache.
 * That is the wrong home for it in four separate ways:
 *
 *   1. **It is opaque.** Nothing in the app can say how much is stored, show it to the
 *      user, or clear one entry. "Storage used" could only ever report the database.
 *   2. **It is evicted on someone else's schedule.** Chrome empties its cache when it
 *      likes, so a library that was fully illustrated yesterday quietly becomes a wall of
 *      grey rectangles, and every one of those images is fetched a second time.
 *   3. **It belongs to the browser, not the library.** Open the same library in a second
 *      browser and none of the work done in the first is there.
 *   4. **It breaks offline.** The database is local-first and works with the network off;
 *      the images did not, which made the whole app *look* broken offline even though
 *      every bookmark, folder, tag and search still worked.
 *
 * So the bytes are fetched once, stored in IndexedDB beside the bookmarks, and handed to
 * the DOM as object URLs. The HTTP cache is explicitly bypassed on the way in
 * (`cache: "no-store"`, matched by `no-store` response headers from our own server), so
 * the bytes are stored exactly once — here, and nowhere else.
 *
 * ## Making it as fast as the thing it replaced
 *
 * An `<img src>` pointing at a cached URL paints in the same frame. A round trip through
 * IndexedDB does not — and a preview that arrives a frame late is exactly the flicker the
 * scroller exists to avoid. Three things close the gap:
 *
 *   · **A synchronous hit path.** Materialised object URLs live in a plain `Map`, so a
 *     card that has been on screen before, or whose bytes the prefetcher warmed, gets its
 *     source during render with no await at all.
 *   · **Warming ahead of the window.** The grid reports rows several screens out; those
 *     assets are read from the database and materialised long before their cards mount.
 *   · **One request per key, ever.** Reads, fetches and misses are all single-flighted, so
 *     forty cards asking for the same favicon produce one fetch.
 *
 * ## Bounded, and honest about it
 *
 * Object URLs are revoked past a generous live cap so a long session cannot leak them,
 * and the stored bytes are held under a byte budget by evicting least-recently-shown
 * assets. Both are reported in Settings, where the user can see the number and clear it.
 */
import {
  clearAssets as clearAssetStore,
  deleteAssets,
  loadAssetMeta,
  readAsset,
  touchAssets,
  writeAsset,
  type AssetMeta,
} from "./db";
import { fetchFaviconBlob } from "./api";
import { netFetch, viaBridge } from "./transport";
import { consumePendingShot, isExtShotRemote } from "./ext-shots";

export type AssetKind = "shot" | "image" | "icon";

/** Default ceiling on stored image bytes. Overridable from Settings. */
export const DEFAULT_ASSET_BUDGET_MB = 1024;

/**
 * How many object URLs may be alive at once.
 *
 * Far above anything that can be mounted (a window is ~60 cards) and above any plausible
 * prefetch band, so revocation never touches something on screen — but finite, because
 * each live URL pins its blob in memory and a session that scrolled a 3,000-bookmark
 * library end to end would otherwise pin all of it.
 */
const MAX_LIVE_URLS = 1200;

/** Parallel network fetches. Enough to fill a screen quickly, few enough to stay polite. */
const MAX_CONCURRENT_FETCHES = 6;

/**
 * Deadline on one asset fetch.
 *
 * Generous, because these are screenshots and video posters coming through a proxy that
 * may be rendering one on demand, and a preview that takes twelve seconds is still worth
 * having. What matters is that the number is finite: see `fetchBytes`.
 */
const ASSET_FETCH_TIMEOUT_MS = 30_000;

/**
 * Ceiling on a single stored asset.
 *
 * Comfortably above any screenshot or poster frame and far below the storage budget, so
 * one anomalous response cannot consume the space the rest of the library needs.
 */
const MAX_ASSET_BYTES = 40 * 1024 * 1024;

/**
 * How long a "nothing there" answer is trusted.
 *
 * A screenshot that does not exist yet is the normal case for a fresh import, and the
 * capture pipeline is in the middle of fixing it. Remembering the miss forever would mean
 * a card never picked up the screenshot that arrived thirty seconds later; not
 * remembering it at all would mean every scroll past that card re-requested a 404.
 */
const MISS_TTL_MS = 20_000;

type Listener = () => void;

/** key → object URL, for the synchronous hit path. */
const live = new Map<string, string>();
/** Bookkeeping for everything stored, so eviction never has to read a blob. */
const ledger = new Map<string, AssetMeta>();
/** Keys whose source has answered "nothing there" — remembered so we stop asking. */
const misses = new Map<string, number>();
/** In-flight materialisations, so N callers produce one request. */
const inFlight = new Map<string, Promise<string | null>>();
const listeners = new Map<string, Set<Listener>>();

let ledgerReady: Promise<void> | null = null;
let budgetBytes = DEFAULT_ASSET_BUDGET_MB * 1024 * 1024;
let storedBytes = 0;
let active = 0;
const waiting: (() => void)[] = [];
/** Meta rows whose `usedAt` has moved and needs flushing; batched, never per-paint. */
const dirtyTouch = new Map<string, AssetMeta>();
let touchTimer: ReturnType<typeof setTimeout> | null = null;

/* ------------------------------------------------------------------- keys */

/**
 * The identity of an asset.
 *
 * Includes the device for screenshots, because a mobile and a desktop capture of the same
 * page are different pictures and sharing a key would show one where the other was asked
 * for.
 */
export function assetKey(kind: AssetKind, source: string, device = "desktop"): string {
  return kind === "shot" ? `shot:${device}:${source}` : `${kind}:${source}`;
}

/* -------------------------------------------------------------- the ledger */

/** Reads the bookkeeping once per session. Everything else waits on this. */
export function initAssets(budgetMb = DEFAULT_ASSET_BUDGET_MB): Promise<void> {
  budgetBytes = Math.max(64, budgetMb) * 1024 * 1024;
  if (ledgerReady) return ledgerReady;
  ledgerReady = loadAssetMeta()
    .then((rows) => {
      for (const row of rows) {
        ledger.set(row.key, row);
        storedBytes += row.bytes;
      }
    })
    .catch(() => {
      // A database that will not open is survivable: every lookup simply misses and the
      // app fetches as it used to. It must not stop the library from opening.
    });
  return ledgerReady;
}

export function setAssetBudget(megabytes: number): void {
  budgetBytes = Math.max(64, megabytes) * 1024 * 1024;
  void evictIfOver();
}

export function assetStats(): { count: number; bytes: number; budget: number; live: number } {
  return { count: ledger.size, bytes: storedBytes, budget: budgetBytes, live: live.size };
}

/* ------------------------------------------------------------ subscription */

/** Notifies a card when the bytes it asked for have landed. */
export function subscribeAsset(key: string, listener: Listener): () => void {
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(key);
  };
}

function announce(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

/* ---------------------------------------------------------------- reading */

/**
 * The synchronous path: an object URL if one is already materialised.
 *
 * This is what makes the store as fast as an `<img>` on a warm cache — a card that has
 * been seen before, or that the prefetcher reached first, renders with its real source on
 * the very first paint and never shows a placeholder at all.
 */
export function peekAsset(key: string): string | undefined {
  const url = live.get(key);
  if (url) {
    // Re-inserting moves the key to the end of the Map's iteration order, which is the
    // recency order the revocation sweep walks.
    live.delete(key);
    live.set(key, url);
    markUsed(key);
  }
  return url;
}

/** Whether this key has recently been answered with "nothing there". */
export function assetMissed(key: string): boolean {
  const at = misses.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > MISS_TTL_MS) {
    misses.delete(key);
    return false;
  }
  return true;
}

/**
 * Materialises an asset, fetching it if this library has never stored it.
 *
 * Resolves to an object URL, or to `null` when the source has nothing to give — a page
 * with no screenshot captured yet, a site whose `og:image` 404s. `null` is a real answer,
 * and callers move to their next preview tier on it.
 */
export function ensureAsset(key: string, remoteUrl: string): Promise<string | null> {
  const existing = peekAsset(key);
  if (existing) return Promise.resolve(existing);

  const pending = inFlight.get(key);
  if (pending) return pending;

  if (assetMissed(key)) return Promise.resolve(null);

  const work = materialise(key, remoteUrl).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function materialise(key: string, remoteUrl: string): Promise<string | null> {
  await initAssets();

  // Stored from an earlier session: no network at all.
  if (ledger.has(key)) {
    try {
      const blob = await readAsset(key);
      if (blob) return publish(key, blob);
      // Meta without bytes should be impossible — they are written together — but a
      // database that has been through a crash is not a place to assume invariants.
      dropFromLedger([key]);
    } catch {
      dropFromLedger([key]);
    }
  }

  const blob = await fetchBytes(remoteUrl);
  if (!blob) {
    misses.set(key, Date.now());
    return null;
  }

  const url = publish(key, blob);
  const meta: AssetMeta = {
    key,
    bytes: blob.size,
    type: blob.type,
    at: Date.now(),
    usedAt: Date.now(),
  };
  ledger.set(key, meta);
  storedBytes += blob.size;
  try {
    await writeAsset(key, blob, meta);
  } catch {
    // Out of quota, or storage denied. The object URL is already live, so this session
    // still shows the image; it simply will not survive a reload.
    ledger.delete(key);
    storedBytes -= blob.size;
  }
  void evictIfOver();
  return url;
}

/**
 * Fetches with the browser cache explicitly out of the loop.
 *
 * `no-store` on the way out, matched by `no-store` on the way back from our own server:
 * without both, the bytes would be held in two places — here *and* in the opaque cache
 * this module exists to stop using — and the storage figure shown in Settings would be
 * only half the truth.
 */
/**
 * Two pseudo-schemes short-circuit the network fetch below, for the extension build:
 *
 *   - `ext-shot://` — a screenshot captured through `chrome.tabs`, staged by
 *     `captureAndStage` (see `lib/ext-shots.ts`) rather than sitting at a fetchable URL.
 *   - `ext-fav://` — a favicon, fetched directly (no proxy origin exists to route
 *     through in this build).
 *
 * Neither holds a concurrency slot or counts against the fetch timeout below; both are
 * either already-local bytes or a small guarded fetch of their own.
 */
async function fetchPseudoUrl(remoteUrl: string): Promise<Blob | null> {
  if (isExtShotRemote(remoteUrl)) return consumePendingShot(remoteUrl);
  const domain = decodeURIComponent(remoteUrl.slice("ext-fav://".length));
  return fetchFaviconBlob(domain);
}

async function fetchBytes(remoteUrl: string): Promise<Blob | null> {
  if (isExtShotRemote(remoteUrl) || remoteUrl.startsWith("ext-fav://")) {
    return fetchPseudoUrl(remoteUrl);
  }
  await acquire();

  /*
    The deadline is what makes the `finally` reachable.

    This fetch holds one of a small number of concurrency slots, and it had no timeout.
    `fetch` has no default one either, so a request that never settles — a server hung
    mid-render, a connection silently dropped by a sleeping laptop's network stack — left
    this function suspended forever, and `release()` in the `finally` below never ran. Each
    such request permanently retired a slot; enough of them and the asset loader stops
    fetching anything at all, with no error anywhere and a grid of empty cards as the only
    symptom. The same hazard, and the same fix, as `requestJson` in `lib/api.ts`.

    An abort is an ordinary failure here: the caller records a miss and the card falls back
    to its next preview tier, exactly as it does for a 404.
  */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_FETCH_TIMEOUT_MS);
  try {
    // On the website, another site's image can only be read through the extension bridge;
    // same-origin `/api/*` (the local server) and the extension's own page fetch directly.
    const crossOrigin = /^https?:/i.test(remoteUrl) && new URL(remoteUrl).origin !== location.origin;
    const response =
      crossOrigin && viaBridge()
        ? (await netFetch(remoteUrl, { timeoutMs: ASSET_FETCH_TIMEOUT_MS, maxBytes: MAX_ASSET_BYTES })).response
        : await fetch(remoteUrl, { cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.size || !blob.type.startsWith("image/")) return null;
    /*
      A ceiling on what one asset may occupy.

      The bytes come from this app's own proxy, which caps what it will forward — but the
      screenshot and media routes cap at very different sizes, and an asset store that
      trusts whatever arrives has no answer at all when something changes upstream. One
      oversized blob is worth losing; a storage budget blown by a single row is not.
    */
    if (blob.size > MAX_ASSET_BYTES) return null;
    return blob;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    release();
  }
}

function publish(key: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  live.set(key, url);
  markUsed(key);
  reapLiveUrls();
  announce(key);
  return url;
}

/* --------------------------------------------------------------- eviction */

function markUsed(key: string): void {
  const meta = ledger.get(key);
  if (!meta) return;
  meta.usedAt = Date.now();
  dirtyTouch.set(key, meta);
  if (touchTimer) return;
  // Batched: `usedAt` moves on every paint of every card, and a write per paint would put
  // IndexedDB in the middle of the scroll loop.
  touchTimer = setTimeout(() => {
    touchTimer = null;
    const batch = [...dirtyTouch.values()];
    dirtyTouch.clear();
    void touchAssets(batch);
  }, 4_000);
}

/**
 * Revokes the least-recently-used object URLs once too many are alive.
 *
 * The `Map` is kept in recency order by `peekAsset`, so the oldest entries are simply the
 * first ones out of the iterator. Revoking frees the blob's memory; the bytes are still
 * in the database, so a card that comes back materialises again from disk.
 */
function reapLiveUrls(): void {
  if (live.size <= MAX_LIVE_URLS) return;
  const excess = live.size - MAX_LIVE_URLS;
  let removed = 0;
  for (const [key, url] of live) {
    URL.revokeObjectURL(url);
    live.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

let evicting = false;

/**
 * How wide one bucket of the eviction histogram is, in milliseconds.
 *
 * An hour. Eviction only ever needs to answer "which are the oldest few", and last-used
 * times an hour apart are indistinguishable for that purpose — nobody can tell which of
 * two images they last looked at in the same afternoon should go first, and it does not
 * matter if the answer is wrong.
 */
const EVICTION_BUCKET_MS = 60 * 60 * 1000;

/**
 * Chooses what to drop without ordering the whole ledger.
 *
 * ## What this replaces
 *
 * A full `sort` over every stored asset, run each time the budget was exceeded — which,
 * once a library is at its ceiling, is on *every stored image from then on*. Sorting
 * thirty thousand entries to find the two hundred oldest is the wrong shape of work, and
 * it happened on the main thread in the middle of a scroll that was busy fetching more.
 *
 * ## Why buckets rather than a heap
 *
 * A partial selection or a min-heap would be exact and would still touch every entry.
 * Bucketing by hour touches every entry once too, but with no comparisons and no
 * allocation per element — and, crucially, it stops early: the oldest buckets are drained
 * in order and the walk ends the moment enough bytes are accounted for, so a mild overage
 * reads a few hundred entries rather than all of them.
 *
 * The ordering *within* an hour is arbitrary, which is the concession being made and is
 * the one that costs nothing.
 */
function selectForEviction(target: number): string[] {
  const buckets = new Map<number, string[]>();
  let oldestBucket = Infinity;
  let newestBucket = -Infinity;

  for (const meta of ledger.values()) {
    // Never evict something currently on screen out from under it, and never evict bytes
    // with no source to re-fetch from — an upload or a pasted image exists only here, so
    // dropping it destroys the item rather than a cached copy. Filtered here rather than
    // in the drain loop so an ineligible entry never occupies a slot in the plan.
    if (live.has(meta.key) || pinned.has(meta.key)) continue;
    const bucket = Math.floor(meta.usedAt / EVICTION_BUCKET_MS);
    const existing = buckets.get(bucket);
    if (existing) existing.push(meta.key);
    else buckets.set(bucket, [meta.key]);
    if (bucket < oldestBucket) oldestBucket = bucket;
    if (bucket > newestBucket) newestBucket = bucket;
  }

  const doomed: string[] = [];
  let freed = 0;
  for (let bucket = oldestBucket; bucket <= newestBucket; bucket += 1) {
    const keys = buckets.get(bucket);
    if (!keys) continue;
    for (const key of keys) {
      if (storedBytes - freed <= target) return doomed;
      doomed.push(key);
      freed += ledger.get(key)?.bytes ?? 0;
    }
  }
  return doomed;
}

async function evictIfOver(): Promise<void> {
  if (evicting || storedBytes <= budgetBytes) return;
  evicting = true;
  try {
    // Down to 85% rather than to exactly the budget, so a full library does not run one
    // eviction transaction per stored image from then on.
    const target = budgetBytes * 0.85;
    const doomed = selectForEviction(target);
    if (!doomed.length) return;
    await deleteAssets(doomed);
    dropFromLedger(doomed);
  } catch {
    // Eviction is opportunistic; a failure means the budget is exceeded for now, which is
    // strictly better than propagating an error into a paint.
  } finally {
    evicting = false;
  }
}

function dropFromLedger(keys: string[]): void {
  for (const key of keys) {
    const meta = ledger.get(key);
    if (!meta) continue;
    storedBytes -= meta.bytes;
    ledger.delete(key);
  }
  if (storedBytes < 0) storedBytes = 0;
}

/**
 * Stores bytes the app was *given* rather than bytes it fetched.
 *
 * An upload, a pasted screenshot, a downloaded video: these have no remote URL to
 * re-fetch from, which makes them the one case where losing the blob loses the item
 * itself. Everything else in this store is a cache of something retrievable; this is not,
 * so it is written before it is published and a write failure is reported rather than
 * swallowed.
 *
 * Returns false when storage refused the bytes — out of quota, or denied — so the caller
 * can decline to create a row that would point at nothing.
 */
export async function putAssetBlob(key: string, blob: Blob): Promise<boolean> {
  await initAssets();
  const meta: AssetMeta = {
    key,
    bytes: blob.size,
    type: blob.type,
    at: Date.now(),
    usedAt: Date.now(),
  };
  try {
    await writeAsset(key, blob, meta);
  } catch {
    return false;
  }
  const previous = ledger.get(key);
  if (previous) storedBytes -= previous.bytes;
  ledger.set(key, meta);
  storedBytes += blob.size;
  publish(key, blob);
  void evictIfOver();
  return true;
}

/**
 * Reads stored bytes back as a Blob, for the things that need the file and not a URL.
 *
 * Exporting a library bundle and re-encoding a video both need the bytes themselves; an
 * object URL is a handle to them, not a copy.
 */
export async function getAssetBlob(key: string): Promise<Blob | null> {
  await initAssets();
  try {
    return (await readAsset(key)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Marks a key as owned rather than cached, so eviction never takes it.
 *
 * The budget exists to bound *recoverable* bytes. An uploaded image has no source to be
 * re-fetched from, so evicting it under storage pressure would silently destroy the
 * item — the one outcome a store like this must never produce.
 */
const pinned = new Set<string>();

export function pinAsset(key: string): void {
  pinned.add(key);
}

export function unpinAsset(key: string): void {
  pinned.delete(key);
}

/* ----------------------------------------------------------- invalidation */

/**
 * Forgets one asset completely — memory, database and miss record.
 *
 * Used by "refresh this screenshot": the URL is unchanged, so nothing else would tell the
 * app that the bytes behind it are now different ones.
 */
export async function forgetAsset(key: string): Promise<void> {
  const url = live.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    live.delete(key);
  }
  misses.delete(key);
  inFlight.delete(key);
  if (ledger.has(key)) {
    dropFromLedger([key]);
    await deleteAssets([key]).catch(() => undefined);
  }
  announce(key);
}

/** Empties the whole store. Offered in Settings, beside the figure it acts on. */
export async function clearAssets(): Promise<void> {
  for (const url of live.values()) URL.revokeObjectURL(url);
  live.clear();
  ledger.clear();
  misses.clear();
  dirtyTouch.clear();
  storedBytes = 0;
  await clearAssetStore();
}

/* ------------------------------------------------------------- concurrency */

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_FETCHES) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release(): void {
  active -= 1;
  waiting.shift()?.();
}
