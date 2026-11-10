/**
 * Netscape bookmark-file parser and serializer.
 *
 * This is the format every browser exports: Chrome, Edge, Firefox, Safari, Brave, Arc.
 * It is *not* valid HTML — tags are left unclosed by design (`<DT>`, `<p>`), nesting is
 * implicit, and Chrome inlines every favicon as a base64 `ICON` attribute. Handing it to
 * DOMParser gives inconsistent trees across browsers, so this is a hand-rolled scanner:
 * deterministic, dependency-free, and runs in both the browser and Node (for tests).
 *
 * Verified against real exports:
 *   - 1216 bookmarks / 47 folders / 908 embedded base64 icons / depth 5
 *   - HTML entities in titles (&amp;, &#39;), titles up to 389 chars, duplicate URLs
 *
 * ## This file reads untrusted input
 *
 * Bookmark exports get shared, and a file from someone else is hostile input in the
 * ordinary sense: it decides what URLs and what text enter a library the app will later
 * render and re-export. Two guards are load-bearing and are enforced *here*, on the way
 * in, rather than at any point of use — `isUsableUrl` for schemes, and `sanitizeText` for
 * the text. Both are covered by regression tests, because the failure they prevent is
 * silent right up until it is not.
 */
import { sanitizeText } from "./embeds";

export interface ParsedFolder {
  id: string;
  name: string;
  parentId: string | null;
  addedAt: number;
  lastModifiedAt?: number;
  toolbar?: boolean;
  /** Document position, counted across the whole file in reading order. */
  order: number;
}

export interface ParsedBookmark {
  url: string;
  title: string;
  description: string;
  icon?: string;
  addedAt: number;
  lastModifiedAt?: number;
  folderId: string | null;
  /** Firefox writes a TAGS="a,b" attribute; Chrome does not. */
  tags: string[];
  /**
   * Document position, counted across the whole file in reading order.
   *
   * This is the user's own arrangement — the sequence they built by hand in a browser
   * sidebar — and it is the only ordering in the file that no timestamp can reconstruct.
   */
  order: number;
}

export interface ParseResult {
  folders: ParsedFolder[];
  bookmarks: ParsedBookmark[];
  /** Entries skipped because the href was unusable (javascript:, place:, empty). */
  skipped: number;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        return match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] as string,
  );
}

/** Pulls attributes out of a raw tag body, upper-casing names for stable lookup. */
function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern =
    /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    attributes[match[1].toUpperCase()] = decodeEntities(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return attributes;
}

/**
 * The earliest date a bookmark could plausibly carry.
 *
 * Not the epoch: a "bookmark saved in 1970" is always a corrupt or misread value, and
 * treating it as real puts it permanently at the top of "Oldest first".
 */
const EARLIEST_PLAUSIBLE = Date.UTC(1990, 0, 1);

/**
 * Browsers disagree on the epoch unit: Chrome/Firefox export seconds, but some tools
 * emit milliseconds, and Chrome's internal format is microseconds since 1601.
 *
 * The unit heuristic below is a guess, and the last step exists because a guess can be
 * wrong. An eleven-digit "seconds" value — which real exports do contain, from tools that
 * pad or mangle the field — multiplies out to the year 2518, and a single bookmark dated
 * five centuries from now sits at the top of "Newest first" forever while its owner has no
 * idea why. So the *result* is sanity-checked, not just the input: anything outside the
 * span in which bookmarking has actually existed falls back to the import time, which is
 * both honest and harmless.
 */
function parseTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;

  // Chromium "WebKit" epoch: microseconds since 1601-01-01.
  const milliseconds =
    numeric > 1e16
      ? Math.round(numeric / 1000 - 11644473600000)
      : numeric > 1e14
        ? Math.round(numeric / 1000)
        : numeric > 1e11
          ? numeric // already milliseconds
          : numeric * 1000; // seconds

  // A day of slack for clock skew between the machine that exported and this one.
  const latestPlausible = Date.now() + 86_400_000;
  if (milliseconds < EARLIEST_PLAUSIBLE || milliseconds > latestPlausible) return fallback;
  return milliseconds;
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Whether an imported address may enter the library.
 *
 * The scheme allow-list is the security boundary, not a tidiness rule. A bookmarks file is
 * untrusted input — people share them, and browsers happily store `javascript:` URLs as
 * "bookmarklets" — so a link scheme that executes must never reach a row the app will later
 * render as something clickable. Rejecting here rather than at render time is deliberate:
 * the dangerous value then never exists in the database, in an export, or in a code path
 * somebody adds next year without knowing to guard it.
 *
 * `data:` is excluded for the same reason: `data:text/html` is a stored page that would run
 * on this app's own origin.
 */
