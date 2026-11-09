/**
 * Guarded outbound fetching.
 *
 * This server fetches URLs supplied by the client, which makes it a server-side request
 * forgery target if left open: a bookmark pointing at http://169.254.169.254/ or
 * http://localhost:6379 would otherwise let the page reach into the host's private network.
 * Every request therefore resolves DNS first and refuses non-public addresses, re-checking
 * on each hop of a redirect chain.
 */
import dns from "node:dns/promises";
import { bareHost, ipFamily, isLocalHostname, isPrivateAddress } from "../shared/ip";
import { createBreaker } from "./breaker";
import { pinnedRequest, PrivateAddressError } from "./pinned-fetch";

export const USER_AGENT =
  "Mozilla/5.0 (compatible; BookmarkStudio/5; +https://github.com/harsh040506/bookmark-studio)";

export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 10_000;

export { isPrivateAddress };

export class BlockedUrlError extends Error {}

/** Throws unless the URL is http(s) and every resolved address is publicly routable. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("Malformed URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Unsupported protocol: ${url.protocol}`);
  }
  if (url.username || url.password) throw new BlockedUrlError("Addresses with a password are not fetched");

  const hostname = bareHost(url.hostname);
  if (ipFamily(hostname)) {
    if (isPrivateAddress(hostname)) throw new BlockedUrlError("Private address blocked");
    return url;
  }

  if (!hostname || isLocalHostname(hostname)) {
    throw new BlockedUrlError("Local hostname blocked");
  }

  /*
    Checked here to fail early with a clear reason. It is not what keeps the request safe:
    a second lookup could answer differently, so the connection itself goes through
    `publicOnlyLookup` (see pinned-fetch.ts), which re-checks the address actually dialled.
  */
  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new BlockedUrlError("DNS lookup failed");
  }
  if (!records.length) throw new BlockedUrlError("DNS lookup returned nothing");
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new BlockedUrlError("Resolves to a private address");
    }
  }
  return url;
}

/**
 * Per-site breaker: five connection failures to one host inside two minutes and that host
 * is skipped for a minute. See `breaker.ts`. Exported for tests and diagnostics.
 */
export const hostBreaker = createBreaker({ threshold: 5, windowMs: 120_000, coolOffMs: 60_000 });

export interface FollowResult {
  response: Response;
  finalUrl: string;
  redirectCount: number;
}

/**
 * Fetches a URL, following redirects by hand so each hop can be re-validated
 * and the redirect count reported back to the UI.
 */
export async function followedFetch(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<FollowResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...requestInit } = init;
  let current = rawUrl;
  let redirectCount = 0;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(current);
    const host = url.hostname.toLowerCase();
    hostBreaker.check(host);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await pinnedRequest(url, {
        method: requestInit.method,
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          ...(requestInit.headers as Record<string, string> | undefined),
        },
      });
      // Any HTTP answer, even a 404 or 500, means the site is reachable.
      hostBreaker.success(host);
    } catch (error) {
      // A rebinding answer is a refusal, not an outage: it must not count against the site.
      if (error instanceof PrivateAddressError) throw new BlockedUrlError(error.message);
      // A timeout, refused connection or failed lookup: the site did not answer at all.
      hostBreaker.failure(host);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      redirectCount += 1;
      current = new URL(location, url).toString();
      await drain(response);
      continue;
    }

    return { response, finalUrl: url.toString(), redirectCount };
  }

  throw new BlockedUrlError("Too many redirects");
}

/**
 * Runs tasks with a fixed concurrency ceiling so a batch cannot swamp the network.
 *
 * Every runner is awaited to settlement even when one of them fails. The obvious
 * `Promise.all` version returns as soon as the first runner rejects, which leaves the
 * others running with nobody holding their promises — and the moment a second one fails,
 * Node sees an unhandled rejection and, under the default policy, kills the process. A
 * batch endpoint must not be able to take the server down because two URLs failed instead
 * of one.
 *
 * The first rejection is still what propagates, so callers see the same error they always
 * did; the difference is that the rest are collected rather than orphaned.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  const settled = await Promise.allSettled(runners);
  const failure = settled.find((outcome) => outcome.status === "rejected");
  if (failure) throw (failure as PromiseRejectedResult).reason;
  return results;
}

/** Raised when a response body exceeds the ceiling its caller is willing to hold. */
export class ResponseTooLargeError extends Error {}

