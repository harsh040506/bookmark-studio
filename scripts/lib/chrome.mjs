// Finds a local Chrome, Edge or Chromium for scripts that need a real browser (icons, smoke
// test). CHROME_PATH wins when set. Mirrors the lookup the local server does in server/screenshot.ts.
import { existsSync } from "node:fs";

const CANDIDATES = [
  process.env.CHROME_PATH,
  // Windows
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/snap/bin/chromium",
].filter(Boolean);

export function findChrome() {
  for (const candidate of CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}