function isUsableUrl(url: string): boolean {
  if (!url) return false;
  return /^(https?|ftp):\/\//i.test(url);
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * Parses a bookmark export into a flat folder list plus bookmarks that reference them.
 *
 * The scanner walks tokens in document order and keeps a stack of folder ids. A `<H3>`
 * announces a folder whose contents are the `<DL>` that follows it, so the folder is held
 * as "pending" until that `<DL>` opens.
 */
export function parseNetscapeBookmarks(html: string): ParseResult {
  const folders: ParsedFolder[] = [];
  const bookmarks: ParsedBookmark[] = [];
  const stack: (string | null)[] = [];
  let pendingFolderId: string | null = null;
  let skipped = 0;
  const now = Date.now();
  /** Monotonic across folders and bookmarks alike, so one comparison orders the file. */
  let order = 0;

  const currentParent = (): string | null =>
    stack.length ? stack[stack.length - 1] : null;

  const token =
    /<DL[^>]*>|<\/DL\s*>|<H3([^>]*)>([\s\S]*?)<\/H3\s*>|<A([^>]*)>([\s\S]*?)<\/A\s*>|<DD>([\s\S]*?)(?=<DT|<DL|<\/DL|$)/gi;

  let match: RegExpExecArray | null;
  while ((match = token.exec(html))) {
    const raw = match[0];
    const lower = raw.slice(0, 4).toLowerCase();

    if (lower.startsWith("<dl")) {
      // A folder's contents open here; otherwise this is the document root.
      stack.push(pendingFolderId ?? currentParent());
      pendingFolderId = null;
      continue;
    }

    if (lower.startsWith("</dl")) {
      stack.pop();
      pendingFolderId = null;
      continue;
    }

    if (match[1] !== undefined) {
      // <H3> — a folder heading.
      const attributes = parseAttributes(match[1]);
      const folder: ParsedFolder = {
        id: nextId("fld"),
        name: sanitizeText(stripTags(match[2])) || "Untitled folder",
        parentId: currentParent(),
        addedAt: parseTimestamp(attributes.ADD_DATE, now),
        lastModifiedAt: attributes.LAST_MODIFIED
          ? parseTimestamp(attributes.LAST_MODIFIED, now)
          : undefined,
        toolbar: attributes.PERSONAL_TOOLBAR_FOLDER?.toLowerCase() === "true",
        order: order++,
      };
      folders.push(folder);
      pendingFolderId = folder.id;
      continue;
    }

    if (match[3] !== undefined) {
      // <A> — a bookmark.
      pendingFolderId = null;
      const attributes = parseAttributes(match[3]);
      const url = attributes.HREF?.trim() ?? "";
      if (!isUsableUrl(url)) {
        skipped += 1;
        continue;
      }
      // `stripTags` removes the markup; `sanitizeText` removes what markup removal leaves
      // behind — inline event attributes inside a malformed tag, and the control
      // characters that make two different titles render identically in a list.
      const title = sanitizeText(stripTags(match[4]));
      bookmarks.push({
        url,
        title: title || url,
        description: "",
        icon: attributes.ICON || attributes.ICON_URI || undefined,
        addedAt: parseTimestamp(attributes.ADD_DATE, now),
        lastModifiedAt: attributes.LAST_MODIFIED
          ? parseTimestamp(attributes.LAST_MODIFIED, now)
          : undefined,
        folderId: currentParent(),
        tags: (attributes.TAGS || "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        order: order++,
      });
      continue;
    }

    if (match[5] !== undefined) {
      // <DD> — description belonging to the bookmark just above it.
      const last = bookmarks[bookmarks.length - 1];
      if (last && !last.description) last.description = sanitizeText(stripTags(match[5]));
    }
  }

  return { folders, bookmarks, skipped };
}

export interface SerializeInput {
  folders: {
    id: string;
    name: string;
    parentId: string | null;
    addedAt: number;
    lastModifiedAt?: number;
    toolbar?: boolean;
    sourceOrder?: number;
  }[];
  bookmarks: {
    url: string;
    title: string;
    description?: string;
    icon?: string;
    addedAt: number;
    lastModifiedAt?: number;
    folderId: string | null;
    tags?: string[];
    sourceOrder?: number;
  }[];
}

/**
 * Orders siblings the way the user arranged them.
 *
 * An export that re-alphabetises somebody's bookmarks bar is a lossy export: the order
 * was information. Entries carrying no ordinal (added by hand in this app) sort after
 * the imported ones rather than being interleaved at position zero.
 */
function bySourceOrder<T extends { sourceOrder?: number }>(a: T, b: T): number {
  const left = a.sourceOrder ?? Number.MAX_SAFE_INTEGER;
  const right = b.sourceOrder ?? Number.MAX_SAFE_INTEGER;
  return left - right;
}

/**
 * Writes a Netscape file that Chrome, Firefox and Safari all re-import cleanly,
 * preserving the folder tree, timestamps and embedded favicons.
 */
export function serializeNetscapeBookmarks(input: SerializeInput): string {
  type FolderRow = SerializeInput["folders"][number];
  type BookmarkRow = SerializeInput["bookmarks"][number];

  /*
    Where each folder is written. The file is written from the top down, so anything that
    cannot be reached from the top would be left out without a word: a folder whose parent
    is not in this export, folders that name each other as parent, and every bookmark filed
    in them. An export is somebody's backup, so those are written at the top level instead.
  */
  const byId = new Map(input.folders.map((folder) => [folder.id, folder]));
  const parentOf = new Map<string, string | null>();
  for (const folder of byId.values()) {
    const parentId = folder.parentId;
    parentOf.set(folder.id, parentId && parentId !== folder.id && byId.has(parentId) ? parentId : null);
  }
  const settled = new Set<string>();
  for (const start of byId.keys()) {
    if (settled.has(start)) continue;
    const chain: string[] = [];
    const onChain = new Set<string>();
    let cursor: string | null = start;
    while (cursor && !settled.has(cursor)) {
      if (onChain.has(cursor)) {
        parentOf.set(chain[chain.length - 1], null);
        break;
      }
      chain.push(cursor);
      onChain.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    for (const id of chain) settled.add(id);
  }

  const childFolders = new Map<string | null, FolderRow[]>();
  for (const folder of byId.values()) {
    const parentId = parentOf.get(folder.id) ?? null;
    const list = childFolders.get(parentId) ?? [];
    list.push(folder);
    childFolders.set(parentId, list);
  }

  const childBookmarks = new Map<string | null, BookmarkRow[]>();
  for (const bookmark of input.bookmarks) {
    const folderId = bookmark.folderId && byId.has(bookmark.folderId) ? bookmark.folderId : null;
    const list = childBookmarks.get(folderId) ?? [];
    list.push(bookmark);
    childBookmarks.set(folderId, list);
  }

  for (const list of childFolders.values()) list.sort(bySourceOrder);
  for (const list of childBookmarks.values()) list.sort(bySourceOrder);

  const seconds = (ms: number) => Math.floor((Number.isFinite(ms) ? ms : 0) / 1000).toString();
  const lines: string[] = [];
  // Indentation is for people reading the file; past this depth it only makes it bigger.
  const pad = (depth: number) => "    ".repeat(Math.min(depth, 32));

  const writeBookmarks = (parentId: string | null, depth: number) => {
    const indent = pad(depth);
    for (const bookmark of childBookmarks.get(parentId) ?? []) {
      const attributes = [
        `HREF="${escapeHtml(bookmark.url)}"`,
        `ADD_DATE="${seconds(bookmark.addedAt)}"`,
      ];
      if (bookmark.lastModifiedAt) {
        attributes.push(`LAST_MODIFIED="${seconds(bookmark.lastModifiedAt)}"`);
      }
      if (bookmark.tags?.length) {
        attributes.push(`TAGS="${escapeHtml(bookmark.tags.join(","))}"`);
      }
      if (bookmark.icon) attributes.push(`ICON="${escapeHtml(bookmark.icon)}"`);
      lines.push(
        `${indent}<DT><A ${attributes.join(" ")}>${escapeHtml(bookmark.title)}</A>`,
      );
      if (bookmark.description) {
        lines.push(`${indent}<DD>${escapeHtml(bookmark.description)}`);
      }
    }
  };

  /*
    A list of steps instead of a function that calls itself, so a very deep tree cannot run
    out of stack half-way through writing someone's backup. Steps are taken from the end, so
    each level queues its own bookmarks first and its folders, in reverse, after.
  */
  type Step =
    | { kind: "level"; parentId: string | null; depth: number }
    | { kind: "open"; folder: FolderRow; depth: number }
    | { kind: "close"; depth: number }
    | { kind: "bookmarks"; parentId: string | null; depth: number };

  lines.push("<!DOCTYPE NETSCAPE-Bookmark-file-1>");
  lines.push("<!-- This is an automatically generated file.");
  lines.push("     It will be read and overwritten.");
  lines.push("     DO NOT EDIT! -->");
  lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
  lines.push("<TITLE>Bookmarks</TITLE>");
  lines.push("<H1>Bookmarks</H1>");
  lines.push("<DL><p>");

  const steps: Step[] = [{ kind: "level", parentId: null, depth: 1 }];
  while (steps.length) {
    const step = steps.pop() as Step;
    if (step.kind === "level") {
      steps.push({ kind: "bookmarks", parentId: step.parentId, depth: step.depth });
      const subfolders = childFolders.get(step.parentId) ?? [];
      for (let position = subfolders.length - 1; position >= 0; position -= 1) {
        const folder = subfolders[position];
        steps.push({ kind: "close", depth: step.depth });
        steps.push({ kind: "level", parentId: folder.id, depth: step.depth + 1 });
        steps.push({ kind: "open", folder, depth: step.depth });
      }
    } else if (step.kind === "open") {
      const { folder } = step;
      const toolbar = folder.toolbar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : "";
      const modified = folder.lastModifiedAt
        ? ` LAST_MODIFIED="${seconds(folder.lastModifiedAt)}"`
        : "";
      lines.push(
        `${pad(step.depth)}<DT><H3 ADD_DATE="${seconds(folder.addedAt)}"${modified}${toolbar}>${escapeHtml(folder.name)}</H3>`,
      );
      lines.push(`${pad(step.depth)}<DL><p>`);
    } else if (step.kind === "close") {
      lines.push(`${pad(step.depth)}</DL><p>`);
    } else {
      writeBookmarks(step.parentId, step.depth);
    }
  }

  lines.push("</DL><p>");
  return lines.join("\n");
}
