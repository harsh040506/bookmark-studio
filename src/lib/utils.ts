import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { getRuntime } from "./runtime";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(timestamp?: number): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}

/**
 * A media duration as clock time.
 *
 * Hours are only shown when there are any: "1:23" is a minute and a half, and padding it
 * to "0:01:23" to keep one format makes the common case harder to read for the sake of
 * the rare one.
 */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Splits a list into fixed-size chunks — used to batch health checks. */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Collision-resistant id without pulling in a uuid dependency. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function downloadFile(content: string, filename: string, type = "text/html"): void {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Favicon for a domain when the export did not embed one.
 *
 * Deliberately routed through our own server rather than a public favicon service:
 * asking a third party for an icon per domain would hand them the list of sites the
 * user has bookmarked, which contradicts the whole point of a local-first library.
 */
export function faviconFor(domain: string): string | null {
  const net = getRuntime().net;
  if (net === "extension" || net === "bridge") return `ext-fav://${encodeURIComponent(domain)}`;
  if (net === "server") {
    return new URL(`api/favicon?domain=${encodeURIComponent(domain)}`, document.baseURI).toString();
  }
  // Offline: there is nobody to ask without telling a third party what is bookmarked.
  return null;
}

/**
 * Keyboard shortcut labels that match the keyboard in front of the user.
 *
 * The interface used to hard-code Apple glyphs — "⌘K", "⇧⌘Z" — on every platform. On
 * Windows that is wrong twice over: the key is Ctrl, not Command, and the ⌘ glyph is
 * missing from the monospace faces the labels were rendered in, so the browser
 * substituted it from a symbol font and the hint came out as a stray pictogram sitting
 * beside a letter or a number.
 *
 * Specs are written platform-neutrally — `shortcut("mod+K")`, `shortcut("shift+mod+Z")` —
 * and rendered as glyphs on Apple hardware and as words everywhere else, which is the
 * convention each platform's own applications follow.
 */
const IS_APPLE =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

const APPLE_KEYS: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  enter: "↵",
  backspace: "⌫",
};

const OTHER_KEYS: Record<string, string> = {
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  enter: "Enter",
  backspace: "Del",
};

/**
 * A shortcut as separate key names, for `<kbd>` chips: "mod+shift+Z" → ["Ctrl", "Shift", "Z"]
 * (or ["⌘", "⇧", "Z"]). Accepts an already-rendered Apple string ("⇧⌘Z") too.
 */
export function shortcutParts(spec: string): string[] {
  if (!spec) return [];
  const table = IS_APPLE ? APPLE_KEYS : OTHER_KEYS;
  if (spec.includes("+") && spec.length > 1) {
    return spec
      .split("+")
      .filter(Boolean)
      .map((part) => table[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part));
  }
  // "⇧⌘Z" — Apple modifiers stacked with no separator.
  if (/^[⌘⇧⌥⌃]+.$/u.test(spec)) return [...spec];
  return [table[spec.toLowerCase()] ?? spec];
}

export function shortcut(spec: string): string {
  const table = IS_APPLE ? APPLE_KEYS : OTHER_KEYS;
  const parts = spec.split("+").map((part) => table[part] ?? part);
  // Apple stacks modifiers with no separator; every other platform joins them with "+".
  return IS_APPLE ? parts.join("") : parts.join("+");
}

/**
 * A stable [0, 1) fraction from a string — the same input always returns the same value.
 *
 * Used wherever an id needs a piece of visual variety that must never change between
 * renders (a masonry card's height, a fallback tile's hue): a `Math.random()` there would
 * make the layout reflow, or the tile recolour, every time the component remounts.
 */
export function hashUnit(value: string): number {
  let hash = 0;
  for (let position = 0; position < value.length; position += 1) {
    hash = (hash * 31 + value.charCodeAt(position)) | 0;
  }
  // >>> 0 forces the sign bit off before normalising, so the result is always in [0, 1).
  return ((hash >>> 0) % 10_000) / 10_000;
}
