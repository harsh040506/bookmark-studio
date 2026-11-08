/**
 * Every place bookmarks can come from, and how to recognise a file from each.
 *
 * ## What a "source" is here
 *
 * Not a parser. Chrome, Edge, Brave, Opera, Vivaldi, Arc, DuckDuckGo and Samsung Internet
 * all export the identical Netscape HTML file — one parser serves all eight. What differs
 * is *provenance*: the sidebar should say "Brave · 1,204", the re-import should fold into
 * that same source rather than stacking a ninth, and the hint text should tell you where
 * Brave keeps the export. So a source is a name, a place to find the file, a set of
 * parsers to try, and a detector.
 *
 * ## Detection is a hint, never a gate
 *
 * Every detector returns a confidence, the highest wins, and the user can override it in
 * the import dialog before anything is written. That ordering matters: file-format
 * sniffing is guesswork (a Netscape export from Brave is byte-identical to one from
 * Chrome unless the folder names give it away), and an app that guesses silently and
 * cannot be corrected is worse than one that asks.
 */
import { looksLikeXArchive } from "../xarchive";
import type { DetectInput, SourceDefinition } from "./types";

/** Scores a filename fragment, weighted so an explicit name beats a structural hint. */
function named(input: DetectInput, ...fragments: string[]): number {
  return fragments.some((fragment) => input.lowerName.includes(fragment)) ? 0.9 : 0;
}

function isNetscape(input: DetectInput): boolean {
  return (
    input.head.includes("netscape-bookmark-file") ||
    (input.extension === "html" && /<dt><a\s+href=/i.test(input.rawHead))
  );
}

/* ------------------------------------------------------------------ browsers */

/**
 * The Chromium family.
 *
 * Generated rather than written out eight times: the definitions differ only in name,
 * hint and the words that identify them in a filename, and eight near-identical literals
 * is eight places for a change to be applied seven times.
 */
function chromiumFamily(
  id: string,
  name: string,
  hint: string,
  aliases: string[],
  extras: Partial<SourceDefinition> = {},
): SourceDefinition {
  return {
    id,
    name,
    group: "Browsers",
    kind: "browser",
    hint,
    accept: [".html", ".htm", ".json"],
    parsers: ["netscape", "chromium-json"],
    detect: (input) => {
      const byName = named(input, ...aliases);
      if (byName) return byName;
      return 0;
    },
    ...extras,
  };
}

