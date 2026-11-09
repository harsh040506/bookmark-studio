/**
 * The extension's SSRF guard for every outbound fetch it makes.
 *
 * A Node server in this position would resolve DNS and re-check every redirect hop
 * before letting a fetch proceed, because it is a shared process that a hostile
 * bookmarks file could otherwise turn into a probe of the host's private network. An
 * extension has no equivalent exposure — the fetch happens inside the user's own
 * browser, on their own behalf, exactly as if they had typed the URL into the address
 * bar themselves. There is also no way to resolve a hostname to an IP from page or
 * service-worker script, so DNS-rebinding defence is not reproducible here.
 *
 * What is kept, because it costs nothing and catches the common mistake of a bookmark
 * pointing at a router, a local dev server or a cloud metadata endpoint: a literal-address
 * and hostname pattern check before the request goes out. What is kept in full, because
 * it needs nothing Node-specific, is the byte-capping machinery — the Fetch API's
 * `ReadableStream` reader works identically in a page, a worker and a service worker.
 */

import { bareHost, ipFamily, isLocalHostname, isPrivateAddress } from "../../shared/ip";

export class BlockedUrlError extends Error {}
export class ResponseTooLargeError extends Error {}

/** Rejects private, local or non-http(s) targets. A courtesy check, not a sandbox. */
export function assertPlausiblyPublic(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("Malformed URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Unsupported protocol: ${url.protocol}`);
  }
  // Credentials in a URL would be sent to the site; a bookmark never needs them.
  if (url.username || url.password) throw new BlockedUrlError("Addresses with a password are not fetched");
  if (ipFamily(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new BlockedUrlError("Private address blocked");
  } else if (!bareHost(url.hostname) || isLocalHostname(url.hostname)) {
    throw new BlockedUrlError("Local hostname blocked");
  }
  return url;
}

const USER_AGENT_ACCEPT: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

/**
 * A guarded fetch: validates the target, follows redirects natively, and asks for no
 * referrer so an outbound request never carries this app's origin to a third party.
 *
 * Unlike the server's `followedFetch`, this cannot re-validate each redirect hop — a
 * browser's high-level `fetch` does not expose intermediate hops when following
 * redirects automatically, and reading them by hand (`redirect: "manual"`) returns an
 * opaque response outside a small set of privileged contexts. `response.redirected` is
 * reported back instead of an exact hop count.
 */
export type GuardedTransport = (
  url: string,
  init: { method: "GET" | "HEAD"; headers: Record<string, string>; timeoutMs: number },
) => Promise<{ response: Response; finalUrl: string; redirected: boolean }>;

/**
 * Who actually performs the request once it has passed the guard.
 *
 * `null` means a plain `fetch` (the extension's own page and its service worker, where host
 * permissions lift CORS). The website swaps in the bridge transport from `lib/transport.ts`
 * at start-up, so every reader in `lib/ext-net.ts` works unchanged over either.
 */
let transport: GuardedTransport | null = null;

export function setGuardedTransport(next: GuardedTransport | null): void {
  transport = next;
}

export async function guardedFetch(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ response: Response; finalUrl: string; redirected: boolean }> {
  const { timeoutMs = 10_000, ...requestInit } = init;
  const url = assertPlausiblyPublic(rawUrl);
  if (transport) {
    const method = (requestInit.method ?? "GET").toUpperCase() === "HEAD" ? "HEAD" : "GET";
    return transport(url.toString(), {
      method,
      timeoutMs,
      headers: { ...USER_AGENT_ACCEPT, ...(requestInit.headers as Record<string, string> | undefined) },
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      ...requestInit,
      redirect: "follow",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: controller.signal,
      headers: { ...USER_AGENT_ACCEPT, ...(requestInit.headers as Record<string, string> | undefined) },
    });
    const finalUrl = response.url || url.toString();
    await refuseRedirectInto(finalUrl, response);
    return { response, finalUrl, redirected: response.redirected };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refuses a response whose redirects ended somewhere private.
 *
 * A browser follows redirects without showing the hops, so the request to the final
 * address has already been made by the time this runs. What it prevents is that page's
 * content being read back into the library: a bookmark that bounces to a router's admin
 * page must not have that page's text indexed or archived.
 */
export async function refuseRedirectInto(finalUrl: string, response: Response): Promise<void> {
  try {
    assertPlausiblyPublic(finalUrl);
  } catch (error) {
    await drain(response);
    throw error;
  }
}

/** Releases a response body without reading it, so the connection can be freed. */
export async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed, errored, or locked.
  }
}

async function readStream(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Uint8Array; truncated: boolean }> {
  const body = response.body;
  if (!body) return { buffer: new Uint8Array(0), truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      const room = maxBytes - total;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        total += Math.max(0, room);
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { buffer: out, truncated };
}

/** Reads a body, throwing `ResponseTooLargeError` rather than holding more than `maxBytes`. */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await drain(response);
    throw new ResponseTooLargeError(`Response declares ${declared} bytes; ceiling is ${maxBytes}`);
  }
  const { buffer, truncated } = await readStream(response, maxBytes);
  if (truncated) throw new ResponseTooLargeError(`Response exceeded the ${maxBytes} byte ceiling`);
  return buffer;
}

/** Reads at most `maxBytes` and treats the overflow as an ordinary end of input. */
export async function readTruncated(response: Response, maxBytes: number): Promise<Uint8Array> {
  return (await readStream(response, maxBytes)).buffer;
}

/** Runs tasks with a fixed concurrency ceiling. */
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

export function describeFetchFailure(error: unknown): string {
  if (error instanceof BlockedUrlError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "Timed out";
  if (error instanceof TypeError) return "Fetch failed";
  return "Fetch failed";
}

/** Whether a value is a string naming an ordinary web URL — no `javascript:`, no `data:`. */
export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
