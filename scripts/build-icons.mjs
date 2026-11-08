// Renders the app mark (src/components/app/logo.tsx → public/favicon.svg) to every PNG size the
// extension manifest and the web app manifest need, using a local Chrome or Edge through
// puppeteer-core rather than adding an image library. The PNGs are committed, so this only needs
// running when the mark changes:  npm run icons
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findChrome } from "./lib/chrome.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SVG = readFileSync(path.join(ROOT, "public", "favicon.svg"), "utf8");
const OUT = path.join(ROOT, "public", "icons");

/** [file name, size, padding as a fraction of the size (maskable icons need a safe zone)]. */
const TARGETS = [
  ["icon16.png", 16, 0],
  ["icon32.png", 32, 0],
  ["icon48.png", 48, 0],
  ["icon128.png", 128, 0],
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["apple-touch-icon.png", 180, 0.08],
  ["icon-maskable-512.png", 512, 0.12],
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const executablePath = findChrome();
  if (!executablePath) {
    console.error("[icons] no Chrome or Edge found. Set CHROME_PATH to one, then run again.");
    process.exit(1);
  }
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    for (const [name, size, pad] of TARGETS) {
      const inset = Math.round(size * pad);
      // Maskable and Apple icons get the paper colour behind a smaller tile, so the OS mask
      // never clips the mark; the others are the tile alone on transparency.
      const background = pad ? "#faf9f5" : "transparent";
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      await page.setContent(
        `<html><body style="margin:0;background:${background};width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">` +
          `<div style="width:${size - inset * 2}px;height:${size - inset * 2}px">${SVG.replace("<svg ", '<svg width="100%" height="100%" ')}</div>` +
          `</body></html>`,
      );
      const bytes = await page.screenshot({ omitBackground: !pad, type: "png", clip: { x: 0, y: 0, width: size, height: size } });
      writeFileSync(path.join(OUT, name), bytes);
      console.log(`[icons] ${name} (${size}px)`);
    }
  } finally {
    await browser.close();
  }
  if (!existsSync(path.join(OUT, "icon128.png"))) process.exit(1);
}

main().catch((error) => {
  console.error("[icons] failed:", error);
  process.exit(1);
});
