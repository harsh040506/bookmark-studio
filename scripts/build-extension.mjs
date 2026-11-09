// Builds the extension into dist/extension (Chrome and other Chromium browsers) and
// dist/extension-firefox, and zips each: dist/bookmark-studio-extension.zip and
// dist/bookmark-studio-extension-firefox.zip.
//
//   1. Vite builds the same app as the website, as the extension's own page (index.html).
//   2. esbuild bundles the service worker (background.js) and the bridge content script
//      (bridge.js), with the list of sites the bridge serves compiled in.
//   3. manifest.json is written from extension/manifest.json with the package version and
//      those sites filled in.
//   4. The folder is zipped, ready for "Load unpacked" after unzipping, or the Chrome Web Store.
//   5. A copy with a Firefox manifest is written beside it and zipped too.
//
// Sites: extension/sites.json, plus the deployed website (SITE_URL, or Vercel's production address
// when built on Vercel) and BRIDGE_SITES (extra comma-separated match patterns).
import { copyFileSync, cpSync, createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { build as esbuild } from "esbuild";
import { build } from "vite";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "dist", "extension");
const ZIP = path.join(ROOT, "dist", "bookmark-studio-extension.zip");
const FIREFOX_OUT = path.join(ROOT, "dist", "extension-firefox");
const FIREFOX_ZIP = path.join(ROOT, "dist", "bookmark-studio-extension-firefox.zip");
// A stable id is required for Firefox to keep the extension's storage across updates.
const GECKO_ID = process.env.GECKO_ID || "bookmark-studio@harsh040506.github.io";
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** A site URL as a Chrome match pattern covering that site and everything under it. */
function sitePattern(url) {
  const parsed = new URL(url);
  const base = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return `${parsed.protocol}//${parsed.hostname}${base}*`;
}

function servedSites() {
  const listed = JSON.parse(readFileSync(path.join(ROOT, "extension", "sites.json"), "utf8")).sites ?? [];
  const extra = [];
  // On Vercel the production address is known at build time; elsewhere pass SITE_URL.
  const site =
    process.env.SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/` : "");
  if (site) extra.push(sitePattern(site));
  for (const pattern of (process.env.BRIDGE_SITES ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    extra.push(pattern);
  }
  return [...new Set([...listed, ...extra])];
}

const sites = servedSites();

await build({ root: ROOT, mode: "extension", logLevel: "info" });

// The website's PWA files have no meaning inside an extension.
for (const name of ["manifest.webmanifest", "sw.js"]) rmSync(path.join(OUT, name), { force: true });

const common = {
  bundle: true,
  format: "iife",
  target: ["chrome116", "firefox128"],
  minify: true,
  legalComments: "none",
  define: { __BRIDGE_SITES__: JSON.stringify(sites) },
};
await esbuild({ ...common, entryPoints: [path.join(ROOT, "src/ext/background.ts")], outfile: path.join(OUT, "background.js") });
await esbuild({ ...common, entryPoints: [path.join(ROOT, "src/ext/bridge-content.ts")], outfile: path.join(OUT, "bridge.js") });
await esbuild({ ...common, entryPoints: [path.join(ROOT, "src/ext/approve.ts")], outfile: path.join(OUT, "approve.js") });
copyFileSync(path.join(ROOT, "extension", "approve.html"), path.join(OUT, "approve.html"));

const manifest = JSON.parse(readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
manifest.version = pkg.version.replace(/[^0-9.]/g, "");
manifest.content_scripts[0].matches = sites;
// Only Bookmark Studio's own sites are required. Reading other pages is asked for when it
// is first needed (optional_host_permissions), so installing does not open with a warning
// about access to every website.
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...sites])];
if (process.env.REPOSITORY_URL) manifest.homepage_url = process.env.REPOSITORY_URL;
else if (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG) {
  manifest.homepage_url = `https://github.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`;
}
writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

for (const required of ["index.html", "background.js", "bridge.js", "approve.html", "approve.js", "manifest.json", "icons/icon128.png"]) {
  if (!existsSync(path.join(OUT, required))) {
    console.error(`[build-extension] missing ${required}`);
    process.exit(1);
  }
}

function zip(dir, file) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(file);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(dir, false);
    void archive.finalize();
  });
}

await zip(OUT, ZIP);

/*
  Firefox: the same files with a manifest Firefox accepts. It runs Manifest V3 background
  code as an event page (`background.scripts`), not a service worker, needs a gecko id,
  and treats host access as optional, which the app already asks for on first use.
*/
rmSync(FIREFOX_OUT, { recursive: true, force: true });
cpSync(OUT, FIREFOX_OUT, { recursive: true });
const firefox = { ...manifest };
firefox.background = { scripts: ["background.js"] };
delete firefox.minimum_chrome_version;
firefox.browser_specific_settings = { gecko: { id: GECKO_ID, strict_min_version: "128.0" } };
writeFileSync(path.join(FIREFOX_OUT, "manifest.json"), `${JSON.stringify(firefox, null, 2)}\n`);
await zip(FIREFOX_OUT, FIREFOX_ZIP);

// When the website has been built too, it offers this zip as a same-site download
// (Settings → Connections), so installing the extension never means leaving the app.
const WEB = path.join(ROOT, "dist", "web");
if (existsSync(path.join(WEB, "index.html"))) {
  copyFileSync(ZIP, path.join(WEB, "bookmark-studio-extension.zip"));
  copyFileSync(FIREFOX_ZIP, path.join(WEB, "bookmark-studio-extension-firefox.zip"));
  console.log("[build-extension] copied both zips into dist/web for download from the site");
}

console.log(`[build-extension] dist/extension ready (v${manifest.version}), bridge serves: ${sites.join(", ")}`);
console.log(`[build-extension] zipped to ${path.relative(ROOT, ZIP)}`);
console.log(`[build-extension] Firefox build in ${path.relative(ROOT, FIREFOX_OUT)}, zipped to ${path.relative(ROOT, FIREFOX_ZIP)}`);
