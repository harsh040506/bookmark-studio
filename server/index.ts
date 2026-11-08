/**
 * Standalone/production entry point: the API app plus the built client.
 *
 * In development the same app is mounted inside the Vite dev server instead (see
 * `vite.config.ts`), so this file exists only for `npm start`. Its extra
 * responsibilities are the ones a long-lived process needs and a dev server provides for
 * free: static asset serving, SPA fallback routing, and an orderly shutdown that closes
 * the headless browser rather than orphaning it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { createApiApp } from "./app";
import { portFromEnv } from "./config";
import { shutdown as shutdownScreenshots } from "./screenshot";
import { logEvent } from "./log";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
/*
  Validated rather than coerced. `PORT=` set-but-empty becomes 0 under `Number`, which
  tells Node to bind a random free port: the server then starts, logs a success line, and
  is not at the address the browser is pointed at.
*/
const port = portFromEnv("PORT", 5174);

/**
 * Bound interface.
 *
 * Defaults to loopback, not `0.0.0.0`. This server fetches arbitrary URLs on behalf of
 * its caller, so exposing it on a shared network without the operator explicitly asking
 * would turn a personal tool into an open proxy on somebody else's LAN.
 */
const host = process.env.HOST ?? "127.0.0.1";

const app = createApiApp();

if (isProduction) {
  const express = (await import("express")).default;
  // `npm run build` writes the website to dist/web beside this bundle (dist/server).
  const clientDir = process.env.CLIENT_DIR
    ? path.resolve(process.env.CLIENT_DIR)
    : path.resolve(__dirname, "..", "web");

  /**
   * Static assets, split into two caching regimes.
   *
   * Everything the bundler emits into `assets/` carries a content hash in its filename,
   * so those bytes can never change under a given URL and are safe to cache for a year.
   * Everything else — `index.html` above all — must revalidate, or a deploy leaves
   * browsers holding a shell that references asset URLs which no longer exist.
   *
   * Membership is decided by directory rather than by pattern-matching the hash. Vite's
   * hashes are base64url, not hex, and a regex written against the wrong alphabet fails
   * open: assets silently fall back to `no-cache` and every visit re-downloads the
   * framework.
   */
  const hashedAssets = `${path.sep}assets${path.sep}`;
  app.use(
    express.static(clientDir, {
      index: false,
      // /about and /privacy are about.html and privacy.html, as on the hosted site.
      extensions: ["html"],
      setHeaders: (res, filePath) => {
        res.setHeader(
          "cache-control",
          filePath.includes(hashedAssets)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    }),
  );

  // SPA fallback. Registered after `/api`, which ends in its own 404 handler, so an
  // unknown API path can never be answered with the HTML shell.
  /*
    The page is marked as served by this server, so the client only probes `/api/ping`
    where an API exists. The same build is also hosted statically (Vercel), where that
    probe could only ever 404 and leave an error in every visitor's console.
  */
  let shell: string | null = null;
  app.get("*", async (_req, res, next) => {
    try {
      shell ??= (await fs.readFile(path.join(clientDir, "index.html"), "utf8")).replace(
        "<head>",
        '<head><meta name="bookmark-studio-server" content="">',
      );
      res.setHeader("cache-control", "no-cache");
      res.type("html").send(shell);
    } catch (error) {
      next(error);
    }
  });
}

const server: Server = app.listen(port, host, () => {
  console.log(
    `[bookmark-studio] api on http://${host}:${port}${isProduction ? " (serving client)" : ""}`,
  );
});

server.on("error", (error) => {
  const code = (error as { code?: string }).code;
  // Say what to do about the two failures people actually hit.
  const hint =
    code === "EADDRINUSE"
      ? `Port ${port} is already in use. Close the other program, or start with PORT=<another number>.`
      : code === "EACCES"
        ? `Not allowed to listen on port ${port}. Choose a port above 1024 with PORT=<number>.`
        : undefined;
  logEvent("error", "server.start-failed", { error, hint });
  if (hint) console.error(`[bookmark-studio] ${hint}`);
  process.exit(1);
});

/**
 * Orderly shutdown.
 *
 * The headless browser is a child process that does not die with its parent, so skipping
 * this leaks a Chrome instance — and its profile directory — on every restart. Requests
 * already in flight are given a grace period to finish; past it, the process exits
 * anyway, because a hung capture must not be able to prevent a restart.
 */
const SHUTDOWN_GRACE_MS = 8_000;
let shuttingDown = false;

async function stop(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bookmark-studio] ${signal} received, shutting down`);

  const forced = setTimeout(() => {
    console.warn("[bookmark-studio] grace period elapsed, exiting");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  // Do not let the safety timer itself keep the process alive.
  forced.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await shutdownScreenshots().catch(() => undefined);

  clearTimeout(forced);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void stop(signal));
}

/**
 * Last-resort handlers.
 *
 * A rejection that escapes every route handler would otherwise terminate the process on
 * modern Node with no explanation and, critically, without closing the browser. Logging
 * and continuing is the right trade for a local tool: the alternative is losing an
 * in-progress capture sweep to one unhandled edge case.
 */
process.on("unhandledRejection", (reason) => {
  logEvent("error", "process.unhandled-rejection", { error: reason });
});

process.on("uncaughtException", (error) => {
  logEvent("error", "process.uncaught-exception", { error });
  void stop("uncaughtException");
});
