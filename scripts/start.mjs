// `npm start` — the one-command local setup.
//
// Builds the website and the server the first time (or when the source is newer than the
// build), then serves both from http://127.0.0.1:5174 and opens it in your browser. With
// Chrome or Edge installed, previews are rendered headlessly; everything else works anyway.
//
// Options (environment variables): PORT, HOST, NO_OPEN=1, CHROME_PATH. See README → Configuration.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = path.join(ROOT, "dist", "web", "index.html");
const SERVER = path.join(ROOT, "dist", "server", "server.js");

function newest(dir) {
  let latest = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const info = statSync(full);
    latest = Math.max(latest, info.isDirectory() ? newest(full) : info.mtimeMs);
  }
  return latest;
}

function stale(output, sources) {
  if (!existsSync(output)) return true;
  const built = statSync(output).mtimeMs;
  return sources.some((dir) => existsSync(dir) && newest(dir) > built);
}

function run(script) {
  console.log(`\n[bookmark-studio] npm run ${script}`);
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (stale(WEB, [path.join(ROOT, "src"), path.join(ROOT, "shared"), path.join(ROOT, "public")])) run("build:web");
if (stale(SERVER, [path.join(ROOT, "server"), path.join(ROOT, "shared")])) run("build:server");

const port = process.env.PORT || "5174";
const host = process.env.HOST || "127.0.0.1";
const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env, NODE_ENV: "production", PORT: port, HOST: host },
});

let opened = false;
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (opened || !String(chunk).includes("api on")) return;
  opened = true;
  console.log(`\n  Bookmark Studio is running at ${url}\n  Press Ctrl+C to stop.\n`);
  if (process.env.NO_OPEN || process.env.CI) return;
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser launcher available (a headless machine): the URL above is enough.
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
