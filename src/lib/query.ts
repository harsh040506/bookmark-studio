/**
 * Query parsing for the search bar.
 *
 * Handles both operator syntax (`tag:react is:dead`) and the plain-English phrasing
 * people actually type ("ai coding tools I saved last month"). The date and status
 * phrases are matched by rule and stripped out; whatever is left becomes the free-text
 * part that TF-IDF ranks. No model interprets the query.
 */
import type { FormatFacet, HealthStatus, ItemKind } from "../../shared/types";
import { binForHex, COLOR_WHEEL } from "./visual";
import { tokenize } from "./text";

export interface QueryFilters {
  tags: string[];
  folders: string[];
  categories: string[];
  domains: string[];
  health: HealthStatus[];
  /** `kind:video`, or the plain word "videos". */
  kinds: ItemKind[];
  /** Hue bins a colour query asked for — see `lib/visual.ts`. */
  colors: number[];
  /** Restrict to one standing source. */
  sourceIds: string[];
  /** `has:offline` — only items with a saved offline copy. */
  offline?: boolean;
  /** `has:media` — only items whose bytes this library owns. */
  media?: boolean;
  /** Only items whose picture something else in the library matches. */
  lookalikes?: boolean;
  favorite?: boolean;
  archived?: boolean;
  untagged?: boolean;
  duplicates?: boolean;
  /**
   * Bookmarks never opened from this app.
   *
   * Distinct from any health status: a link can be perfectly alive and still be one
   * nobody has looked at since the day it was saved, which is precisely the set worth
   * reviewing when a library gets unwieldy.
   */
  neverVisited?: boolean;
  addedAfter?: number;
  addedBefore?: number;
}

export interface ParsedQuery {
  /** Free-text remainder after operators and phrases were removed. */
  text: string;
  terms: string[];
  filters: QueryFilters;
  /** Human-readable summary of what was understood, shown as chips in the UI. */
  chips: { label: string; kind: keyof QueryFilters | "text" }[];
  /**
   * Spelling corrections applied to `terms` against the library's own vocabulary.
   *
   * Reported rather than applied silently: searching for something you did not type and
   * not being told is worse than finding nothing, because the results look wrong and
   * nothing on screen explains why. The UI renders these as "Showing results for …".
   *
   * Empty for a query that needed no correction, which is the overwhelming majority.
   */
  corrections?: { from: string; to: string }[];
}

const DAY = 24 * 60 * 60 * 1000;

/** Plain-English time ranges, longest phrase first so "last month" beats "month". */
const DATE_PHRASES: { pattern: RegExp; range: (now: number) => [number, number] }[] = [
  { pattern: /\b(today)\b/, range: (now) => [startOfDay(now), now] },
  { pattern: /\b(yesterday)\b/, range: (now) => [startOfDay(now) - DAY, startOfDay(now)] },
  { pattern: /\b(this week)\b/, range: (now) => [now - 7 * DAY, now] },
  { pattern: /\b(last week)\b/, range: (now) => [now - 14 * DAY, now - 7 * DAY] },
  { pattern: /\b(this month|past month|last month)\b/, range: (now) => [now - 30 * DAY, now] },
  { pattern: /\b(this year|past year|last year)\b/, range: (now) => [now - 365 * DAY, now] },
  { pattern: /\blast (\d+) days?\b/, range: (now) => [now, now] }, // replaced below
  { pattern: /\bolder than a year\b/, range: (now) => [0, now - 365 * DAY] },
  { pattern: /\bolder than (\d+) months?\b/, range: (now) => [0, now] }, // replaced below
];

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const HEALTH_PHRASES: { pattern: RegExp; status: HealthStatus }[] = [
  { pattern: /\b(dead|broken|404|not found)\b/, status: "dead" },
  { pattern: /\b(redirected|moved)\b/, status: "redirected" },
  { pattern: /\b(blocked|paywalled|forbidden)\b/, status: "blocked" },
  { pattern: /\b(unchecked|never checked)\b/, status: "unchecked" },
  { pattern: /\b(healthy|alive|working)\b/, status: "live" },
];