export const SOURCES: SourceDefinition[] = [
  chromiumFamily(
    "chrome",
    "Chrome",
    "Bookmarks → Bookmark manager → ⋮ → Export bookmarks.",
    ["chrome"],
    {
      /**
       * The fallback for an unidentifiable Netscape file.
       *
       * Chrome is the overwhelmingly most common origin for a file called
       * `bookmarks.html`, and it writes `PERSONAL_TOOLBAR_FOLDER` — which Firefox and
       * Safari do not. Scored below any name match so an explicitly named Brave or Edge
       * export still wins.
       */
      detect: (input) => {
        if (named(input, "chrome")) return 0.95;
        if (!isNetscape(input)) return 0;
        if (input.head.includes("personal_toolbar_folder")) return 0.5;
        return 0.3;
      },
    },
  ),
  chromiumFamily("edge", "Microsoft Edge", "Favourites → ⋯ → Export favourites.", [
    "edge",
    "favorites",
    "favourites",
  ]),
  chromiumFamily("brave", "Brave", "Bookmarks → Bookmark manager → ⋮ → Export.", ["brave"]),
  chromiumFamily("opera", "Opera", "Bookmarks → Export bookmarks (or the Opera GX equivalent).", [
    "opera",
  ]),
  chromiumFamily("vivaldi", "Vivaldi", "File → Export bookmarks.", ["vivaldi"]),
  chromiumFamily("chromium", "Chromium", "Bookmark manager → ⋮ → Export bookmarks.", ["chromium"]),
  chromiumFamily("arc", "Arc", "Archive → Export bookmarks, or drop the Chromium Bookmarks file.", [
    "arc",
  ]),
  chromiumFamily(
    "duckduckgo",
    "DuckDuckGo",
    "Settings → Sync & Backup → Export bookmarks.",
    ["duckduckgo", "ddg"],
  ),
  chromiumFamily(
    "samsung",
    "Samsung Internet",
    "Bookmarks → ⋮ → Export, or sync to Chrome and export there.",
    ["samsung", "sbrowser"],
  ),
  {
    id: "firefox",
    name: "Firefox",
    group: "Browsers",
    kind: "browser",
    hint: "Bookmarks → Manage bookmarks → Import and Backup → Export bookmarks to HTML.",
    accept: [".html", ".htm", ".json"],
    parsers: ["netscape", "firefox-json"],
    detect: (input) => {
      const byName = named(input, "firefox", "places", "moz_");
      if (byName) return byName;
      if (input.rawHead.includes("text/x-moz-place")) return 0.98;
      if (isNetscape(input) && (input.head.includes('tags="') || input.head.includes("bookmarks menu"))) {
        return 0.6;
      }
      return 0;
    },
  },
  {
    id: "safari",
    name: "Safari",
    group: "Browsers",
    kind: "browser",
    hint: "File → Export → Bookmarks, or drop ~/Library/Safari/Bookmarks.plist.",
    accept: [".html", ".htm", ".plist"],
    parsers: ["netscape", "safari-plist"],
    detect: (input) => {
      const byName = named(input, "safari");
      if (byName) return byName;
      if (input.extension === "plist" || input.head.includes("<!doctype plist")) return 0.95;
      // Safari writes no favicons at all, which is the one structural tell it has.
      if (isNetscape(input) && !input.head.includes('icon="')) return 0.35;
      return 0;
    },
  },
  {
    id: "icloud",
    name: "iCloud Bookmarks",
    group: "Browsers",
    kind: "browser",
    hint: "iCloud for Windows, or a Safari export synced through iCloud.",
    accept: [".html", ".htm", ".plist"],
    parsers: ["netscape", "safari-plist"],
    detect: (input) => named(input, "icloud"),
  },

  /* --------------------------------------------------------------- read later */

  {
    id: "pocket",
    name: "Pocket",
    group: "Read later",
    kind: "browser",
    hint: "getpocket.com/export — an HTML file, or the CSV from the 2025 data export.",
    accept: [".html", ".htm", ".csv"],
    parsers: ["netscape", "csv"],
    csv: {
      url: ["url"],
      title: ["title"],
      tags: ["tags"],
      addedAt: ["time_added", "time added", "created_at"],
      archived: ["status"],
    },
    detect: (input) => {
      const byName = named(input, "pocket", "ril_export", "part_000000");
      if (byName) return byName;
      if (input.head.includes("unread") && input.head.includes("read archive")) return 0.8;
      if (input.extension === "csv" && input.head.includes("time_added")) return 0.85;
      return 0;
    },
  },
  {
    id: "instapaper",
    name: "Instapaper",
    group: "Read later",
    kind: "browser",
    hint: "Settings → Export → Download .CSV file.",
    accept: [".csv", ".html", ".htm"],
    parsers: ["csv", "netscape"],
    csv: {
      url: ["url"],
      title: ["title"],
      description: ["selection", "summary"],
      folder: ["folder"],
      addedAt: ["timestamp", "time"],
    },
    detect: (input) => {
      const byName = named(input, "instapaper");
      if (byName) return byName;
      if (input.extension === "csv" && input.head.includes("folder") && input.head.includes("selection")) {
        return 0.85;
      }
      return 0;
    },
  },
  {
    id: "readwise",
    name: "Readwise Reader",
    group: "Read later",
    kind: "browser",
    hint: "Reader → Settings → Export → CSV of all documents.",
    accept: [".csv"],
    parsers: ["csv"],
    csv: {
      url: ["url", "source url", "source_url"],
      title: ["title"],
      description: ["summary", "note"],
      note: ["notes"],
      tags: ["document tags", "tags"],
      folder: ["location", "category"],
      addedAt: ["saved date", "saved_at", "date"],
    },
    detect: (input) => {
      const byName = named(input, "readwise", "reader");
      if (byName) return byName;
      if (input.extension === "csv" && input.head.includes("document tags")) return 0.9;
      return 0;
    },
  },

  /* ------------------------------------------------------------- bookmarking */

  {
    id: "raindrop",
    name: "Raindrop.io",
    group: "Bookmarking",
    kind: "browser",
    hint: "Settings → Backups → Export as CSV or HTML.",
    accept: [".csv", ".html", ".htm", ".json"],
    parsers: ["csv", "netscape", "json"],
    csv: {
      url: ["url", "link"],
      title: ["title"],
      description: ["excerpt", "note", "description"],
      tags: ["tags"],
      folder: ["folder", "collection"],
      addedAt: ["created", "created_at", "lastupdate"],
      favorite: ["favorite"],
      tagSeparator: /[,]/,
    },
    detect: (input) => {
      const byName = named(input, "raindrop");
      if (byName) return byName;
      if (input.extension === "csv" && input.head.includes("excerpt") && input.head.includes("folder")) {
        return 0.85;
      }
      return 0;
    },
  },
  {
    id: "pinboard",
    name: "Pinboard",
    group: "Bookmarking",
    kind: "browser",
    hint: "pinboard.in/export — the JSON format keeps tags and notes.",
    accept: [".json", ".html", ".htm", ".xml"],
    parsers: ["json", "netscape"],
    detect: (input) => {
      const byName = named(input, "pinboard");
      if (byName) return byName;
      // Pinboard's JSON is an array of {href, description, extended, tags, time}.
      if (input.rawHead.includes('"href"') && input.rawHead.includes('"extended"')) return 0.92;
      return 0;
    },
  },
  {
    id: "delicious",
    name: "Delicious",
    group: "Bookmarking",
    kind: "browser",
    hint: "A Delicious HTML export, or any archived del.icio.us backup.",
    accept: [".html", ".htm", ".json"],
    parsers: ["netscape", "json"],
    detect: (input) => named(input, "delicious", "del.icio.us"),
  },
  {
    id: "diigo",
    name: "Diigo",
    group: "Bookmarking",
    kind: "browser",
    hint: "My Library → Export → CSV or bookmarks HTML.",
    accept: [".csv", ".html", ".htm"],
    parsers: ["csv", "netscape"],
    csv: {
      url: ["url"],
      title: ["title"],
      description: ["description"],
      note: ["annotations", "comments"],
      tags: ["tags"],
      addedAt: ["created_at", "created"],
      tagSeparator: /[,\s]+/,
    },
    detect: (input) => {
      const byName = named(input, "diigo");
      if (byName) return byName;
      if (input.extension === "csv" && input.head.includes("annotations")) return 0.85;
      return 0;
    },
  },
  {
    id: "google-bookmarks",
    name: "Google Bookmarks",
    group: "Bookmarking",
    kind: "browser",
    hint: "Google Takeout → Chrome → Bookmarks, or the legacy GoogleBookmarks.html.",
    accept: [".html", ".htm"],
    parsers: ["netscape"],
    detect: (input) => named(input, "googlebookmarks", "google-bookmarks", "takeout"),
  },
  {
    id: "x",
    name: "X (Twitter)",
    group: "Bookmarking",
    kind: "x",
    hint: "Settings → Your account → Download an archive; drop bookmark.js or tweets.js.",
    accept: [".js", ".json"],
    parsers: ["x-archive"],
    // Deferred to the archive reader's own sniffer, so the format is recognised in exactly
    // one place and a new archive vintage is taught to the app once.
    detect: (input) => (looksLikeXArchive(input.fileName, input.rawHead) ? 0.96 : 0),
  },

  /* ---------------------------------------------------------- notes & archives */

  {
    id: "notion",
    name: "Notion",
    group: "Notes & archives",
    kind: "browser",
    hint: "Export a database as CSV; the URL column is picked up automatically.",
    accept: [".csv", ".html", ".htm"],
    parsers: ["csv", "netscape"],
    csv: {
      url: ["url", "link", "web link", "website"],
      title: ["name", "title"],
      description: ["description", "summary"],
      tags: ["tags", "type", "category"],
      addedAt: ["created time", "created", "date"],
    },
    detect: (input) => {
      const byName = named(input, "notion");
      if (byName) return byName;
      if (input.extension === "csv" && input.head.includes("created time")) return 0.8;
      return 0;
    },
  },
  {
    id: "evernote",
    name: "Evernote",
    group: "Notes & archives",
    kind: "browser",
    hint: "Select notes → Export → ENEX. Each note's source URL becomes a bookmark.",
    accept: [".enex", ".xml"],
    parsers: ["enex"],
    detect: (input) => {
      if (input.extension === "enex") return 0.98;
      if (input.head.includes("<en-export")) return 0.95;
      return named(input, "evernote");
    },
  },

  /* --------------------------------------------------------------------- files */

  {
    id: "html",
    name: "Bookmarks HTML",
    group: "Files",
    kind: "browser",
    hint: "Any Netscape bookmark file — the format every browser exports.",
    accept: [".html", ".htm"],
    parsers: ["netscape"],
    detect: (input) => (isNetscape(input) ? 0.25 : 0),
  },
  {
    id: "csv",
    name: "CSV",
    group: "Files",
    kind: "browser",
    hint: "Any CSV with a URL column. Columns are matched by name, and can be remapped.",
    accept: [".csv", ".tsv"],
    parsers: ["csv"],
    detect: (input) => (input.extension === "csv" || input.extension === "tsv" ? 0.3 : 0),
  },
  {
    id: "json",
    name: "JSON",
    group: "Files",
    kind: "browser",
    hint: "An array of objects, or an object with a bookmarks/items/links array.",
    accept: [".json"],
    parsers: ["json", "chromium-json", "firefox-json"],
    detect: (input) => (input.extension === "json" ? 0.25 : 0),
  },
  {
    id: "text",
    name: "URL list",
    group: "Files",
    kind: "manual",
    hint: "A plain text file with one URL per line.",
    accept: [".txt", ".md", ".text"],
    parsers: ["text-urls"],
    detect: (input) =>
      input.extension === "txt" || input.extension === "md" || input.extension === "text" ? 0.6 : 0,
  },
  {
    id: "backup",
    name: "Studio backup",
    group: "Files",
    kind: "manual",
    hint: "A JSON backup written by this app. Restores ids, boards, notes and history.",
    accept: [".json"],
    parsers: ["backup"],
    detect: (input) => {
      if (input.extension !== "json") return 0;
      // The backup writes `exportedAt` beside a `bookmarks` array; nothing else does.
      return input.rawHead.includes('"exportedAt"') && input.rawHead.includes('"bookmarks"') ? 0.99 : 0;
    },
  },
];

