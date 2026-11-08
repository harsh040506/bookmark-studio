/**
 * The structured formats: Chromium JSON, Firefox places JSON, Safari plists, Evernote
 * ENEX, generic JSON, and a plain list of URLs.
 *
 * Each is a tree or a table with its own vocabulary for the same six facts, and each is
 * reduced here to {@link RawItem} and nothing else. No file in this directory is allowed
 * to know what a `Bookmark` is.
 *
 * ## These read untrusted input
 *
 * A bookmarks file is shared, and a shared file decides which addresses enter a library
 * this app will later render as clickable. `isUsableUrl` is the boundary and it is applied
 * on the way *in*, in every parser, rather than at any point of use — so a `javascript:`
 * URL never exists in the database, in an export, or in a code path someone adds later
 * without knowing to guard it.
 */
import { sanitizeText } from "../../embeds";
import type { ParsedFile, RawItem } from "../types";
import { parseFlexibleDate } from "./csv";

export function isUsableUrl(url: unknown): url is string {
  return typeof url === "string" && /^(https?|ftp):\/\//i.test(url.trim());
}

/**
 * Strips control characters and collapses runs of whitespace.
 *
 * Titles from an export routinely carry zero-width and bidirectional-override characters,
 * which make two different titles render identically in a list — and, in the case of the
 * override characters, let a title lie about the file extension or domain it names.
 */
export function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return sanitizeText(value.replace(/\s+/g, " "));
}

/** Caps a list so one hostile record cannot write thousands of tags onto a row. */
function cleanTags(input: unknown): string[] | undefined {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[,;]/)
      : null;
  if (!raw) return undefined;
  const tags = raw
    .map((tag) => cleanText(tag).toLowerCase())
    .filter(Boolean)
    .slice(0, 24);
  return tags.length ? tags : undefined;
}

/* ---------------------------------------------------------- Chromium JSON */

interface ChromiumNode {
  type?: string;
  name?: string;
  url?: string;
  date_added?: string;
  date_modified?: string;
  children?: ChromiumNode[];
}

/**
 * The `Bookmarks` file Chrome, Edge, Brave, Vivaldi, Opera and Arc keep on disk.
 *
 * Worth supporting beside the HTML export because it is the file people actually find:
 * it sits in the profile directory, it needs no menu to produce, and it is what someone
 * recovering from a dead machine has. Timestamps are microseconds since 1601.
 */
export function parseChromiumJson(text: string): ParsedFile {
  let document: { roots?: Record<string, ChromiumNode> };
  try {
    document = JSON.parse(text);
  } catch {
    return { items: [], skipped: 0, warnings: ["The file is not valid JSON."] };
  }
  if (!document?.roots || typeof document.roots !== "object") {
    return { items: [], skipped: 0, warnings: ["No Chromium bookmark roots were found."] };
  }

  const items: RawItem[] = [];
  let skipped = 0;
  let order = 0;

  const ROOT_NAMES: Record<string, string> = {
    bookmark_bar: "Bookmarks bar",
    other: "Other bookmarks",
    synced: "Mobile bookmarks",
  };

  const walk = (node: ChromiumNode, path: string[]) => {
    if (node.type === "folder" || Array.isArray(node.children)) {
      const name = cleanText(node.name);
      const nested = name ? [...path, name] : path;
      for (const child of node.children ?? []) walk(child, nested);
      return;
    }
    if (!isUsableUrl(node.url)) {
      if (node.url) skipped += 1;
      return;
    }
    items.push({
      url: node.url.trim(),
      title: cleanText(node.name) || undefined,
      folderPath: path.length ? path : undefined,
      addedAt: parseFlexibleDate(node.date_added),
      lastModifiedAt: parseFlexibleDate(node.date_modified),
      order: order++,
    });
  };

  for (const [key, root] of Object.entries(document.roots)) {
    if (!root || typeof root !== "object") continue;
    const label = ROOT_NAMES[key] ?? cleanText(root.name) ?? key;
    walk({ ...root, name: label, type: "folder" }, []);
  }

  return {
    items,
    skipped,
    warnings: items.length ? [] : ["The Chromium roots contained no bookmarks."],
  };
}

/* ----------------------------------------------------------- Firefox JSON */

