// End-to-end smoke test in a real Chrome:  npm run build && npm run test:smoke
//
// Checks what unit tests cannot:
//   1. The extension loads: manifest parses, the service worker starts, the app page renders,
//      IndexedDB opens, and a screenshot capture round-trips through chrome.tabs.
//   2. The website, served on localhost, finds the extension through the bridge — and a guarded
//      fetch, a bookmarks read and a capture all work from the web page.
//
// Extensions are loaded with the `Extensions.loadUnpacked` CDP command: branded Chrome ignores
// the --load-extension flag in recent releases.
import { createServer } from "node:http";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { findChrome } from "./lib/chrome.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT_DIR = path.join(ROOT, "dist", "extension");
const WEB_DIR = path.join(ROOT, "dist", "web");
const SHOTS = process.env.SMOKE_SHOTS;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".json": "application/json" };

function serveWeb() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let file = path.join(WEB_DIR, pathname === "/" ? "index.html" : pathname);
      if (!file.startsWith(WEB_DIR) || !existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`[smoke] ✓ ${message}`);
}

async function main() {
  for (const dir of [EXT_DIR, WEB_DIR]) {
    if (!existsSync(dir)) throw new Error(`${path.relative(ROOT, dir)} is missing — run npm run build first`);
  }
  const executablePath = findChrome();
  if (!executablePath) throw new Error("No local Chrome found (set CHROME_PATH)");
  console.log(`[smoke] launching ${executablePath}`);

  const profileDir = path.join(ROOT, ".smoke-profile");
  rmSync(profileDir, { recursive: true, force: true });
  const server = await serveWeb();
  const webUrl = `http://127.0.0.1:${server.address().port}/`;

  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    userDataDir: profileDir,
    args: ["--no-sandbox", "--window-size=1280,860", "--no-first-run", "--no-default-browser-check"],
  });

  try {
    const cdp = await browser.target().createCDPSession();
    /*
      Reading pages is an optional permission, granted by the person from Chrome's own
      dialog, which automation cannot click. The smoke run loads a copy of the build with
      that permission pre-granted, so the flows behind it can be exercised; the shipped
      manifest keeping it optional is asserted by the unit suite.
    */
    const grantedDir = path.join(ROOT, ".smoke-extension");
    rmSync(grantedDir, { recursive: true, force: true });
    cpSync(EXT_DIR, grantedDir, { recursive: true });
    const manifestPath = path.join(grantedDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), "<all_urls>"])];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: grantedDir });
    console.log(`[smoke] extension loaded: ${id}`);

    await browser.waitForTarget((t) => t.type() === "service_worker" && t.url() === `chrome-extension://${id}/background.js`, { timeout: 10_000 });
    check(true, "background service worker started");

    const appTarget = await browser.waitForTarget((t) => t.type() === "page" && t.url().startsWith(`chrome-extension://${id}/index.html`), { timeout: 10_000 });
    const app = await appTarget.asPage();
    const appErrors = [];
    app.on("pageerror", (err) => appErrors.push(String(err)));
    // A Content Security Policy violation is logged, not thrown, so it is watched separately.
    const cspViolations = [];
    const watchCsp = (page, label) =>
      page.on("console", (message) => {
        if (/Content Security Policy/i.test(message.text())) cspViolations.push(`${label}: ${message.text().slice(0, 120)}`);
      });
    watchCsp(app, "extension page");
    await app.setViewport({ width: 1280, height: 800 });
    await app.waitForSelector(".bs-shell", { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 2500));
    check(true, "extension page rendered the app shell");

    const footer = await app.$eval(".bs-nav-footer", (node) => node.textContent ?? "");
    check(/Synced with Chrome|Filling in/.test(footer), `extension page reports Chrome sync ("${footer.trim()}")`);

    const db = await app.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open("smart-bookmark-studio");
          request.onsuccess = () => {
            const stores = [...request.result.objectStoreNames];
            request.result.close();
            resolve(stores);
          };
          request.onerror = () => resolve([]);
        }),
    );
    check(db.length > 0, `IndexedDB opened with ${db.length} stores`);

    const capture = await app.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: "ext-capture", url: "https://example.com/", device: "desktop" }, resolve)),
    );
    check(capture?.ok && capture.dataUrl?.startsWith("data:image/"), "screenshot capture round-trips from the extension page");
    if (SHOTS) await app.screenshot({ path: path.join(SHOTS, "smoke-extension.png") });
    check(!appErrors.length, `extension page threw no errors${appErrors.length ? `: ${appErrors.join("; ")}` : ""}`);

    // ------------------------------------------------------------- the website
    const web = await browser.newPage();
    const webErrors = [];
    web.on("pageerror", (err) => webErrors.push(String(err)));
    watchCsp(web, "website");
    await web.setViewport({ width: 1280, height: 800 });
    await web.goto(webUrl, { waitUntil: "networkidle2" });
    await web.waitForSelector(".bs-shell", { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 1500));
    const callBridge = (op, payload) =>
      web.evaluate(
        (op, payload) =>
          new Promise((resolve) => {
            const channel = "bookmark-studio/bridge";
            const id = Math.floor(Math.random() * 1e9);
            const onMessage = (event) => {
              const data = event.data;
              if (data?.channel === channel && data.dir === "from-ext" && data.id === id) {
                window.removeEventListener("message", onMessage);
                resolve(data);
              }
            };
            window.addEventListener("message", onMessage);
            window.postMessage({ channel, dir: "to-ext", id, op, payload }, location.origin);
          }),
        op,
        payload,
      );

    // A local address is not served until the person allows it in the extension's own window.
    const pending = await web.$eval(".bs-nav-footer", (node) => node.textContent ?? "");
    check(/not allowed yet/.test(pending), `an unapproved local site is told to ask first ("${pending.trim()}")`);
    const refused = await callBridge("bookmarks", { method: "getTree", args: [] });
    check(refused.ok === false, "an unapproved local site cannot read the browser's bookmarks");

    // Approve through the extension's real "Allow this site?" window.
    const approve = await browser.newPage();
    await approve.goto(`chrome-extension://${id}/approve.html?origin=${encodeURIComponent(new URL(webUrl).origin)}`);
    await approve.waitForSelector("#allow");
    const shown = await approve.$eval("#origin", (node) => node.textContent);
    check(shown === new URL(webUrl).origin, `the approval window names the site (${shown})`);
    await approve.click("#allow").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    await web.bringToFront();
    const webFooter = await web.$eval(".bs-nav-footer", (node) => node.textContent ?? "");
    check(/Extension connected/.test(webFooter), `after approval the website uses the extension ("${webFooter.trim()}")`);

    const bridged = await web.evaluate(async () => {
      const channel = "bookmark-studio/bridge";
      let next = 1000;
      const call = (op, payload) =>
        new Promise((resolve) => {
          const id = next++;
          const onMessage = (event) => {
            const data = event.data;
            if (data?.channel === channel && data.dir === "from-ext" && data.id === id) {
              window.removeEventListener("message", onMessage);
              resolve(data);
            }
          };
          window.addEventListener("message", onMessage);
          window.postMessage({ channel, dir: "to-ext", id, op, payload }, location.origin);
        });
      const fetched = await call("fetch", { url: "https://example.com/", method: "GET", timeoutMs: 15000, maxBytes: 200000 });
      const tree = await call("bookmarks", { method: "getTree", args: [] });
      const blocked = await call("fetch", { url: "http://192.168.1.1/", method: "GET" });
      return {
        fetchStatus: fetched.ok ? fetched.result.status : fetched.error,
        fetchBytes: fetched.ok ? fetched.result.body.length : 0,
        treeOk: tree.ok && Array.isArray(tree.result),
        blockedOk: blocked.ok === false,
      };
    });
    check(bridged.fetchStatus === 200 && bridged.fetchBytes > 100, `bridge fetch read example.com (status ${bridged.fetchStatus})`);
    check(bridged.treeOk, "bridge read the browser's bookmark tree");
    check(bridged.blockedOk, "bridge refused a private-network address");
    // ------------------------------------------------------- one library
    // A bookmark in either database turns up in the other once the two are connected.
    // Written the way the app writes: stamped with when, and by which copy of the library.
    const putRow = (id) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("smart-bookmark-studio");
        request.onsuccess = () => {
          const tx = request.result.transaction(["bookmarks", "meta"], "readwrite");
          const replica = tx.objectStore("meta").get("replicaId");
          replica.onsuccess = () => tx.objectStore("bookmarks").put({
            syncAt: Date.now(),
            syncBy: replica.result,
            id,
            url: `https://example.com/${id}`,
            title: id,
            domain: "example.com",
            description: "",
            category: "Other",
            tags: [],
            folderId: null,
            boardIds: [],
            addedAt: Date.now(),
            visitCount: 0,
            health: { status: "unchecked" },
            preview: { method: "card" },
          });
          tx.oncomplete = () => {
            request.result.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    const hasRow = (id) =>
      new Promise((resolve) => {
        const request = indexedDB.open("smart-bookmark-studio");
        request.onsuccess = () => {
          const get = request.result.transaction("bookmarks", "readonly").objectStore("bookmarks").get(id);
          get.onsuccess = () => {
            request.result.close();
            resolve(Boolean(get.result));
          };
          get.onerror = () => resolve(false);
        };
        request.onerror = () => resolve(false);
      });
    await web.evaluate(putRow, "smoke-from-website");
    await app.evaluate(putRow, "smoke-from-extension");
    await web.reload({ waitUntil: "networkidle2" });
    await web.waitForSelector(".bs-shell", { timeout: 10_000 });
    let shared = { inExtension: false, onWebsite: false };
    for (let attempt = 0; attempt < 30 && !(shared.inExtension && shared.onWebsite); attempt += 1) {
      await new Promise((r) => setTimeout(r, 500));
      shared = {
        inExtension: await app.evaluate(hasRow, "smoke-from-website"),
        onWebsite: await web.evaluate(hasRow, "smoke-from-extension"),
      };
    }
    check(shared.inExtension, "a bookmark saved on the website reached the extension's library");
    check(shared.onWebsite, "a bookmark saved in the extension reached the website's library");

    if (SHOTS) await web.screenshot({ path: path.join(SHOTS, "smoke-website.png") });
    check(!webErrors.length, `website threw no errors${webErrors.length ? `: ${webErrors.join("; ")}` : ""}`);

    check(!cspViolations.length, `no Content Security Policy violations${cspViolations.length ? `: ${cspViolations.slice(0, 3).join("; ")}` : ""}`);

    console.log("[smoke] PASS");
  } finally {
    await browser.close();
    server.close();
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(path.join(ROOT, ".smoke-extension"), { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[smoke] FAIL", error.message ?? error);
  process.exit(1);
});
