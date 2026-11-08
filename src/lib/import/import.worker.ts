/**
 * Parsing, normalising and de-duplicating an import, off the main thread.
 *
 * ## Why this is a worker and the index builder is only optionally one
 *
 * An import is the one operation whose input size is chosen by the user and unbounded.
 * A 40 MB Netscape file is 200,000 regex matches, 200,000 URL canonicalisations and
 * 200,000 rule evaluations, and every one of those on the main thread is a frozen window
 * with no progress and no way to cancel. Unlike the search index there is no small-input
 * case worth optimising for: a hundred-row CSV parses in a millisecond either way, so the
 * worker is unconditional and the code has one path.
 *
 * The worker owns nothing. It is handed the file text and a list of existing URLs, and it
 * returns rows; the database, the undo stack and every decision about what to do with the
 * result stay on the main thread.
 */
import type { Bookmark, Folder } from "../../../shared/types";
import { buildExistingIndex, normalizeItems } from "./normalize";
import { parseBest, parseWith, type ParseOptions } from "./parsers";
import type { ColumnMap } from "./parsers/csv";
import type { CsvPreset, ImportProgress, ParsedFile, ParserId } from "./types";

export interface ImportRequest {
  id: number;
  text: string;
  fileName: string;
  /** The parsers to try, best first. Comes from the chosen source's definition. */
  parsers: ParserId[];
  /** Forces one parser, when the user has picked a format explicitly. */
  parser?: ParserId;
  csvPreset?: CsvPreset;
  csvColumns?: ColumnMap;
  csvDelimiter?: string;
  /** Every URL currently in the library, for duplicate detection. */
  existingUrls: string[];
  folders: Folder[];
  importId: string;
  importedAt: number;
  sourceId: string;
  keepDuplicates: boolean;
  /**
   * Parse and count, but do not mint rows.
   *
   * The preview needs the same parse the real import will do — anything less and the
   * numbers shown are not the numbers that happen — but it does not need three hundred
   * thousand `Bookmark` objects built and cloned back across the wire.
   */
  previewOnly: boolean;
}

export interface ImportResponse {
  id: number;
  ok: boolean;
  error?: string;
  parser: ParserId;
  warnings: string[];
  skipped: number;
  duplicates: number;
  internalDuplicates: number;
  total: number;
  folderCount: number;
  span?: { from: number; to: number };
  sample: { title: string; url: string; folder: string }[];
  /** Empty when `previewOnly`. */
  bookmarks: Bookmark[];
  newFolders: Folder[];
}

function post(message: ImportResponse | ({ id: number } & ImportProgress)) {
  (self as unknown as Worker).postMessage(message);
}

self.addEventListener("message", (event: MessageEvent<ImportRequest>) => {
  const request = event.data;
  try {
    post({ id: request.id, phase: "parsing", done: 0, total: 0 });

    const options: ParseOptions = {
      fileName: request.fileName,
      csvPreset: request.csvPreset,
      csvColumns: request.csvColumns,
      csvDelimiter: request.csvDelimiter,
    };

    let parsed: ParsedFile;
    let parser: ParserId;
    if (request.parser) {
      parsed = parseWith(request.parser, request.text, options);
      parser = request.parser;
    } else {
      const best = parseBest(request.parsers, request.text, options);
      parsed = best.result;
      parser = best.parser;
    }

    post({ id: request.id, phase: "normalising", done: 0, total: parsed.items.length });

    /*
     * The duplicate index is built here rather than sent.
     *
     * Canonicalising a hundred thousand URLs is real work, and doing it on the main thread
     * to produce a map that is then structured-cloned across the wire costs the freeze
     * this worker exists to prevent — twice.
     */
    const existing = buildExistingIndex(
      request.existingUrls.map((url) => ({ url }) as Bookmark),
    );

    post({ id: request.id, phase: "deduplicating", done: 0, total: parsed.items.length });

    const result = normalizeItems(parsed.items, {
      existing,
      folders: request.folders,
      importId: request.importId,
      importedAt: request.importedAt,
      sourceId: request.sourceId,
      keepDuplicates: request.keepDuplicates,
    });

    /* The date span, for the preview's "covers 2014 – 2025" line. */
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const row of result.bookmarks) {
      if (row.addedAt < from) from = row.addedAt;
      if (row.addedAt > to) to = row.addedAt;
    }

    const folderNames = new Map(
      [...request.folders, ...result.folders].map((folder) => [folder.id, folder.name]),
    );
    const sample = result.bookmarks.slice(0, 6).map((row) => ({
      title: row.title,
      url: row.url,
      folder: row.folderId ? (folderNames.get(row.folderId) ?? "") : "",
    }));

    post({
      id: request.id,
      ok: true,
      parser,
      warnings: parsed.warnings.slice(0, 6),
      skipped: parsed.skipped + result.skipped,
      duplicates: result.duplicates,
      internalDuplicates: result.internalDuplicates,
      total: result.bookmarks.length,
      folderCount: result.folders.length,
      span: Number.isFinite(from) ? { from, to } : undefined,
      sample,
      bookmarks: request.previewOnly ? [] : result.bookmarks,
      newFolders: request.previewOnly ? [] : result.folders,
    });
  } catch (error) {
    post({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "The file could not be read.",
      parser: request.parser ?? request.parsers[0],
      warnings: [],
      skipped: 0,
      duplicates: 0,
      internalDuplicates: 0,
      total: 0,
      folderCount: 0,
      sample: [],
      bookmarks: [],
      newFolders: [],
    });
  }
});
