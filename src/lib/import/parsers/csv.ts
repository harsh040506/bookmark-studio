/**
 * CSV, and the column-guessing that makes a generic CSV importable at all.
 *
 * ## Why this is hand-rolled
 *
 * A CSV parser is four rules (quotes, doubled quotes, embedded newlines, embedded commas)
 * and every one of them is load-bearing here: Raindrop puts commas in excerpts, Diigo puts
 * newlines in annotations, and a naïve `split(",")` turns either into a row that silently
 * shifts every column one to the left. It is also a hot loop over files with hundreds of
 * thousands of rows, so it is written as a single character scan with no regex and no
 * intermediate arrays per field.
 *
 * ## Why columns are matched rather than configured
 *
 * Twelve services spell "the address" as url, link, href, web link, source url or source.
 * Asking the user to map columns before they have seen whether the file parsed at all is
 * the wrong order; the importer guesses, shows the guess with a sample, and lets it be
 * corrected. {@link guessColumns} is that guess, and it is the only place the aliases live.
 */
import type { CsvPreset, ParsedFile, RawItem } from "../types";

/**
 * Splits CSV text into rows of fields.
 *
 * Handles quoted fields containing the delimiter, newlines and doubled quotes, and both
 * CRLF and LF line endings. A trailing newline does not produce a phantom empty row.
 */
export function parseCsvRows(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  // A UTF-8 BOM survives Excel round-trips and would otherwise become part of the first
  // header's name, so "url" arrives as "﻿url" and matches nothing.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    row.push(field);
    field = "";
    started = true;
  };
  const endRow = () => {
    endField();
    // A row that is one empty field is a blank line, not a record.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    started = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      endRow();
      continue;
    }
    field += char;
  }

  if (field !== "" || started || row.length) endRow();
  return rows;
}

