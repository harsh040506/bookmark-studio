/**
 * One entry point: text plus a parser name, out come {@link RawItem}s.
 *
 * The dispatcher is deliberately dumb — no sniffing, no fallbacks between formats — so
 * that "which parser" is decided exactly once, in the catalog, where the user can see and
 * override it. A dispatcher that quietly tried three parsers would make a failed import
 * impossible to explain.
 */
import { parseNetscapeBookmarks } from "../../netscape";
import { parseXArchive } from "../../xarchive";
import type { CsvPreset, ParsedFile, ParserId, RawItem } from "../types";
import { parseCsv, type ColumnMap } from "./csv";
import {
  parseChromiumJson,
  parseEnex,
  parseFirefoxJson,
  parseGenericJson,
  parseSafariPlist,
  parseUrlList,
} from "./structured";

export * from "./csv";
export * from "./structured";

/**
 * The Netscape file, re-expressed as folder *paths*.
 *
 * The existing parser returns folders and bookmarks that reference them by id, which is
 * the right shape for a merge into an existing tree and the wrong one for a common
 * intermediate: every other format here knows only "which folders is this inside", so
 * resolving ids to a path is what lets one folder-reconciliation routine serve all nine.
 */
function parseNetscapeAsRaw(text: string): ParsedFile {
  const parsed = parseNetscapeBookmarks(text);
  const byId = new Map(parsed.folders.map((folder) => [folder.id, folder]));

  const pathCache = new Map<string, string[]>();
  const pathOf = (folderId: string | null): string[] => {
    if (!folderId) return [];
    const cached = pathCache.get(folderId);
    if (cached) return cached;
    const segments: string[] = [];
    let cursor: string | null = folderId;
    // Bounded, because a malformed file can describe a cycle and a bookmarks import must
    // not be able to hang the tab.
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      const folder = byId.get(cursor);
      if (!folder) break;
      segments.unshift(folder.name);
      cursor = folder.parentId;
    }
    pathCache.set(folderId, segments);
    return segments;
  };

  const items: RawItem[] = parsed.bookmarks.map((bookmark) => ({
    url: bookmark.url,
    title: bookmark.title,
    description: bookmark.description || undefined,
    icon: bookmark.icon,
    tags: bookmark.tags.length ? bookmark.tags : undefined,
    folderPath: bookmark.folderId ? pathOf(bookmark.folderId) : undefined,
    addedAt: bookmark.addedAt,
    lastModifiedAt: bookmark.lastModifiedAt,
    order: bookmark.order,
  }));

  return {
    items,
    skipped: parsed.skipped,
    warnings: items.length ? [] : ["No bookmarks were found in the HTML file."],
  };
}

/**
 * An X archive's posts as importable rows.
 *
 * Posts carrying media keep the media *URL* rather than the bytes: fetching a thousand
 * images before anything appears is the wrong order, and the pipeline already knows how
 * to fill a row in after it lands. A post whose only substance is a link it pointed at
 * imports as that link, which is what somebody bookmarking on X actually meant to save.
 */
function parseXArchiveAsRaw(text: string, fileName: string): ParsedFile {
  const parsed = parseXArchive(text, fileName);
  const items: RawItem[] = parsed.posts.map((post, index) => ({
    url: post.linkedUrl && post.kind === "note" ? post.linkedUrl : post.url,
    title: post.title,
    text: post.text,
    author: post.author,
    tags: post.tags.length ? post.tags : undefined,
    addedAt: post.createdAt,
    kind: post.kind,
    order: index,
  }));
  return {
    items,
    skipped: parsed.skipped,
    warnings: items.length ? [] : ["No posts were found. Expected bookmark.js or tweets.js."],
  };
}

export interface ParseOptions {
  fileName: string;
  csvPreset?: CsvPreset;
  csvColumns?: ColumnMap;
  csvDelimiter?: string;
}

export function parseWith(parser: ParserId, text: string, options: ParseOptions): ParsedFile {
  switch (parser) {
    case "netscape":
      return parseNetscapeAsRaw(text);
    case "chromium-json":
      return parseChromiumJson(text);
    case "firefox-json":
      return parseFirefoxJson(text);
    case "safari-plist":
      return parseSafariPlist(text);
    case "enex":
      return parseEnex(text);
    case "csv":
      return parseCsv(text, {
        preset: options.csvPreset,
        columns: options.csvColumns,
        delimiter: options.csvDelimiter,
      });
    case "json":
      return parseGenericJson(text);
    case "x-archive":
      return parseXArchiveAsRaw(text, options.fileName);
    case "text-urls":
      return parseUrlList(text);
    case "backup":
      // The backup path is not a `RawItem` import at all — it restores ids, boards and
      // history — so it is handled by `useLibrary` and never reaches this dispatcher.
      return { items: [], skipped: 0, warnings: ["Backups are restored, not imported."] };
    default:
      return { items: [], skipped: 0, warnings: [`Unknown format: ${parser}`] };
  }
}

/**
 * Tries a source's parsers in order and keeps the first that yields anything.
 *
 * The one place a fallback is legitimate: a source like Firefox genuinely publishes two
 * formats under the same extension, and which one a given file is cannot be told from its
 * name. The parser that won is reported, so the summary can say which was used.
 */
export function parseBest(
  parsers: ParserId[],
  text: string,
  options: ParseOptions,
): { result: ParsedFile; parser: ParserId } {
  let firstAttempt: { result: ParsedFile; parser: ParserId } | null = null;
  for (const parser of parsers) {
    const result = parseWith(parser, text, options);
    if (result.items.length) return { result, parser };
    firstAttempt ??= { result, parser };
  }
  return firstAttempt ?? { result: { items: [], skipped: 0, warnings: [] }, parser: parsers[0] };
}
