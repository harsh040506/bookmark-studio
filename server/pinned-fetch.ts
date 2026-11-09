/**
 * One HTTP request whose connection can only reach a public address.
 *
 * ## Why not `fetch`
 *
 * Checking a hostname's DNS answer and then calling `fetch` resolves the name twice. A
 * hostile DNS server can answer the check with a public address and the connection with
 * 127.0.0.1 (DNS rebinding), and the check then guarded a different address than the
 * one used. Node's global `fetch` offers no hook into its own lookup without the separate
 * undici package, but `http.request` does: the `lookup` option below is the resolver the
 * socket actually connects with, so the address that is checked is the address that is
 * dialled.
 *
 * The result is a standard `Response`, so callers read bodies exactly as before.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { LookupFunction } from "node:net";
import { isPrivateAddress } from "../shared/ip";

export class PrivateAddressError extends Error {
  constructor() {
    super("Resolves to a private address");
    this.name = "PrivateAddressError";
  }
}

/** A resolver that refuses to hand the socket anything but public addresses. */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length) {
      callback(Object.assign(new Error("DNS lookup returned nothing"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    // Every answer must be public, not just the first: Node may fall back to the others.
    if (list.some((entry) => isPrivateAddress(entry.address))) {
      callback(new PrivateAddressError(), "", 0);
      return;
    }
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (err: null, all: dns.LookupAddress[]) => void)(null, list);
      return;
    }
    callback(null, list[0].address, list[0].family);
  });
};

export interface PinnedInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Performs one request (no redirects followed) through `publicOnlyLookup`. */
export function pinnedRequest(url: URL, init: PinnedInit = {}): Promise<Response> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(abortError());
      return;
    }
    const request = client.request(
      url,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        lookup: publicOnlyLookup,
        // Bounded, so one hostile host cannot hold an unbounded number of sockets.
        agent: false,
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
        }
        const status = incoming.statusCode ?? 502;
        // A Response cannot carry a body for these statuses.
        const bodyless = init.method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200);
        if (bodyless) incoming.resume();
        try {
          resolve(
            new Response(bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
              status: status < 200 || status > 599 ? 502 : status,
              statusText: incoming.statusMessage,
              headers,
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    const onAbort = () => request.destroy(abortError());
    init.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => {
      init.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    request.on("close", () => init.signal?.removeEventListener("abort", onAbort));
    request.end();
  });
}

function abortError(): Error {
  const error = new Error("The request was aborted");
  error.name = "AbortError";
  return error;
}
