// Re-shoots every picture of the app from the real thing, so the README, the website and the
// social previews never show an older interface:
//
//   npm run build && npm i --no-save sharp && npm run media
//
// It starts the local server, opens the app in a fresh profile, loads the sample library,
// waits for every preview to be captured, then writes:
//
//   docs/media/*.webp       README screenshots, at twice the viewport's resolution
//   docs/media/showcase-*   the same from a real-world library (scripts/media/showcase.html)
//   docs/media/demo.gif     the README's walk-through
//   public/media/*          the about page's screenshot (WebP, with a PNG fallback)
//   public/og/*.png         1200×630 link previews, one per page (site/content.mjs names them)
//
// Needs a local Chrome or Edge (CHROME_PATH to choose one). sharp is used only here, so it is
// not a dependency of the project.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { PAGES } from "../site/content.mjs";
import { findChrome } from "./lib/chrome.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.MEDIA_PORT || 5199);
const APP = `http://127.0.0.1:${PORT}/`;
const DOCS = path.join(ROOT, "docs", "media");
const PUBLIC_MEDIA = path.join(ROOT, "public", "media");
const OG = path.join(ROOT, "public", "og");
const PROFILE = path.join(ROOT, ".cache", "media-profile");

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("[media] needs sharp for image encoding: npm i --no-save sharp");
  process.exit(1);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "server", "server.js")], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), HOST: "127.0.0.1", NO_OPEN: "1", LOG_LEVEL: "warn" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 20_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("api on")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
}

async function webp(buffer, file, { width, quality = 88 } = {}) {
  let image = sharp(buffer);
  if (width) image = image.resize({ width });
  await image.webp({ quality, effort: 6, smartSubsample: true }).toFile(file);
  console.log(`[media] ${path.relative(ROOT, file)}`);
}

/**
 * Waits until every picture on screen has loaded and decoded: no loading placeholders left,
 * and each visible image complete with real pixels. Off-screen (lazy) images are ignored.
 */
async function imagesReady(page, timeout = 20_000) {
  await page
    .waitForFunction(
      () => {
        const inView = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
        };
        if ([...document.querySelectorAll(".bs-ph")].some(inView)) return false;
        return [...document.images].filter(inView).every((image) => image.complete && image.naturalWidth > 0);
      },
      { timeout, polling: 200 },
    )
    .catch(() => console.log("[media] some pictures were still loading after 20 s; carrying on"));
  // Decode what is on screen; an off-screen lazy image would never finish, so it is skipped.
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        [...document.images]
          .filter((image) => image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().bottom > 0 && image.getBoundingClientRect().top < innerHeight)
          .map((image) => image.decode().catch(() => undefined)),
      ),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]),
  );
}

async function settle(page, ms = 600) {
  // The pointer is parked in an empty corner, so no card shows its hover tools.
  await page.mouse.move(2, (page.viewport()?.height ?? 800) - 2);
  await page.evaluate(() => document.fonts.ready);
  await imagesReady(page);
  await wait(ms);
}

/**
 * Retakes, once, any preview that came out as a blank page (some sites fade in after load).
 * Runs at a tall viewport so every card in the current view is drawn and can be measured.
 */
async function retakeBlankPreviews(page) {
  const viewport = page.viewport();
  await page.setViewport({ ...viewport, height: 3600 });
  await settle(page, 800);
  const blank = await page.evaluate(() =>
    [...document.querySelectorAll(".bs-item-card")].flatMap((card) => {
      const image = card.querySelector(".bs-item-media img");
      if (!image?.naturalWidth) return [];
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 24;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, 24, 24);
      let data;
      try {
        data = context.getImageData(0, 0, 24, 24).data;
      } catch {
        return [];
      }
      let sum = 0;
      let squares = 0;
      for (let index = 0; index < data.length; index += 4) {
        const light = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
        sum += light;
        squares += light * light;
      }
      const count = data.length / 4;
      const spread = Math.sqrt(squares / count - (sum / count) ** 2);
      return spread < 3 ? [card.querySelector(".bs-item-title")?.textContent ?? ""] : [];
    }),
  );
  for (const title of blank.filter(Boolean)) {
    console.log(`[media] retaking a blank preview: ${title}`);
    await clickCard(page, title);
    const refresh = await page.waitForSelector('button[aria-label="Refresh preview"]', { timeout: 5_000 }).catch(() => null);
    if (refresh) {
      await refresh.click();
      await wait(2_000);
      await previewsSettled(page);
    }
    await page.keyboard.press("Escape");
    await wait(500);
  }
  await page.setViewport(viewport);
  await settle(page, 500);
}

