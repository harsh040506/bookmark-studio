/**
 * The import pipeline's front door.
 *
 * One call — {@link runImport} — reads a file, parses it with whichever of nine formats
 * applies, normalises every entry into library rows, resolves folders and reports
 * duplicates. The same call with `previewOnly` produces the numbers the dialog shows
 * before anything is written, using the identical code path, so the preview cannot
 * disagree with the import.
 *
 * The worker is a dependency here rather than an optimisation (see the worker's own note),
 * but a browser without `Worker` still has to be able to import a file — so there is a
 * synchronous fallback, and it produces byte-identical results because both call the same
 * pure functions.
 */
import type { Bookmark, Folder } from "../../../shared/types";
import { buildExistingIndex, normalizeItems } from "./normalize";
import { readImportText } from "./read-text";
import { parseBest, parseWith, type ParseOptions } from "./parsers";
import type { ColumnMap } from "./parsers/csv";
import type { ImportRequest, ImportResponse } from "./import.worker";
import type { ImportProgress, ParserId, SourceDefinition } from "./types";

export * from "./types";
export * from "./catalog";
export { csvHeaders, guessColumns, sniffDelimiter, EMPTY_COLUMNS } from "./parsers/csv";
export type { ColumnMap } from "./parsers/csv";

/**
 * The largest file that will be read into a string.
 *
 * `File.text()` materialises the whole thing, and a browser tab has a string-length
 * ceiling well below its memory ceiling. 256 MB is comfortably past any real bookmark
 * export — a 200,000-row Netscape file with embedded favicons is around 90 MB — and short
 * of the point where the read itself is what fails.
 */
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 1;

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    workerBroken = true;
    return null;
  }
  try {
    worker = new Worker(new URL("./import.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("error", () => {
      // A worker that has errored cannot be trusted with the request in flight or any
      // after it; dropping the reference sends everything to the synchronous path.
      workerBroken = true;
      worker?.terminate();
      worker = null;
    });
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Tears the worker down. Used by tests and when the library is reset. */
export function stopImportWorker(): void {
  worker?.terminate();
  worker = null;
}

export interface RunImportOptions {
  file: File;
  source: SourceDefinition;
  /** Overrides the source's parser list, when the user chose a format explicitly. */
  parser?: ParserId;
  csvColumns?: ColumnMap;
  csvDelimiter?: string;
  existingUrls: string[];
  folders: Folder[];
  importId: string;
  importedAt: number;
  sourceId: string;
  keepDuplicates: boolean;
  previewOnly?: boolean;
  onProgress?: (progress: ImportProgress) => void;
  /** Text already read from the file, so a preview and its import read the disk once. */
  text?: string;
}

export interface ImportOutcome {
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
  bookmarks: Bookmark[];
  newFolders: Folder[];
}

const FAILED = (parser: ParserId, error: string): ImportOutcome => ({
  ok: false,
  error,
  parser,
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

export async function runImport(options: RunImportOptions): Promise<ImportOutcome> {
  const parsers = options.parser ? [options.parser] : options.source.parsers;

  if (options.file.size > MAX_IMPORT_BYTES) {
    return FAILED(parsers[0], "That file is too large to read in a browser tab.");
  }

  options.onProgress?.({ phase: "reading", done: 0, total: options.file.size });
  let text: string;
  try {
    text = options.text ?? (await readImportText(options.file)).text;
  } catch {
    return FAILED(parsers[0], "The file could not be read from disk.");
  }

  const request: Omit<ImportRequest, "id"> = {
    text,
    fileName: options.file.name,
    parsers,
    parser: options.parser,
    csvPreset: options.source.csv,
    csvColumns: options.csvColumns,
    csvDelimiter: options.csvDelimiter,
    existingUrls: options.existingUrls,
    folders: options.folders,
    importId: options.importId,
    importedAt: options.importedAt,
    sourceId: options.sourceId,
    keepDuplicates: options.keepDuplicates,
    previewOnly: options.previewOnly ?? false,
  };

  const instance = getWorker();
  if (!instance) return runImportSync(request);

  const id = nextRequestId++;
  return new Promise<ImportOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ImportOutcome) => {
      if (settled) return;
      settled = true;
      instance.removeEventListener("message", onMessage);
      resolve(outcome);
    };

    const onMessage = (event: MessageEvent<ImportResponse | ({ id: number } & ImportProgress)>) => {
      const message = event.data;
      if (message.id !== id) return;
      if ("phase" in message) {
        options.onProgress?.(message);
        return;
      }
      options.onProgress?.({ phase: "done", done: message.total, total: message.total });
      finish(message);
    };

    instance.addEventListener("message", onMessage);
    try {
      instance.postMessage({ ...request, id } satisfies ImportRequest);
    } catch {
      // A structured-clone failure on a very large string is recoverable: do the work here.
      finish(runImportSync(request));
    }
  });
}

/** The identical pipeline, on this thread. Used when no worker is available. */
function runImportSync(request: Omit<ImportRequest, "id">): ImportOutcome {
  const parseOptions: ParseOptions = {
    fileName: request.fileName,
    csvPreset: request.csvPreset,
    csvColumns: request.csvColumns,
    csvDelimiter: request.csvDelimiter,
  };

  const { result: parsed, parser } = request.parser
    ? { result: parseWith(request.parser, request.text, parseOptions), parser: request.parser }
    : parseBest(request.parsers, request.text, parseOptions);

  const existing = buildExistingIndex(request.existingUrls.map((url) => ({ url }) as Bookmark));
  const normalized = normalizeItems(parsed.items, {
    existing,
    folders: request.folders,
    importId: request.importId,
    importedAt: request.importedAt,
    sourceId: request.sourceId,
    keepDuplicates: request.keepDuplicates,
  });

  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const row of normalized.bookmarks) {
    if (row.addedAt < from) from = row.addedAt;
    if (row.addedAt > to) to = row.addedAt;
  }
  const folderNames = new Map(
    [...request.folders, ...normalized.folders].map((folder) => [folder.id, folder.name]),
  );

  return {
    ok: true,
    parser,
    warnings: parsed.warnings.slice(0, 6),
    skipped: parsed.skipped + normalized.skipped,
    duplicates: normalized.duplicates,
    internalDuplicates: normalized.internalDuplicates,
    total: normalized.bookmarks.length,
    folderCount: normalized.folders.length,
    span: Number.isFinite(from) ? { from, to } : undefined,
    sample: normalized.bookmarks.slice(0, 6).map((row) => ({
      title: row.title,
      url: row.url,
      folder: row.folderId ? (folderNames.get(row.folderId) ?? "") : "",
    })),
    bookmarks: request.previewOnly ? [] : normalized.bookmarks,
    newFolders: request.previewOnly ? [] : normalized.folders,
  };
}
