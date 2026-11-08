/**
 * One cross-origin fetch, whichever backend is carrying it.
 *
 * Inside the extension a plain `fetch` can read any site's response (host permissions lift
 * CORS). On the website the same request is relayed to the extension through the bridge,
 * and the reply is rebuilt into an ordinary `Response` so the code above this — metadata
 * extraction, health checks, favicon and snapshot readers in `lib/ext-net.ts` — is written
 * once and does not know which of the two carried it.
 *
 * A constructed `Response` cannot carry `url` or `redirected` (both are read-only and
 * default to empty/false), so they travel beside it.
 */
import { base64ToBytes, bridgeCall } from "./bridge";
import { IS_EXTENSION } from "./env";
import { getRuntime } from "./runtime";

export interface NetResult {
  response: Response;
  finalUrl: string;
  redirected: boolean;
}

export interface NetInit {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Bodies larger than this are truncated by the bridge before they cross over. */
  maxBytes?: number;
}

interface BridgeFetchReply {
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;
  redirected: boolean;
  body: string;
  truncated: boolean;
}

/** Statuses a `Response` must be constructed without a body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export function viaBridge(): boolean {
  return !IS_EXTENSION && getRuntime().net === "bridge";
}

export async function netFetch(url: string, init: NetInit = {}): Promise<NetResult> {
  const { method = "GET", headers = {}, timeoutMs = 10_000, maxBytes = 2_000_000 } = init;

  if (viaBridge()) {
    const reply = await bridgeCall<BridgeFetchReply>(
      "fetch",
      { url, method, headers, timeoutMs, maxBytes },
      timeoutMs + 5_000,
    );
    const status = reply.status >= 200 && reply.status <= 599 ? reply.status : 502;
    const body = method === "HEAD" || NULL_BODY.has(status) ? null : base64ToBytes(reply.body);
    const response = new Response(body as BodyInit | null, {
      status,
      statusText: reply.statusText,
      headers: reply.headers,
    });
    return { response, finalUrl: reply.url || url, redirected: reply.redirected };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
      headers,
    });
    return { response, finalUrl: response.url || url, redirected: response.redirected };
  } finally {
    clearTimeout(timer);
  }
}