/** Clicks the bookmark card whose title starts with `title`. */
async function clickCard(page, title) {
  const handle = await page.evaluateHandle(
    (text) => [...document.querySelectorAll(".bs-item-card")].find((card) => card.querySelector(".bs-item-title")?.textContent?.startsWith(text)),
    title,
  );
  const card = handle.asElement();
  if (!card) throw new Error(`No card "${title}"`);
  await card.click();
}

/** Clicks a sidebar entry by its exact label. */
async function clickNav(page, label) {
  const found = await page.evaluate((text) => {
    const button = [...document.querySelectorAll(".bs-nav-button")].find((node) => node.querySelector(".bs-nav-label")?.textContent?.trim() === text);
    button?.click();
    return Boolean(button);
  }, label);
  if (!found) throw new Error(`No sidebar entry "${label}"`);
}

/** Waits until previews have stopped arriving: nothing filling in for 15 s, or no progress for 90 s. */
async function previewsSettled(page) {
  const started = Date.now();
  let quietSince = 0;
  let last = Infinity;
  let lastChange = Date.now();
  for (;;) {
    const busy = await page.$$eval(".bs-conn-label", (nodes) => {
      const match = nodes.map((node) => /Filling in ([\d,]+)/.exec(node.textContent ?? "")).find(Boolean);
      return match ? Number(match[1].replace(/,/g, "")) : 0;
    });
    if (busy !== last) lastChange = Date.now();
    last = busy;
    if (busy === 0) {
      quietSince ||= Date.now();
      if (Date.now() - quietSince > 15_000) break;
    } else quietSince = 0;
    if (busy && Date.now() - lastChange > 90_000) {
      console.log(`[media] ${busy} previews are not coming; carrying on`);
      break;
    }
    if (Date.now() - started > 15 * 60_000) throw new Error("previews did not finish in 15 minutes");
    await wait(1000);
  }
  console.log(`[media] previews settled after ${Math.round((Date.now() - started) / 1000)} s`);
}

async function typeSlowly(page, selector, text, delay = 110) {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char);
    await wait(delay);
  }
}

/** Records the page with the DevTools screencast, which sends a frame only when pixels change. */
async function record(page, script) {
  const cdp = await page.createCDPSession();
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ data: Buffer.from(data, "base64"), at: metadata.timestamp * 1000 });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await script();
  await wait(400);
  await cdp.send("Page.stopScreencast");
  const end = Date.now();
  return frames.map((frame, index) => ({ ...frame, duration: Math.max(40, (frames[index + 1]?.at ?? end) - frame.at) }));
}

async function encodeGif(frames, file, width) {
  // Frames shorter than 80 ms are merged into the next, which keeps the file small without
  // making the motion visibly choppy.
  const kept = [];
  let carry = 0;
  for (const [index, frame] of frames.entries()) {
    const duration = frame.duration + carry;
    if (duration < 80 && index < frames.length - 1) {
      carry = duration;
      continue;
    }
    carry = 0;
    kept.push({ ...frame, duration: Math.min(duration, 3000) });
  }
  const resized = await Promise.all(kept.map((frame) => sharp(frame.data).resize({ width }).png().toBuffer()));
  await sharp(resized, { join: { animated: true } })
    .gif({ delay: kept.map((frame) => Math.round(frame.duration)), loop: 0, effort: 10, colours: 256, dither: 0.6, interFrameMaxError: 6, interPaletteMaxError: 6 })
    .toFile(file);
  console.log(`[media] ${path.relative(ROOT, file)}: ${kept.length} frames, ${(readFileSync(file).length / 1e6).toFixed(1)} MB`);
}

