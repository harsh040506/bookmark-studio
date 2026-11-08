// Checks the built website the way a crawler, a link-preview bot and a visitor meet it:
//
//   npm run build && npm run check:site
//
// It serves dist/web as vercel.json describes, then verifies status codes, headers, page
// metadata, structured data, internal links, the sitemap, robots.txt, llms.txt and size
// budgets. If Chrome and axe-core are available (npm i --no-save axe-core), it also runs an
// accessibility scan and looks for console errors on each page.
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PAGES } from "../site/content.mjs";
import { pngSize, resolveSiteUrl } from "./build-site.mjs";
import { createStaticHost, listen } from "./lib/static-host.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "dist", "web");
const config = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const SITE = resolveSiteUrl();

/** Size budgets, gzipped where it says so. Raise them deliberately, never quietly. */
const BUDGET = {
  appJsGzip: 340_000, // everything index.html loads before the app can draw
  appCssGzip: 30_000,
  pageGzip: 40_000, // a public page's HTML + CSS + JS, without fonts and images
  socialImage: 300_000, // WhatsApp drops large preview images
  heroImage: 250_000,
};

const failures = [];
let passes = 0;
function check(condition, message) {
  if (condition) passes += 1;
  else failures.push(message);
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const metas = (html) => {
  const found = {};
  for (const tag of html.match(/<meta\s[^>]*>/g) ?? []) {
    const key = attr(tag, "property") ?? attr(tag, "name");
    if (key) found[key] = attr(tag, "content");
  }
  return found;
};
const decode = (text) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const local = (url) => {
  const href = new URL(url);
  const site = new URL(SITE);
  return href.origin === site.origin ? href.pathname : null;
};

async function main() {
  const server = createStaticHost(OUT, config);
  const base = await listen(server);
  const get = async (pathname, init) => {
    const response = await fetch(base + pathname, { redirect: "manual", ...init });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  };

  try {
    // Status codes and headers.
    for (const [pathname, status] of [["/", 200], ["/about", 200], ["/privacy", 200], ["/robots.txt", 200], ["/sitemap.xml", 200], ["/llms.txt", 200], ["/llms-full.txt", 200], ["/index.md", 200], ["/favicon.ico", 200], ["/.well-known/security.txt", 200], ["/manifest.webmanifest", 200], ["/no-such-page", 404], ["/a/b/c", 404], ["/about.html", 308], ["/about/", 308]]) {
      const response = await get(pathname);
      check(response.status === status, `${pathname} returned ${response.status}, expected ${status}`);
    }
    const missing = await get("/no-such-page");
    check(/noindex/.test(missing.body.toString()), "404 page is not noindex");
    check(/<link rel="stylesheet" href="\/assets\//.test(missing.body.toString()), "404 page must load its styles from the root, for deep paths");
    const home = await get("/");
    check(/frame-ancestors 'none'/.test(home.headers.get("content-security-policy") ?? ""), "CSP missing on /");
    check(home.headers.get("x-content-type-options") === "nosniff", "nosniff missing on /");
    check(/describedby/.test(home.headers.get("link") ?? ""), "Link header to llms.txt missing on /");
    check((await get("/about.md")).headers.get("x-robots-tag") === "noindex", "Markdown copies must be noindex (they duplicate the pages)");
    check(/max-age=\d+/.test((await get(`/${PAGES[1].og.image}`)).headers.get("cache-control") ?? ""), "social images should be cacheable");
    check(/no-cache/.test((await get("/sw.js")).headers.get("cache-control") ?? ""), "sw.js must revalidate");

    // Every indexable page.
    const titles = new Set();
    const descriptions = new Set();
    for (const page of PAGES) {
      const pathname = page.path;
      const html = (await get(pathname)).body.toString();
      const meta = metas(html);
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
      const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
      const where = `${pathname}:`;
      check(/<html lang="en">/.test(html), `${where} html lang missing`);
      check(Boolean(title) && title.length <= 65, `${where} title missing or longer than 65 characters`);
      check(!titles.has(title), `${where} duplicate title`);
      titles.add(title);
      const description = meta.description;
      check(Boolean(description) && description.length >= 70 && description.length <= 170, `${where} description should be 70–170 characters (${description?.length})`);
      check(!descriptions.has(description), `${where} duplicate description`);
      descriptions.add(description);
      check(canonical === new URL(pathname.slice(1), SITE).href, `${where} canonical is ${canonical}`);
      check(!/noindex/.test(meta.robots ?? ""), `${where} is noindex`);
      for (const key of ["og:type", "og:site_name", "og:url", "og:title", "og:description", "og:image", "og:image:width", "og:image:height", "og:image:alt", "twitter:card", "twitter:image"]) {
        check(Boolean(meta[key]), `${where} ${key} missing`);
      }
      check(meta["og:url"] === canonical, `${where} og:url differs from canonical`);
      check(/^https:\/\//.test(meta["og:image"] ?? ""), `${where} og:image is not absolute https`);
      const imagePath = local(decode(meta["og:image"]));
      const image = await get(imagePath);
      check(image.status === 200 && /image\/png/.test(image.headers.get("content-type") ?? ""), `${where} og:image does not load as PNG`);
      if (image.status === 200) {
        const { width, height } = pngSize(image.body);
        check(width === 1200 && height === 630, `${where} og:image is ${width}×${height}`);
        check(image.body.length <= BUDGET.socialImage, `${where} og:image is ${image.body.length} bytes`);
      }

      const h1s = html.match(/<h1[\s>]/g) ?? [];
      check(h1s.length === 1, `${where} has ${h1s.length} h1 elements`);
      let level = 1;
      for (const match of html.matchAll(/<h([1-6])[\s>]/g)) {
        const next = Number(match[1]);
        check(next <= level + 1, `${where} heading jumps from h${level} to h${next}`);
        level = next;
      }

      const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      check(ld.length === 1, `${where} expected one JSON-LD block`);
      for (const [, json] of ld) {
        let data;
        try {
          data = JSON.parse(json);
        } catch {
          check(false, `${where} JSON-LD does not parse`);
          continue;
        }
        check(data["@context"] === "https://schema.org" && Array.isArray(data["@graph"]), `${where} JSON-LD needs @context and @graph`);
        const types = data["@graph"].map((node) => node["@type"]);
        check(types.includes("WebSite"), `${where} JSON-LD has no WebSite`);
        if (!page.app) check(types.includes("BreadcrumbList"), `${where} JSON-LD has no BreadcrumbList`);
        check(!/"(aggregateRating|review)"\s*:/.test(json), `${where} JSON-LD must not claim ratings or reviews`);
      }

      for (const tag of html.match(/<img\s[^>]*>/g) ?? []) {
        check(attr(tag, "alt") !== undefined, `${where} image without alt: ${tag.slice(0, 80)}`);
        check(Boolean(attr(tag, "width") && attr(tag, "height")), `${where} image without dimensions (layout shift): ${tag.slice(0, 80)}`);
      }

      // Every link and resource on the page that points at this site must load.
      const refs = [...html.matchAll(/\s(?:href|src|srcset)="([^"]+)"/g)].map((match) => decode(match[1]));
      for (const ref of new Set(refs)) {
        if (/^(mailto:|#)/.test(ref)) continue;
        const resolved = new URL(ref, new URL(pathname.slice(1) || "./", SITE));
        const target = local(resolved.href);
        if (target === null) {
          check(resolved.protocol === "https:", `${where} insecure external link ${ref}`);
          continue;
        }
        const response = await get(target, { method: "HEAD" });
        check(response.status === 200, `${where} broken link ${ref} (${response.status})`);
      }

      if (!page.app) {
        const assets = [...html.matchAll(/(?:href|src)="(assets\/site-[^"]+\.(?:css|js))"/g)].map((match) => match[1]);
        const bytes = gzipSync(Buffer.concat([Buffer.from(html), ...assets.map((asset) => readFileSync(path.join(OUT, asset)))])).length;
        check(bytes <= BUDGET.pageGzip, `${where} page weighs ${bytes} bytes gzipped (budget ${BUDGET.pageGzip})`);
      }
    }

    // The app's own weight: what index.html pulls in before it can draw.
    const index = readFileSync(path.join(OUT, "index.html"), "utf8");
    const scripts = [...index.matchAll(/<(?:script[^>]+src|link[^>]+rel="modulepreload"[^>]+href)="\.?\/?(assets\/[^"]+\.js)"/g)].map((match) => match[1]);
    const styles = [...index.matchAll(/<link rel="stylesheet"[^>]+href="\.?\/?(assets\/[^"]+\.css)"/g)].map((match) => match[1]);
    const gz = (files) => files.reduce((sum, file) => sum + gzipSync(readFileSync(path.join(OUT, file))).length, 0);
    const jsBytes = gz(scripts);
    const cssBytes = gz(styles);
    check(scripts.length > 0, "found no scripts in index.html");
    check(jsBytes <= BUDGET.appJsGzip, `app JavaScript is ${jsBytes} bytes gzipped (budget ${BUDGET.appJsGzip})`);
    check(cssBytes <= BUDGET.appCssGzip, `app CSS is ${cssBytes} bytes gzipped (budget ${BUDGET.appCssGzip})`);
    for (const page of PAGES.filter((entry) => entry.hero)) {
      const size = readFileSync(path.join(OUT, page.hero.image)).length;
      check(size <= BUDGET.heroImage, `${page.hero.image} is ${size} bytes (budget ${BUDGET.heroImage})`);
    }
    check(/<div class="boot">/.test(index), "index.html lost its text shell");
    check(/<h1>Bookmark Studio<\/h1>/.test(index), "index.html shell has no heading");

    // Sitemap, robots, llms.txt.
    const sitemap = (await get("/sitemap.xml")).body.toString();
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    check(locs.length === PAGES.length, `sitemap lists ${locs.length} URLs, expected ${PAGES.length}`);
    for (const loc of locs) {
      const response = await get(local(loc));
      check(response.status === 200, `sitemap URL ${loc} returned ${response.status}`);
      check(response.body.toString().includes(`<link rel="canonical" href="${loc}"`), `sitemap URL ${loc} is not its page's canonical`);
    }
    const robots = (await get("/robots.txt")).body.toString();
    check(robots.includes(`Sitemap: ${new URL("sitemap.xml", SITE).href}`), "robots.txt does not point to the sitemap");
    check(!/Disallow:\s*\/\s*$/m.test(robots), "robots.txt blocks the whole site");
    const llms = (await get("/llms.txt")).body.toString();
    check(/^# .+\n\n> .+/.test(llms), "llms.txt must start with an H1 and a summary quote");
    for (const [, url] of llms.matchAll(/\]\((https:[^)]+)\)/g)) {
      const target = local(url);
      if (target === null) continue;
      check((await get(target)).status === 200, `llms.txt links to missing ${url}`);
    }
    const security = (await get("/.well-known/security.txt")).body.toString();
    const expires = /Expires: (.+)/.exec(security)?.[1];
    check(Boolean(expires) && new Date(expires) > new Date(), "security.txt Expires is missing or past");

    await browserChecks(base);
  } finally {
    server.close();
  }

  console.log(`[check-site] ${passes} checks passed for ${SITE}`);
  if (failures.length) {
    for (const failure of failures) console.error(`[check-site] ✗ ${failure}`);
    process.exit(1);
  }
}

/** Accessibility and console errors in a real browser, when one and axe-core are available. */
async function browserChecks(base) {
  const { findChrome } = await import("./lib/chrome.mjs");
  const executablePath = findChrome();
  let axeSource;
  try {
    axeSource = readFileSync(path.join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8");
  } catch {
    axeSource = null;
  }
  if (!executablePath) {
    console.log("[check-site] no Chrome found: skipping the browser checks");
    return;
  }
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    for (const [pathname, scheme, width] of [["/about", "light", 1280], ["/about", "dark", 390], ["/privacy", "light", 390], ["/no-such-page", "dark", 1280], ["/", "light", 1280], ["/", "dark", 390]]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 900 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      const errors = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(String(error)));
      // Only so axe can be injected below; the page's own scripts are already 'self'.
      if (axeSource) await page.setBypassCSP(true);
      const where = `${pathname} (${scheme}, ${width}px):`;
      await page.goto(base + pathname, { waitUntil: "networkidle0" });
      // The 404 page's own status shows up as a console error; that one is expected.
      const unexpected = errors.filter((text) => !(pathname === "/no-such-page" && /404/.test(text)));
      check(unexpected.length === 0, `${where} console errors: ${unexpected.join(" | ")}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(overflow <= 0, `${where} scrolls sideways by ${overflow}px`);
      if (axeSource) {
        await page.addScriptTag({ content: axeSource });
        const result = await page.evaluate(async () => {
          // @ts-ignore injected above
          const report = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
          return report.violations.map((violation) => `${violation.id} (${violation.nodes.length}): ${violation.nodes[0]?.target.join(" ")}`);
        });
        check(result.length === 0, `${where} accessibility: ${result.join("; ")}`);
      }
      await page.close();
    }
    if (!axeSource) console.log("[check-site] axe-core not installed: accessibility scan skipped (npm i --no-save axe-core)");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