/**
 * Releases a response body without reading it.
 *
 * The idiom this replaces — `await response.arrayBuffer().catch(() => undefined)` — was
 * used throughout this server to "drain the socket so it can be reused", and it does do
 * that, by downloading the entire body into memory first and then discarding it. On a
 * response the caller has already decided to reject (wrong content type, over the size
 * limit, an HTTP error) that is the worst of both worlds: the bytes are paid for in full
 * and then thrown away.
 *
 * Cancelling the stream achieves the actual goal — the connection is closed or returned
 * to the pool — without transferring the body at all.
 */
export async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that is already consumed, errored or locked needs no releasing.
  }
}

/**
 * Reads a response body, refusing to hold more than `maxBytes` of it.
 *
 * ## Why the declared length is not enough
 *
 * `Content-Length` comes from the remote server, which is the party this function exists
 * to be defended against. It is absent entirely on any chunked response, and it is free to
 * lie. Checking it and then calling `arrayBuffer()` — the pattern this replaces — enforces
 * nothing at all against a hostile or broken host: a chunked response advertising no length
 * is buffered without limit, and a 10 GB body sent as `Content-Length: 100` is buffered
 * without limit too. Under the concurrency this server runs at, a handful of those is the
 * whole heap.
 *
 * So the length is checked when offered, as a courtesy that avoids opening a transfer that
 * is already known to be too big, and then the ceiling is enforced *again* while reading,
 * against the bytes that actually arrive. The read stops and the socket is cancelled the
 * moment the total is exceeded, so an oversized body costs one chunk beyond the limit
 * rather than all of it.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await drain(response);
    throw new ResponseTooLargeError(`Response declares ${declared} bytes; ceiling is ${maxBytes}`);
  }

  const { buffer, truncated } = await readStream(response, maxBytes);
  if (truncated) {
    throw new ResponseTooLargeError(`Response exceeded the ${maxBytes} byte ceiling`);
  }
  return buffer;
}

/**
 * Reads at most `maxBytes` and treats the overflow as an ordinary end of input.
 *
 * The counterpart to `readCapped`, for the callers where a large body is not an error but
 * simply more than is needed: the parts of an HTML document worth extracting are in its
 * first stretch, so a 40 MB page is read to the ceiling, parsed, and the remainder is
 * never transferred. Truncating mid-stream rather than after the fact is the difference
 * between a bounded read and a bounded *slice of* an unbounded read.
 */
export async function readTruncated(response: Response, maxBytes: number): Promise<Buffer> {
  return (await readStream(response, maxBytes)).buffer;
}

/**
 * The shared machinery: pull chunks until the ceiling, then stop and let go of the socket.
 *
 * `reader.cancel()` in a `finally` is what makes the early exits safe. Abandoning a reader
 * without cancelling leaves the connection held open until the remote server or a socket
 * timeout closes it, which under a sweep is a slow leak of sockets rather than of memory —
 * quieter than the problem it replaced, and just as fatal.
 */
async function readStream(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const body = response.body;
  if (!body) return { buffer: Buffer.alloc(0), truncated: false };

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      const room = maxBytes - total;

      /*
        Strictly greater, not `>=`. A body whose final chunk lands exactly on the ceiling
        is the largest legal body, not the smallest illegal one, and `>=` here would make
        `readCapped` reject a response of exactly `maxBytes` — an off-by-one that only ever
        shows up on the boundary, which is precisely where a size limit gets tested.

        When the total does reach the ceiling with bytes still to come, the next iteration
        sees `room === 0`, takes nothing, and reports the truncation.
      */
      if (value.byteLength > room) {
        // `subarray` then `Buffer.from` copies: the chunk a stream hands out may be a view
        // onto a pooled ArrayBuffer that is reused after this tick.
        if (room > 0) chunks.push(Buffer.from(value.subarray(0, room)));
        total += Math.max(0, room);
        truncated = true;
        break;
      }

      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return { buffer: Buffer.concat(chunks, total), truncated };
}