export const SOURCE_BY_ID = new Map(SOURCES.map((source) => [source.id, source]));

/** Grouped for the picker, in the order the groups should appear. */
export const SOURCE_GROUPS: SourceDefinition["group"][] = [
  "Browsers",
  "Read later",
  "Bookmarking",
  "Notes & archives",
  "Files",
];

/** Every extension any source accepts, for the file input's `accept`. */
export const ACCEPTED_EXTENSIONS = [
  ...new Set(SOURCES.flatMap((source) => source.accept)),
].sort();

/**
 * How much of a file is enough to recognise it.
 *
 * 64 KB reaches past the header of every format here — a Netscape file's DOCTYPE and
 * first folder, a CSV's header row, a plist's DOCTYPE, an ENEX's `<en-export>` — while
 * never reading a 400 MB archive into a string to answer a question about its first line.
 */
export const HEAD_BYTES = 64 * 1024;

export async function readHead(file: File): Promise<string> {
  const slice = file.slice(0, HEAD_BYTES);
  return slice.text();
}

export function detectInput(fileName: string, rawHead: string, size: number): DetectInput {
  const lowerName = fileName.toLowerCase();
  const extension = lowerName.includes(".") ? lowerName.split(".").pop()! : "";
  return { fileName, lowerName, extension, head: rawHead.toLowerCase(), rawHead, size };
}

export interface Detection {
  source: SourceDefinition;
  confidence: number;
}

/**
 * Ranks every source against a file, best first.
 *
 * Returns all of them rather than the winner, because the import dialog shows the runners
 * up: "we think this is Brave; it could be Chrome or Edge" is a far more useful thing to
 * put in front of somebody than a single silent guess.
 */
export function detectSources(input: DetectInput): Detection[] {
  return SOURCES.map((source) => ({ source, confidence: source.detect?.(input) ?? 0 }))
    .filter((entry) => entry.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
}

/** The single best guess, falling back to a format-appropriate generic source. */
export function bestSource(input: DetectInput): SourceDefinition {
  const ranked = detectSources(input);
  if (ranked.length) return ranked[0].source;
  if (input.extension === "csv" || input.extension === "tsv") return SOURCE_BY_ID.get("csv")!;
  if (input.extension === "json") return SOURCE_BY_ID.get("json")!;
  if (input.extension === "txt" || input.extension === "md") return SOURCE_BY_ID.get("text")!;
  return SOURCE_BY_ID.get("html")!;
}