interface MozNode {
  type?: string;
  typeCode?: number;
  title?: string;
  uri?: string;
  dateAdded?: number;
  lastModified?: number;
  tags?: string;
  children?: MozNode[];
}

/**
 * A Firefox "places" backup, in its uncompressed JSON form.
 *
 * Firefox's automatic backups are `.jsonlz4` — Mozilla's own LZ4 framing, which is not
 * the standard one and would need a decompressor shipped to the browser to read. The
 * manual "Backup…" command writes plain JSON, and that is what this reads; the import
 * dialog says so rather than letting a `.jsonlz4` fail with a parse error.
 *
 * Timestamps here are microseconds since the Unix epoch, not since 1601.
 */
export function parseFirefoxJson(text: string): ParsedFile {
  let root: MozNode;
  try {
    root = JSON.parse(text);
  } catch {
    return { items: [], skipped: 0, warnings: ["The file is not valid JSON."] };
  }

  const items: RawItem[] = [];
  let skipped = 0;
  let order = 0;

  const microsToMs = (value: number | undefined) =>
    typeof value === "number" && value > 1e14 ? Math.round(value / 1000) : value;

  const walk = (node: MozNode, path: string[]) => {
    const isContainer =
      node.type === "text/x-moz-place-container" || Array.isArray(node.children);
    if (isContainer) {
      const name = cleanText(node.title);
      const nested = name ? [...path, name] : path;
      for (const child of node.children ?? []) walk(child, nested);
      return;
    }
    if (!isUsableUrl(node.uri)) {
      if (node.uri) skipped += 1;
      return;
    }
    items.push({
      url: node.uri.trim(),
      title: cleanText(node.title) || undefined,
      folderPath: path.length ? path : undefined,
      addedAt: parseFlexibleDate(String(microsToMs(node.dateAdded) ?? "")),
      lastModifiedAt: parseFlexibleDate(String(microsToMs(node.lastModified) ?? "")),
      tags: cleanTags(node.tags),
      order: order++,
    });
  };

  walk(root, []);
  return {
    items,
    skipped,
    warnings: items.length ? [] : ["No places entries were found. A .jsonlz4 backup must be exported as JSON first."],
  };
}

/* --------------------------------------------------------- Safari plist -- */

/**
 * Safari's `Bookmarks.plist`, in its XML form.
 *
 * Read with a scanner rather than DOMParser for the same reason the Netscape parser is:
 * this has to run identically in the browser and in Node for the tests, and an XML plist
 * is regular enough that a stack machine over `<dict>`/`<key>` is both shorter and more
 * predictable than walking a DOM that two engines build differently.
 *
 * A binary plist (the format Safari actually writes on disk since Big Sur) is not XML and
 * is rejected with a message saying so, rather than parsed into nothing.
 */