function emptyFilters(): QueryFilters {
  return {
    tags: [],
    folders: [],
    categories: [],
    domains: [],
    health: [],
    kinds: [],
    colors: [],
    sourceIds: [],
  };
}

/**
 * Plain words that name a format.
 *
 * Matched before the free-text pass so "videos by fons" narrows to videos rather than
 * ranking every document containing the stemmed term "video" — which is what the
 * reference does, and the difference between a query that reads as understood and one
 * that reads as a keyword search.
 */
const KIND_PHRASES: { pattern: RegExp; kinds: ItemKind[]; label: string }[] = [
  { pattern: /\b(videos?|clips? of video|movies?)\b/, kinds: ["video"], label: "videos" },
  { pattern: /\b(images?|photos?|pictures?|screenshots?)\b/, kinds: ["image"], label: "images" },
  { pattern: /\b(notes?|posts?|tweets?|quotes?)\b/, kinds: ["note"], label: "notes" },
  { pattern: /\b(links?|articles?|pages?|sites?|websites?)\b/, kinds: ["link"], label: "links" },
];

/** Colour names the query understands, mapped to the hue bins the index uses. */
const COLOR_WORDS = new Map<string, number>(
  COLOR_WHEEL.map((entry) => [entry.name, entry.bin] as const),
);
// A few synonyms people actually type.
COLOR_WORDS.set("purple", 9);
COLOR_WORDS.set("turquoise", 5);
COLOR_WORDS.set("aqua", 6);
COLOR_WORDS.set("crimson", 0);
COLOR_WORDS.set("gold", 2);

/** The format facet as a filter, so the pills and the query language share one path. */
export function facetToKinds(facet: FormatFacet): ItemKind[] {
  switch (facet) {
    case "links":
      return ["link"];
    case "images":
      return ["image"];
    case "videos":
      return ["video"];
    case "notes":
      return ["note"];
    default:
      return [];
  }
}