/** One 1200×630 preview card: the page's headline beside a real screenshot. */
async function renderOg(browser, { heading, kicker, shot, file }) {
  const font = (pkg, name) =>
    `data:font/woff2;base64,${readFileSync(path.join(ROOT, "node_modules", "@fontsource-variable", pkg, "files", name)).toString("base64")}`;
  const logo = readFileSync(path.join(ROOT, "public", "favicon.svg"), "utf8");
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
    @font-face{font-family:Sans;src:url(${font("dm-sans", "dm-sans-latin-wght-normal.woff2")});font-weight:100 1000}
    @font-face{font-family:Serif;src:url(${font("newsreader", "newsreader-latin-wght-normal.woff2")});font-weight:200 800}
    *{box-sizing:border-box}body{margin:0;width:1200px;height:630px;overflow:hidden;background:#faf9f5;color:#1f1e1d;font-family:Sans}
    .text{position:absolute;left:72px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center}
    .brand{display:flex;align-items:center;gap:14px;font-size:24px;font-weight:600;margin-bottom:40px}
    .brand svg{width:48px;height:48px}
    h1{font-family:Serif;font-weight:400;font-size:58px;line-height:1.05;letter-spacing:-.015em;margin:0 0 22px}
    p{font-size:22px;line-height:1.45;color:#52514e;margin:0}
    .shot{position:absolute;left:600px;top:70px;width:900px;border-radius:16px;overflow:hidden;
      box-shadow:0 0 0 1px rgba(11,11,11,.1),0 24px 60px rgba(11,11,11,.14)}
    .shot img{display:block;width:100%}
  </style></head><body>
    <div class="text"><div class="brand">${logo}<span>Bookmark Studio</span></div><h1>${heading}</h1><p>${kicker}</p></div>
    <div class="shot"><img src="data:image/png;base64,${shot.toString("base64")}"></div>
  </body></html>`);
  await settle(page, 200);
  const png = await page.screenshot({ type: "png" });
  // A palette PNG keeps it near 100 KB; WhatsApp drops preview images over 300 KB.
  await sharp(png).png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 }).toFile(file);
  await page.close();
  console.log(`[media] ${path.relative(ROOT, file)}`);
}

async function main() {
  const executablePath = findChrome();
  if (!executablePath) throw new Error("No local Chrome or Edge found (set CHROME_PATH)");
  for (const dir of [DOCS, PUBLIC_MEDIA, OG]) mkdirSync(dir, { recursive: true });
  // The profile is kept between runs so previews are captured once; MEDIA_FRESH=1 starts over.
  if (process.env.MEDIA_FRESH) rmSync(PROFILE, { recursive: true, force: true });

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: PROFILE,
    args: ["--hide-scrollbars", "--force-color-profile=srgb", "--lang=en-GB"],
  });
  try {
    // MEDIA_ONLY=showcase or MEDIA_ONLY=sample re-shoots just one set.
    const hero = process.env.MEDIA_ONLY === "sample" ? null : await showcase(executablePath);
    if (process.env.MEDIA_ONLY !== "showcase") await sampleSet(browser);
    if (!hero) return;

    // The about page's picture and the link previews come from the real library.
    await webp(hero, path.join(PUBLIC_MEDIA, "library-light.webp"), { width: 1440, quality: 84 });
    await sharp(hero).resize({ width: 1440 }).png({ compressionLevel: 9 }).toFile(path.join(PUBLIC_MEDIA, "library-light.png"));
    // Link previews, one per page.
    const og = {
      home: { heading: "A calm home for everything you save", kicker: "Import, search and tidy years of bookmarks. Free, open source, private." },
      about: { heading: "You saved it for a reason", kicker: "Find it again: search that reads the page, previews, dead links and duplicates." },
      privacy: { heading: "Your library never leaves your browser", kicker: "No account, no analytics, no cookies, no AI." },
    };
    for (const sitePage of PAGES) {
      await renderOg(browser, { ...og[sitePage.id], shot: await sharp(hero).resize({ width: 1200 }).png().toBuffer(), file: path.join(ROOT, "public", sitePage.og.image) });
    }
  } finally {
    await browser.close();
    server.kill();
  }
}


/** One step of a walk-through: let the pictures load, then hold for `ms`. */
async function step(page, ms) {
  await imagesReady(page, 10_000);
  await wait(ms);
}

/** The sample library's pictures and walk-through (docs/media/*.webp and demo.gif). */
async function sampleSet(browser) {
  const desktop = { width: 1440, height: 900, deviceScaleFactor: 2 };

  // The first-run screen, in a throwaway context so it is always empty.
  const fresh = await browser.createBrowserContext();
  const first = await fresh.newPage();
  await first.setViewport(desktop);
  await first.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await first.goto(APP, { waitUntil: "networkidle0" });
  await first.waitForSelector("text/Load the sample", { timeout: 20_000 });
  await settle(first);
  await webp(await first.screenshot(), path.join(DOCS, "welcome-light.webp"));
  await fresh.close();

  const page = await browser.newPage();
  await page.setViewport(desktop);
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.goto(APP, { waitUntil: "networkidle0" });
  // A service worker left from an earlier build would announce "a new version" in every
  // picture; start each run without one.
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await page.reload({ waitUntil: "networkidle0" });

  // The sample library, with every preview filled in.
  const search = 'input[aria-label="Search the library"]';
  if (!(await page.$(search))) {
    await page.click("text/Load the sample");
    await page.waitForSelector(search, { timeout: 30_000 });
  }
  await wait(3000);
  await previewsSettled(page);

  // Reading has the most varied, readable previews: the best first impression.
  await clickNav(page, "Reading");
  await settle(page, 2000);
  await webp(await page.screenshot(), path.join(DOCS, "library-light.webp"));

  // A search across the whole library that forgives a typo.
  await clickNav(page, "All bookmarks");
  await typeSlowly(page, 'input[aria-label="Search the library"]', "typografy", 0);
  await settle(page, 1200);
  await webp(await page.screenshot(), path.join(DOCS, "search-light.webp"));
  await page.click('button[aria-label="Clear search"]');
  await settle(page);

  // The detail panel.
  await clickNav(page, "Reading");
  await settle(page);
  await clickCard(page, "Quanta Magazine");
  await settle(page, 1200);
  await webp(await page.screenshot(), path.join(DOCS, "detail-light.webp"));
  await page.keyboard.press("Escape");
  await settle(page);

  // Dark, on another folder.
  await clickNav(page, "Learning");
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await settle(page, 1200);
  await webp(await page.screenshot(), path.join(DOCS, "library-dark.webp"));
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);

  // A phone.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await settle(page, 1500);
  await webp(await page.screenshot(), path.join(DOCS, "mobile-light.webp"), { quality: 86 });

  // The walk-through: a typo forgiven, a filter typed, a bookmark opened, the layouts.
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(search);
  await clickNav(page, "Reading");
  await settle(page, 2000);
  await sampleTour(page, search); // a warm-up pass, so every picture is decoded before recording
  await clickNav(page, "Reading");
  await settle(page, 2000);
  const frames = await record(page, () => sampleTour(page, search));
  await encodeGif(frames, path.join(DOCS, "demo.gif"), 1100);
}

async function sampleTour(page, search) {
  await step(page, 1400);
  await clickNav(page, "All bookmarks");
  await step(page, 900);
  await typeSlowly(page, search, "typografy");
  await step(page, 2200);
  await page.click('button[aria-label="Clear search"]');
  await step(page, 500);
  await typeSlowly(page, search, "kind:video");
  await step(page, 2000);
  await page.click('button[aria-label="Clear search"]');
  await step(page, 500);
  await clickNav(page, "Reading");
  await step(page, 1000);
  await clickCard(page, "Quanta Magazine");
  await step(page, 2400);
  await page.keyboard.press("Escape");
  await step(page, 600);
  await page.click('[aria-label="Masonry"]');
  await step(page, 1800);
  await page.click('[aria-label="List"]');
  await step(page, 1800);
  await page.click('[aria-label="Grid"]');
  await step(page, 1200);
  await clickNav(page, "Learning");
  await step(page, 1600);
}

/**
 * The real library (scripts/media/showcase.html): two dozen AI startups and a few personal
 * projects, imported through the import dialog the way anyone would. It makes the README's
 * cover walk-through, most of its pictures, the about page's picture and the link previews.
 * Kept in its own profile so the sample library's pictures are unaffected. Returns the
 * library shot used for the site.
 */
async function showcase(executablePath) {
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: path.join(ROOT, ".cache", "media-showcase-profile"),
    args: ["--hide-scrollbars", "--force-color-profile=srgb", "--lang=en-GB"],
  });
  try {
    const page = await browser.newPage();
    const desktop = { width: 1440, height: 900, deviceScaleFactor: 2 };
    await page.setViewport(desktop);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.goto(APP, { waitUntil: "networkidle0" });
    await page.evaluate(async () => {
      for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    });
    await page.reload({ waitUntil: "networkidle0" });

    const search = 'input[aria-label="Search the library"]';
    // The welcome screen means the library is still empty.
    if (await page.$("::-p-text(Choose a file)")) {
      await page.click("::-p-text(Choose a file)");
      const input = await page.waitForSelector('input[type="file"]', { timeout: 10_000 });
      await input.uploadFile(path.join(ROOT, "scripts", "media", "showcase.html"));
      await page.waitForSelector("::-p-text(Preview)", { timeout: 15_000 });
      await wait(800);
      await page.click("::-p-text(Preview)");
      const confirm = await page.waitForSelector("::-p-text(Import 28)", { timeout: 20_000 });
      await confirm.click();
      await page.waitForFunction(() => [...document.querySelectorAll(".bs-nav-label")].some((node) => node.textContent?.trim() === "AI startups"), { timeout: 30_000 });
    }
    await wait(3000);
    await previewsSettled(page);
    for (const folder of ["AI startups", "My projects"]) {
      await clickNav(page, folder);
      await retakeBlankPreviews(page);
    }

    // The library, light and dark, in each layout.
    await clickNav(page, "AI startups");
    await settle(page, 1500);
    const hero = await page.screenshot();
    await webp(hero, path.join(DOCS, "showcase-startups-light.webp"));
    await page.click('[aria-label="Masonry"]');
    await settle(page, 1500);
    await webp(await page.screenshot(), path.join(DOCS, "showcase-masonry-light.webp"));
    await page.click('[aria-label="List"]');
    await settle(page, 1500);
    await webp(await page.screenshot(), path.join(DOCS, "showcase-list-light.webp"));
    await page.click('[aria-label="Grid"]');
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await settle(page, 1500);
    await webp(await page.screenshot(), path.join(DOCS, "showcase-startups-dark.webp"));

    // A bookmark up close, in dark.
    await clickCard(page, "Daylight");
    await settle(page, 1500);
    await webp(await page.screenshot(), path.join(DOCS, "showcase-detail-dark.webp"));
    await page.keyboard.press("Escape");
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);

    // One of the projects, described by its own page.
    await clickNav(page, "My projects");
    await settle(page, 1000);
    await clickCard(page, "Solid State");
    await settle(page, 1500);
    await webp(await page.screenshot(), path.join(DOCS, "showcase-project-detail.webp"));
    await page.keyboard.press("Escape");

    // Search that reads the pages, not just their titles.
    await clickNav(page, "All bookmarks");
    await wait(1000);
    await typeSlowly(page, search, "agents");
    await page.waitForSelector('button[aria-label="Clear search"]', { timeout: 10_000 });
    await settle(page, 1500);
    await webp(await page.screenshot(), path.join(DOCS, "showcase-search-light.webp"));
    await page.click('button[aria-label="Clear search"]');

    // The command palette.
    await clickNav(page, "AI startups");
    await settle(page, 800);
    await page.keyboard.down("Control");
    await page.keyboard.press("k");
    await page.keyboard.up("Control");
    await wait(500);
    await page.keyboard.type("memory", { delay: 60 });
    await settle(page, 1200);
    await webp(await page.screenshot(), path.join(DOCS, "showcase-palette-light.webp"));
    await page.keyboard.press("Escape");
    await wait(400);

    // A phone.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await settle(page, 1500);
    await webp(await page.screenshot(), path.join(DOCS, "showcase-mobile-light.webp"), { quality: 86 });

    // The cover walk-through. Played once to load and decode every picture, then recorded.
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(search);
    await clickNav(page, "AI startups");
    await settle(page, 1500);
    await showcaseTour(page, search);
    await clickNav(page, "AI startups");
    await settle(page, 2000);
    const frames = await record(page, () => showcaseTour(page, search));
    await encodeGif(frames, path.join(DOCS, "showcase-demo.gif"), 1100);
    return hero;
  } finally {
    await browser.close();
  }
}

async function showcaseTour(page, search) {
  await step(page, 1800);
  await clickNav(page, "All bookmarks");
  await step(page, 700);
  await typeSlowly(page, search, "agents");
  await step(page, 2400);
  await page.click('button[aria-label="Clear search"]');
  await step(page, 400);
  await clickNav(page, "AI startups");
  await step(page, 900);
  await clickCard(page, "Daylight");
  await step(page, 2400);
  await page.keyboard.press("Escape");
  await step(page, 500);
  await clickNav(page, "My projects");
  await step(page, 1000);
  await clickCard(page, "Solid State");
  await step(page, 2600);
  await page.keyboard.press("Escape");
  await step(page, 500);
  await clickNav(page, "AI startups");
  await step(page, 900);
  await page.click('[aria-label="Masonry"]');
  await step(page, 2000);
  await page.click('[aria-label="List"]');
  await step(page, 1800);
  await page.click('[aria-label="Grid"]');
  await step(page, 1600);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