export function parseSafariPlist(text: string): ParsedFile {
  if (!text.includes("<plist")) {
    return {
      items: [],
      skipped: 0,
      warnings: [
        "This is not an XML property list. Convert a binary plist first (plutil -convert xml1), or export bookmarks as HTML.",
      ],
    };
  }

  const items: RawItem[] = [];
  let skipped = 0;
  let order = 0;

  /*
   * The scan, as a stack of dictionary frames.
   *
   * Safari nests `WebBookmarkTypeList` dicts (folders, whose `Title` names them and whose
   * `Children` array holds the contents) and `WebBookmarkTypeLeaf` dicts (bookmarks, whose
   * `URLString` is the address). The frame stack is load-bearing rather than tidy: a leaf's
   * *title* lives one level deeper, inside a `URIDictionary` sub-dict written **after** the
   * `URLString`. A single pair of "current url / current title" variables is therefore
   * wrong twice over — the nested dict's opening tag clears the URL that was just read, and
   * its closing tag emits a bookmark that has none. Each `</dict>` pops its own frame, and a
   * title found in a child bubbles up to a parent that has not got one.
   */
  const token =
    /<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>|<key>Children<\/key>\s*<array>|<\/array>|<dict>|<\/dict>/g;

  interface Frame {
    url?: string;
    title?: string;
  }
  const stack: Frame[] = [];
  const path: string[] = [];

  const decode = (value: string) =>
    cleanText(
      value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&"),
    );

  let match: RegExpExecArray | null;
  while ((match = token.exec(text))) {
    const raw = match[0];

    if (raw.startsWith("<key>Children")) {
      // The enclosing dict's `Title` is this folder's name; an unnamed root contributes
      // nothing to the path rather than an empty segment.
      path.push(stack[stack.length - 1]?.title ?? "");
      continue;
    }
    if (raw === "</array>") {
      if (path.length) path.pop();
      continue;
    }
    if (raw === "<dict>") {
      stack.push({});
      continue;
    }
    if (raw === "</dict>") {
      const frame = stack.pop();
      if (!frame) continue;
      if (frame.url) {
        if (isUsableUrl(frame.url)) {
          const folderPath = path.filter(Boolean);
          items.push({
            url: frame.url.trim(),
            title: frame.title || undefined,
            folderPath: folderPath.length ? folderPath : undefined,
            order: order++,
          });
        } else {
          skipped += 1;
        }
        continue;
      }
      // A `URIDictionary` carries only the title; hand it to the leaf that contains it.
      const parent = stack[stack.length - 1];
      if (parent && frame.title && !parent.title) parent.title = frame.title;
      continue;
    }

    const frame = stack[stack.length - 1];
    if (!frame) continue;
    const key = match[1];
    const value = decode(match[2] ?? "");
    if (key === "URLString") frame.url = value;
    else if (key === "title" || key === "Title") frame.title = frame.title || value;
  }

  return {
    items,
    skipped,
    warnings: items.length ? [] : ["No bookmarks were found in the property list."],
  };
}

/* ------------------------------------------------------------------ ENEX */

/**
 * Evernote's export format.
 *
 * A note becomes a bookmark when it has a `source-url`, and a note without one becomes a
 * `note` item carrying its own text — which is the honest reading: an Evernote export is
 * a mix of clipped pages and written notes, and discarding the second half because it has
 * no address would lose most of what a long-time Evernote library actually contains.
 */
export function parseEnex(text: string): ParsedFile {
  const items: RawItem[] = [];
  let skipped = 0;
  let order = 0;

  const notes = text.match(/<note>[\s\S]*?<\/note>/g) ?? [];
  const field = (block: string, name: string): string => {
    const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
    return match ? cleanText(stripXml(match[1])) : "";
  };

  for (const block of notes) {
    const url = field(block, "source-url");
    const title = field(block, "title");
    const created = field(block, "created");
    const tags = (block.match(/<tag>([\s\S]*?)<\/tag>/g) ?? []).map((tag) =>
      cleanText(stripXml(tag.replace(/<\/?tag>/g, ""))),
    );

    // ENML wraps the body in CDATA; the text inside is the note as the user wrote it.
    const contentMatch = block.match(/<content>([\s\S]*?)<\/content>/i);
    const body = contentMatch ? cleanText(stripXml(contentMatch[1])).slice(0, 4000) : "";

    if (isUsableUrl(url)) {
      items.push({
        url: url.trim(),
        title: title || undefined,
        description: body.slice(0, 400) || undefined,
        tags: cleanTags(tags),
        addedAt: parseFlexibleDate(created),
        order: order++,
      });
      continue;
    }

    if (title || body) {
      items.push({
        url: "",
        kind: "note",
        title: title || "Untitled note",
        text: body || undefined,
        tags: cleanTags(tags),
        addedAt: parseFlexibleDate(created),
        order: order++,
      });
      continue;
    }
    skipped += 1;
  }

  return {
    items,
    skipped,
    warnings: items.length ? [] : ["No notes were found in the ENEX file."],
  };
}

function stripXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/* ---------------------------------------------------------- generic JSON */

const URL_KEYS = ["url", "link", "href", "uri", "address", "source_url", "sourceUrl", "web_url"];
const TITLE_KEYS = ["title", "name", "description_title", "pageTitle", "heading"];
const DESCRIPTION_KEYS = ["description", "excerpt", "extended", "summary", "note", "snippet"];
const TAG_KEYS = ["tags", "tag", "labels", "keywords", "categories"];
const FOLDER_KEYS = ["folder", "collection", "path", "category", "group", "location"];
const DATE_KEYS = ["created", "createdAt", "created_at", "time", "date", "addedAt", "added", "lastUpdate", "saved_at"];

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

