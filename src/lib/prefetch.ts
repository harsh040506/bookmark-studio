/**
 * Warming the images of rows the reader is about to reach.
 *
 * ## The problem
 *
 * Scrolling is instant; images are not. A card that mounts and *then* fetches its picture
 * shows a grey rectangle for as long as the round trip takes, and a wall of those
 * resolving under the eye is the single clearest signal that a list is being assembled
 * rather than simply being there.
 *
 * The app knows exactly which images the next few screens need, seconds before they are
 * needed. So it fetches them.
 *
 * ## What changed with the asset store
 *
 * This module used to create detached `Image` objects and let the browser's HTTP cache
 * hold the result. It now materialises through {@link ./assets}, which means the warm-up
 * does strictly more: the bytes end up in the app's own store, so they survive the
 * browser deciding to empty its cache, they are there with the network off, and they are
 * counted in the storage figure the user can see. The synchronous hit path in the store
 * is what makes the warmed row paint on its first frame with no placeholder at all.
 *
 * Nothing here needs cleanup. A warm-up that outlives its usefulness has still populated
 * the store for the next visit, and the store bounds itself.
 */
import { ensureAsset, peekAsset } from "./assets";

/** One descriptor per image a card might show, in the order it will try them. */
export interface AssetRequest {
  key: string;
  url: string;
}

/**
 * Keys already requested this session.
 *
 * Only to stop the same key being re-requested inside one session — the store itself is
 * the cache. Capped because a 3,000-bookmark library scrolled end to end would otherwise
 * accumulate three entries per bookmark and never shrink.
 */
const requested = new Set<string>();
const MAX_TRACKED = 6000;

/** Warms one asset. Repeat calls within a session are free. */
function prefetchAsset(request: AssetRequest): void {
  if (!request.url || requested.has(request.key)) return;
  if (peekAsset(request.key)) return;
  if (requested.size >= MAX_TRACKED) requested.clear();
  requested.add(request.key);
  void ensureAsset(request.key, request.url);
}

export function prefetchAssets(requests: AssetRequest[]): void {
  for (const request of requests) prefetchAsset(request);
}

/** Lets a re-capture be warmed again after its bytes have been invalidated. */
export function forgetPrefetch(key: string): void {
  requested.delete(key);
}
