/**
 * The API as a reusable Express app.
 *
 * Extracted so one definition can be mounted three ways:
 *   - inside the Vite dev server as middleware (no second process, no proxy)
 *   - as a standalone server in production, also serving the built client
 *   - directly in tests
 *
 * The previous split — Vite on one port proxying to a separate API process — meant that
 * if the API process died or lost its port, every preview, screenshot and metadata call
 * failed with ECONNREFUSED while the UI looked perfectly healthy. Sharing one process
 * removes that entire failure mode in development.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { api } from "./routes";

/**
 * Body-size ceiling for API requests.
 *
 * The largest legitimate body is a batch of 100 URLs — a few kilobytes. The limit is set
 * well above that but far below anything that could be used to exhaust memory, and it is
 * enforced before JSON parsing so an oversized payload is rejected without being read.
 */
const MAX_BODY = "256kb";

/**
 * Baseline response headers.
 *
 * This server proxies images and screenshots of arbitrary third-party sites, so browser
 * content sniffing must be disabled everywhere: a remote host that answers a favicon
 * request with HTML must never be interpreted as a document on this origin. Framing is
 * denied because nothing in this app is designed to be embedded, and the referrer is
 * withheld so an outbound request cannot carry a local URL to somebody else's logs.
 */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  next();
}

/**
 * Terminal error handler.
 *
 * Express only routes to a four-argument handler, and without one any thrown error —
 * including the `SyntaxError` from a malformed JSON body — is answered with an HTML
 * stack trace. That is both an information leak and, for a client that only ever parses
 * JSON, an unreadable failure. Every error is therefore reduced to a JSON envelope, with
 * the detail logged server-side where it belongs.
 */
/**
 * Only this app may call the API.
 *
 * Two attacks reach a server bound to 127.0.0.1 from an ordinary web page: a cross-site
 * request (any page can make the browser send one, even if it cannot read the reply), and DNS
 * rebinding (a hostile domain re-pointed at 127.0.0.1, which *can* read the reply because the
 * browser thinks it is same-origin). The first is stopped by refusing a foreign `Origin` /
 * `Sec-Fetch-Site`; the second by refusing any `Host` that isn't a loopback name or one the
 * operator listed in `ALLOWED_HOSTS` (comma-separated, for a self-hosted domain).
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const EXTRA_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.toLowerCase();
  return LOOPBACK.test(value) || EXTRA_HOSTS.has(value) || EXTRA_HOSTS.has(value.replace(/:\d+$/, ""));
}

function sameSiteOnly(req: Request, res: Response, next: NextFunction): void {
  const host = req.headers.host;
  if (!hostAllowed(host)) {
    res.status(403).json({ error: "This server only answers requests for its own address. Set ALLOWED_HOSTS to add one." });
    return;
  }
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site") {
    res.status(403).json({ error: "Cross-site requests are not accepted" });
    return;
  }
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      if (new URL(origin).host.toLowerCase() !== host?.toLowerCase()) {
        res.status(403).json({ error: "Cross-site requests are not accepted" });
        return;
      }
    } catch {
      res.status(403).json({ error: "Malformed Origin header" });
      return;
    }
  }
  next();
}

function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    // The response is already streaming; only the connection can be closed now.
    next(error);
    return;
  }

  const isBadJson = error instanceof SyntaxError && "body" in error;
  const isTooLarge =
    typeof error === "object" && error !== null && (error as { type?: string }).type === "entity.too.large";

  if (isBadJson) {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }
  if (isTooLarge) {
    res.status(413).json({ error: "Request body is too large" });
    return;
  }

  console.error("[bookmark-studio] unhandled error", error);
  res.status(500).json({ error: "Something went wrong on the server" });
}

export function createApiApp(): Express {
  const app = express();

  // Proxy headers are deliberately not trusted: this server is meant to be reached
  // directly, and honouring X-Forwarded-For would let any caller forge the identity the
  // rate limiter buckets on.
  app.set("trust proxy", false);
  app.disable("x-powered-by");

  app.use(securityHeaders);
  app.use("/api", sameSiteOnly);
  app.use(express.json({ limit: MAX_BODY }));
  app.use("/api", api);
  app.use(errorHandler);

  return app;
}