/**
 * Any JSON that contains bookmark-shaped objects.
 *
 * Covers Pinboard (`[{href, description, extended, tags, time}]`), Raindrop
 * (`{items:[{link, title, excerpt, tags, created}]}`), and the long tail of one-off
 * exports — including nested structures, which are searched to a bounded depth rather
 * than requiring the array to be at the top level.
 *
 * Pinboard is the awkward one: it calls the *title* `description` and the *description*
 * `extended`. Detected structurally rather than by asking the user, because the pair of
 * keys is unambiguous.
 */
export function parseGenericJson(text: string): ParsedFile {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { items: [], skipped: 0, warnings: ["The file is not valid JSON."] };
  }

  const array = findRecordArray(document, 0);
  if (!array) {
    return { items: [], skipped: 0, warnings: ["No array of bookmark-like objects was found."] };
  }

  const isPinboard =
    array.length > 0 &&
    typeof array[0] === "object" &&
    array[0] !== null &&
    "href" in (array[0] as object) &&
    "extended" in (array[0] as object);

  const items: RawItem[] = [];
  let skipped = 0;
  let order = 0;

  for (const entry of array) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const url = pick(record, URL_KEYS);
    if (!isUsableUrl(url)) {
      skipped += 1;
      continue;
    }

    const title = isPinboard ? record.description : pick(record, TITLE_KEYS);
    const description = isPinboard ? record.extended : pick(record, DESCRIPTION_KEYS);
    const folder = pick(record, FOLDER_KEYS);

    items.push({
      url: url.trim(),
      title: cleanText(title) || undefined,
      description: cleanText(description) || undefined,
      tags: cleanTags(pick(record, TAG_KEYS)),
      folderPath:
        typeof folder === "string" && folder.trim()
          ? folder.split("/").map((part) => cleanText(part)).filter(Boolean)
          : undefined,
      addedAt: parseFlexibleDate(
        typeof pick(record, DATE_KEYS) === "number"
          ? String(pick(record, DATE_KEYS))
          : (pick(record, DATE_KEYS) as string | undefined),
      ),
      favorite: record.favorite === true || record.starred === true,
      // Pinboard's `toread` is "unread", which is the opposite of archived — a bookmark
      // marked to read is emphatically not one filed away.
      archived: record.archived === true || record.archive === true,
      order: order++,
    });
  }

  return {
    items,
    skipped,
    warnings: items.length ? [] : ["No entries carried a usable http(s) address."],
  };
}

/**
 * Finds the array of records inside an unknown JSON document.
 *
 * Depth-limited, because the input is untrusted and a deeply nested structure would
 * otherwise be a stack-overflow waiting to happen. Prefers the largest candidate array, so
 * a file with both a two-entry `collections` array and a nine-thousand-entry `items` array
 * imports the bookmarks rather than the collections.
 */
function findRecordArray(value: unknown, depth: number): unknown[] | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    const hasRecords = value.some(
      (entry) => entry && typeof entry === "object" && isUsableUrl(pick(entry as Record<string, unknown>, URL_KEYS)),
    );
    return hasRecords ? value : null;
  }

  let best: unknown[] | null = null;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = findRecordArray(nested, depth + 1);
    if (found && (!best || found.length > best.length)) best = found;
  }
  return best;
}

/* -------------------------------------------------------------- URL list */

/** One address per line, with anything after it on the line taken as the title. */
export function parseUrlList(text: string): ParsedFile {
  const items: RawItem[] = [];
  let skipped = 0;
  let order = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Markdown links are the common case in a notes file, and losing the label they
    // carry would throw away the only title the file has.
    const markdown = trimmed.match(/^\s*[-*]?\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/i);
    if (markdown) {
      items.push({ url: markdown[2], title: cleanText(markdown[1]) || undefined, order: order++ });
      continue;
    }

    const match = trimmed.match(/^(https?:\/\/\S+)(?:\s+[-–—|]?\s*(.*))?$/i);
    if (!match) {
      if (/^\w+:\/\//.test(trimmed)) skipped += 1;
      continue;
    }
    items.push({ url: match[1], title: cleanText(match[2]) || undefined, order: order++ });
  }

  return { items, skipped, warnings: items.length ? [] : ["No http(s) addresses were found."] };
}