/** Picks the delimiter by counting candidates in the header line. */
export function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, 4096).split(/\r?\n/)[0] ?? "";
  const counts = [",", "\t", ";", "|"].map((candidate) => ({
    candidate,
    count: firstLine.split(candidate).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].candidate : ",";
}

/** Which column plays which role. `-1` means the file has no such column. */
export interface ColumnMap {
  url: number;
  title: number;
  description: number;
  note: number;
  tags: number;
  folder: number;
  addedAt: number;
  favorite: number;
  archived: number;
}

export const EMPTY_COLUMNS: ColumnMap = {
  url: -1,
  title: -1,
  description: -1,
  note: -1,
  tags: -1,
  folder: -1,
  addedAt: -1,
  favorite: -1,
  archived: -1,
};

/**
 * Aliases every service actually uses, in preference order.
 *
 * A preset from the catalog is consulted first and these are the fallback, so a
 * service-specific spelling ("document tags") wins over the generic one ("tags") without
 * the generic list having to know that service exists.
 */
const DEFAULT_ALIASES: Record<keyof ColumnMap, string[]> = {
  url: ["url", "link", "href", "uri", "address", "web link", "source url", "source_url", "source"],
  title: ["title", "name", "description title", "page title", "bookmark"],
  description: ["description", "excerpt", "summary", "selection", "extended", "snippet"],
  note: ["note", "notes", "annotations", "comment", "comments", "highlight"],
  tags: ["tags", "tag", "labels", "keywords", "categories", "document tags"],
  folder: ["folder", "collection", "folders", "path", "location", "category", "parent"],
  addedAt: [
    "created",
    "created_at",
    "created time",
    "date",
    "added",
    "time_added",
    "time added",
    "timestamp",
    "saved date",
    "saved_at",
    "time",
    "lastupdate",
  ],
  favorite: ["favorite", "favourite", "starred", "important"],
  archived: ["archived", "status", "state", "is_archive"],
};

function findColumn(headers: string[], aliases: string[] | undefined): number {
  if (!aliases?.length) return -1;
  for (const alias of aliases) {
    const index = headers.indexOf(alias);
    if (index !== -1) return index;
  }
  // A looser pass, so "Source URL (canonical)" still resolves. Exact matches are tried
  // for every alias first, or "url" would match "url_hash" before it matched "url".
  for (const alias of aliases) {
    const index = headers.findIndex((header) => header.includes(alias));
    if (index !== -1) return index;
  }
  return -1;
}

export function guessColumns(headerRow: string[], preset?: CsvPreset): ColumnMap {
  const headers = headerRow.map((header) => header.trim().toLowerCase());
  const pick = (role: keyof ColumnMap) => {
    const fromPreset = findColumn(headers, preset?.[role as keyof CsvPreset] as string[] | undefined);
    if (fromPreset !== -1) return fromPreset;
    return findColumn(headers, DEFAULT_ALIASES[role]);
  };

  const map: ColumnMap = {
    url: pick("url"),
    title: pick("title"),
    description: pick("description"),
    note: pick("note"),
    tags: pick("tags"),
    folder: pick("folder"),
    addedAt: pick("addedAt"),
    favorite: pick("favorite"),
    archived: pick("archived"),
  };

  /*
   * A file with no recognisable URL header still usually has URLs in it.
   *
   * Headerless exports exist, and so do files whose URL column is called something nobody
   * anticipated. Falling back to "the first column whose header looks like a URL" recovers
   * both cases; the caller then treats row 0 as data rather than as headers.
   */
  if (map.url === -1) {
    const looksLikeUrl = headerRow.findIndex((cell) => /^https?:\/\//i.test(cell.trim()));
    if (looksLikeUrl !== -1) map.url = looksLikeUrl;
  }
  return map;
}

/** Truthy spellings a CSV uses for a boolean column. */
function truthy(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  return normalised === "true" || normalised === "yes" || normalised === "1" || normalised === "y";
}

/**
 * Timestamps, in every unit and spelling a bookmark export uses.
 *
 * Bounded to the span in which bookmarking has existed for the same reason the Netscape
 * parser bounds its own: an eleven-digit "seconds" value multiplies out to the year 2518,
 * and one bookmark dated five centuries from now sits at the top of "Newest first" forever.
 */
export function parseFlexibleDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const earliest = Date.UTC(1990, 0, 1);
  const latest = Date.now() + 86_400_000;

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    const ms =
      numeric > 1e16
        ? Math.round(numeric / 1000 - 11644473600000) // Chromium microseconds since 1601
        : numeric > 1e14
          ? Math.round(numeric / 1000)
          : numeric > 1e11
            ? numeric
            : numeric * 1000;
    return ms >= earliest && ms <= latest ? ms : undefined;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed >= earliest && parsed <= latest ? parsed : undefined;
}

export interface CsvParseOptions {
  preset?: CsvPreset;
  /** An explicit mapping, when the user has corrected the guess. */
  columns?: ColumnMap;
  delimiter?: string;
}

export function parseCsv(text: string, options: CsvParseOptions = {}): ParsedFile {
  const delimiter = options.delimiter ?? sniffDelimiter(text);
  const rows = parseCsvRows(text, delimiter);
  if (!rows.length) return { items: [], skipped: 0, warnings: ["The file had no rows."] };

  const header = rows[0];
  const columns = options.columns ?? guessColumns(header, options.preset);
  const warnings: string[] = [];

  if (columns.url === -1) {
    return {
      items: [],
      skipped: 0,
      warnings: ["No URL column was found. Choose one in the column mapping and try again."],
    };
  }

  /*
   * Whether row 0 was a header or the first record.
   *
   * Decided by looking at the cell the mapping calls the URL: if it is a URL, this file
   * has no header row and discarding it would silently drop a bookmark.
   */
  const headerIsData = /^https?:\/\//i.test((header[columns.url] ?? "").trim());
  const start = headerIsData ? 0 : 1;
  if (headerIsData) warnings.push("No header row was found; the first line was read as data.");

  const tagSeparator = options.preset?.tagSeparator ?? /[,;]/;
  const items: RawItem[] = [];
  let skipped = 0;
  let order = 0;

  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index];
    const cell = (position: number) => (position >= 0 ? (row[position] ?? "").trim() : "");
    const url = cell(columns.url);
    if (!/^(https?|ftp):\/\//i.test(url)) {
      skipped += 1;
      continue;
    }

    const folder = cell(columns.folder);
    const tags = cell(columns.tags);
    const status = cell(columns.archived).toLowerCase();

    items.push({
      url,
      title: cell(columns.title) || undefined,
      description: cell(columns.description) || undefined,
      note: cell(columns.note) || undefined,
      tags: tags ? tags.split(tagSeparator).map((tag) => tag.trim()).filter(Boolean) : undefined,
      folderPath: folder ? folder.split("/").map((part) => part.trim()).filter(Boolean) : undefined,
      addedAt: parseFlexibleDate(cell(columns.addedAt)),
      favorite: columns.favorite >= 0 ? truthy(cell(columns.favorite)) : undefined,
      // Pocket spells the archive as a `status` column reading "archive"/"unread", which
      // is neither a boolean nor a field name anything else uses.
      archived:
        columns.archived >= 0
          ? truthy(status) || status === "archive" || status === "archived"
          : undefined,
      order: order++,
    });
  }

  if (!items.length && !warnings.length) {
    warnings.push("No rows carried a usable http(s) address.");
  }
  return { items, skipped, warnings };
}

/** The header row on its own, for the column-mapping UI. */
export function csvHeaders(text: string, delimiter?: string): string[] {
  const rows = parseCsvRows(text.slice(0, 128 * 1024), delimiter ?? sniffDelimiter(text));
  return rows[0] ?? [];
}