export function parseQuery(input: string, now = Date.now()): ParsedQuery {
  const filters = emptyFilters();
  const chips: ParsedQuery["chips"] = [];
  let rest = ` ${input.toLowerCase().trim()} `;

  const consume = (pattern: RegExp) => {
    rest = rest.replace(pattern, " ");
  };

  // --- operator syntax: key:value (quoted values allowed) ---
  const operator =
    /\b(tag|folder|category|site|domain|is|before|after|kind|type|color|colour|has|source)\s*:\s*("([^"]+)"|[^\s]+)/g;
  let match: RegExpExecArray | null;
  const operatorMatches: { key: string; value: string; raw: string }[] = [];
  while ((match = operator.exec(rest))) {
    operatorMatches.push({
      key: match[1],
      value: (match[3] ?? match[2]).replace(/^"|"$/g, ""),
      raw: match[0],
    });
  }
  for (const { key, value, raw } of operatorMatches) {
    rest = rest.replace(raw, " ");
    switch (key) {
      case "tag":
        filters.tags.push(value);
        chips.push({ label: `tag: ${value}`, kind: "tags" });
        break;
      case "folder":
        filters.folders.push(value);
        chips.push({ label: `folder: ${value}`, kind: "folders" });
        break;
      case "category":
        filters.categories.push(value);
        chips.push({ label: `category: ${value}`, kind: "categories" });
        break;
      case "site":
      case "domain":
        filters.domains.push(value.replace(/^www\./, ""));
        chips.push({ label: `site: ${value}`, kind: "domains" });
        break;
      case "before": {
        const timestamp = Date.parse(value);
        if (!Number.isNaN(timestamp)) {
          filters.addedBefore = timestamp;
          chips.push({ label: `before ${value}`, kind: "addedBefore" });
        }
        break;
      }
      case "after": {
        const timestamp = Date.parse(value);
        if (!Number.isNaN(timestamp)) {
          filters.addedAfter = timestamp;
          chips.push({ label: `after ${value}`, kind: "addedAfter" });
        }
        break;
      }
      case "kind":
      case "type": {
        const flag = value.toLowerCase().replace(/s$/, "");
        const mapped: Record<string, ItemKind> = {
          link: "link",
          page: "link",
          article: "link",
          image: "image",
          photo: "image",
          picture: "image",
          screenshot: "image",
          video: "video",
          note: "note",
          post: "note",
          tweet: "note",
          clip: "clip",
        };
        const kind = mapped[flag];
        if (kind && !filters.kinds.includes(kind)) {
          filters.kinds.push(kind);
          chips.push({ label: `${flag}s`, kind: "kinds" });
        }
        break;
      }
      case "color":
      case "colour": {
        // Both a name and a hex are accepted: the palette picker writes `color:#3e63dd`,
        // and a person types `color:blue`.
        const bin = value.startsWith("#")
          ? binForHex(value)
          : (COLOR_WORDS.get(value.toLowerCase()) ?? null);
        if (bin !== null && !filters.colors.includes(bin)) {
          filters.colors.push(bin);
          chips.push({ label: `colour: ${value}`, kind: "colors" });
        }
        break;
      }
      case "source": {
        filters.sourceIds.push(value);
        chips.push({ label: `source: ${value}`, kind: "sourceIds" });
        break;
      }
      case "has": {
        const flag = value.toLowerCase();
        if (flag === "offline" || flag === "copy") {
          filters.offline = true;
          chips.push({ label: "saved offline", kind: "offline" });
        } else if (flag === "media" || flag === "file") {
          filters.media = true;
          chips.push({ label: "has a file", kind: "media" });
        } else if (flag === "note") {
          filters.media = filters.media ?? undefined;
        }
        break;
      }
      case "is": {
        const flag = value.toLowerCase();
        if (["dead", "live", "redirected", "blocked", "unchecked"].includes(flag)) {
          filters.health.push(flag as HealthStatus);
          chips.push({ label: `is: ${flag}`, kind: "health" });
        } else if (flag === "favorite" || flag === "favourite" || flag === "starred") {
          filters.favorite = true;
          chips.push({ label: "favourites", kind: "favorite" });
        } else if (flag === "archived") {
          filters.archived = true;
          chips.push({ label: "archived", kind: "archived" });
        } else if (flag === "untagged") {
          filters.untagged = true;
          chips.push({ label: "untagged", kind: "untagged" });
        } else if (flag === "duplicate" || flag === "duplicates") {
          filters.duplicates = true;
          chips.push({ label: "duplicates", kind: "duplicates" });
        } else if (flag === "unopened" || flag === "unread" || flag === "unvisited") {
          filters.neverVisited = true;
          chips.push({ label: "never opened", kind: "neverVisited" });
        } else if (flag === "lookalike" || flag === "lookalikes" || flag === "similar") {
          filters.lookalikes = true;
          chips.push({ label: "look-alikes", kind: "lookalikes" });
        } else if (flag === "offline") {
          filters.offline = true;
          chips.push({ label: "saved offline", kind: "offline" });
        }
        break;
      }
    }
  }

  // --- plain-English relative dates ---
  const lastNDays = rest.match(/\blast (\d+) days?\b/);
  if (lastNDays) {
    const days = Number.parseInt(lastNDays[1], 10);
    filters.addedAfter = now - days * DAY;
    chips.push({ label: `last ${days} days`, kind: "addedAfter" });
    consume(/\blast \d+ days?\b/);
  }

  const olderThanMonths = rest.match(/\bolder than (\d+) months?\b/);
  if (olderThanMonths) {
    const months = Number.parseInt(olderThanMonths[1], 10);
    filters.addedBefore = now - months * 30 * DAY;
    chips.push({ label: `older than ${months} months`, kind: "addedBefore" });
    consume(/\bolder than \d+ months?\b/);
  }

  const year = rest.match(/\b(?:in|from)\s+(19|20)(\d{2})\b/);
  if (year) {
    const value = Number.parseInt(`${year[1]}${year[2]}`, 10);
    filters.addedAfter = new Date(value, 0, 1).getTime();
    filters.addedBefore = new Date(value + 1, 0, 1).getTime();
    chips.push({ label: `in ${value}`, kind: "addedAfter" });
    consume(/\b(?:in|from)\s+(?:19|20)\d{2}\b/);
  }

  if (filters.addedAfter === undefined && filters.addedBefore === undefined) {
    for (const { pattern, range } of DATE_PHRASES) {
      if (pattern.source.includes("\\d")) continue; // handled above
      const found = rest.match(pattern);
      if (!found) continue;
      const [from, to] = range(now);
      filters.addedAfter = from;
      filters.addedBefore = to;
      chips.push({ label: found[1] ?? found[0].trim(), kind: "addedAfter" });
      consume(pattern);
      break;
    }
  }

  /**
   * Plain-English formats: "videos by fons", "screenshots from last week".
   *
   * Only when the operator form did not already answer it, so `kind:image videos` is not
   * read as asking for both. The word is consumed either way, which is what stops it
   * being ranked as free text afterwards.
   */
  if (!filters.kinds.length) {
    for (const { pattern, kinds, label } of KIND_PHRASES) {
      if (!pattern.test(rest)) continue;
      filters.kinds.push(...kinds);
      chips.push({ label, kind: "kinds" });
      consume(pattern);
      break;
    }
  }

  /**
   * Plain-English colours: "dark blue dashboard", "something orange".
   *
   * Consumed only when the colour index can act on it. A colour word left in the free
   * text would otherwise rank documents that merely *mention* the colour, which is a
   * different and much worse answer to "show me the blue ones".
   */
  for (const [word, bin] of COLOR_WORDS) {
    const pattern = new RegExp(`\\b${word}\\b`);
    if (!pattern.test(rest)) continue;
    if (!filters.colors.includes(bin)) {
      filters.colors.push(bin);
      chips.push({ label: word, kind: "colors" });
    }
    consume(pattern);
    break;
  }

  // --- plain-English status words ---
  for (const { pattern, status } of HEALTH_PHRASES) {
    if (pattern.test(rest)) {
      if (!filters.health.includes(status)) {
        filters.health.push(status);
        chips.push({ label: status === "live" ? "healthy" : status, kind: "health" });
      }
      consume(pattern);
    }
  }
  if (/\buntagged\b/.test(rest)) {
    filters.untagged = true;
    chips.push({ label: "untagged", kind: "untagged" });
    consume(/\buntagged\b/);
  }
  if (/\bduplicates?\b/.test(rest)) {
    filters.duplicates = true;
    chips.push({ label: "duplicates", kind: "duplicates" });
    consume(/\bduplicates?\b/);
  }
  /**
   * "Never opened" and its neighbours.
   *
   * Matched before the filler-word pass below, which strips "saved" and "bookmarks" and
   * would otherwise fragment the phrase before it can be recognised.
   */
  if (/\bnever (opened|visited|read|clicked)\b/.test(rest)) {
    filters.neverVisited = true;
    chips.push({ label: "never opened", kind: "neverVisited" });
    consume(/\bnever (opened|visited|read|clicked)\b/);
  }
  if (/\b(favou?rites?|starred)\b/.test(rest)) {
    filters.favorite = true;
    chips.push({ label: "favourites", kind: "favorite" });
    consume(/\b(favou?rites?|starred)\b/);
  }

  // Conversational filler that would otherwise pollute the ranking.
  consume(/\b(show me|show|find|search for|i saved|saved|bookmarks?|links?|that|which|my|me)\b/g);

  const text = rest.replace(/\s+/g, " ").trim();
  const terms = tokenize(text);
  if (text) chips.push({ label: text, kind: "text" });

  return { text, terms, filters, chips };
}

export function hasActiveFilters(filters: QueryFilters): boolean {
  return (
    filters.tags.length > 0 ||
    filters.folders.length > 0 ||
    filters.categories.length > 0 ||
    filters.domains.length > 0 ||
    filters.health.length > 0 ||
    filters.kinds.length > 0 ||
    filters.colors.length > 0 ||
    filters.sourceIds.length > 0 ||
    filters.offline !== undefined ||
    filters.media !== undefined ||
    filters.lookalikes !== undefined ||
    filters.favorite !== undefined ||
    filters.archived !== undefined ||
    filters.untagged !== undefined ||
    filters.duplicates !== undefined ||
    filters.neverVisited !== undefined ||
    filters.addedAfter !== undefined ||
    filters.addedBefore !== undefined
  );
}
