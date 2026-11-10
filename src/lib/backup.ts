/**
 * JSON backup: reading back what the JSON export writes out.
 *
 * The HTML export exists for portability — any browser can re-import it — but it is a
 * lossy format. Netscape bookmark HTML has nowhere to record a board, a private note,
 * link health, a screenshot timestamp, or the scraped text that makes search work. The
 * JSON export carries all of it, which made it the app's only complete backup and, until
 * this module existed, a backup with no way to restore it.
 *
 * ## Why parsing is defensive
 *
 * A restore reads a file the user chose, which may be truncated, hand-edited, from an
 * older version of the app, or simply the wrong file. Every field is therefore validated
 * and coerced rather than trusted: a malformed entry is dropped and counted, never
 * allowed to enter the library as an object that later crashes a render. Ids are
 * preserved when present so a restore over the same library updates rows in place
 * instead of duplicating them.
 */
import type { Board, Bookmark, DeviceName, Folder, ImportBatch } from "../../shared/types";
import { repairFolders } from "./repair";
import { getDomain } from "./text";
import { newId } from "./utils";

/** Shape written by `exportLibrary(..., "json")`. */
export interface BackupFile {
  exportedAt: number;
  folders: Folder[];
  boards: Board[];
  bookmarks: Bookmark[];
  /**
   * The import batches the bookmarks belong to.
   *
   * Optional because backups written before provenance was carried do not have it. When
   * it is absent the restore repairs the dangling `importId` references rather than
   * leaving rows pointing at batches that will never exist — see {@link parseBackup}.
   */
  imports?: ImportBatch[];
}

export interface RestoreResult {
  bookmarks: Bookmark[];
  folders: Folder[];
  boards: Board[];
  imports: ImportBatch[];
  /** Entries rejected as unusable, surfaced so a partial restore is never silent. */
  skipped: number;
  exportedAt?: number;
}

export class BackupFormatError extends Error {
  /**
   * Named explicitly, because the class itself does not survive a structured clone.
   *
   * The restore now happens in a worker, and `instanceof` is meaningless on the far side
   * of `postMessage` — so the *kind* of failure travels as this string and the error is
   * reconstructed on arrival. Without it, "that is not a backup file" and "something went
   * wrong reading the file" become the same message, and only one of them is the user's
   * to fix.
   */
  override name = "BackupFormatError";
}

/**
 * Largest backup accepted, in bytes.
 *
 * Real libraries — including Chrome's embedded base64 favicons — land far below this;
 * anything above it is a wrong-file mistake worth refusing quickly rather than hanging on.
 *
 * The number used to be a defence against freezing the tab, since `JSON.parse` on a very
 * large string cannot be interrupted. Parsing now happens in a worker (see
 * `backup.worker.ts`), so the window stays responsive and the ceiling is only about
 * refusing something absurd early.
 */
export const MAX_BACKUP_BYTES = 150 * 1024 * 1024;

let backupWorker: Worker | null = null;
let backupWorkerBroken = false;
let nextBackupRequest = 1;

/**
 * Parses a backup file without blocking the window.
 *
 * Falls back to parsing here when a worker cannot be started, which keeps the test
 * environment and older browsers working exactly as they did — the result is identical
 * either way, and only the responsiveness of the tab differs.
 */
export async function parseBackupFile(file: File): Promise<RestoreResult> {
  if (!backupWorkerBroken && typeof Worker !== "undefined") {
    try {
      backupWorker ??= new Worker(new URL("./backup.worker.ts", import.meta.url), {
        type: "module",
      });
      const worker = backupWorker;
      const id = nextBackupRequest++;

      return await new Promise<RestoreResult>((resolve, reject) => {
        const onMessage = (event: MessageEvent<import("./backup.worker").BackupResponse>) => {
          if (event.data.id !== id) return;
          cleanup();
          if (event.data.ok) {
            resolve(event.data.result);
            return;
          }
          reject(
            event.data.format
              ? new BackupFormatError(event.data.error)
              : new Error(event.data.error),
          );
        };
        const onError = () => {
          cleanup();
          // A worker that has errored cannot be trusted again; everything after this
          // request parses on the main thread.
          backupWorkerBroken = true;
          backupWorker?.terminate();
          backupWorker = null;
          reject(new Error("worker-unavailable"));
        };
        function cleanup() {
          worker.removeEventListener("message", onMessage as EventListener);
          worker.removeEventListener("error", onError);
        }
        worker.addEventListener("message", onMessage as EventListener);
        worker.addEventListener("error", onError);
        worker.postMessage({ id, file });
      });
    } catch (error) {
      // A genuine format complaint is the answer, not a reason to try again more slowly.
      if (error instanceof BackupFormatError) throw error;
      backupWorkerBroken = true;
    }
  }

  return parseBackup(await file.text());
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Coerces one record into a valid `Bookmark`, or returns `null` to drop it.
 *
 * A URL is the only genuinely required field: everything else can be defaulted, and a
 * bookmark without a link is not a bookmark. Nested `health` and `preview` objects are
 * rebuilt rather than spread, because a backup from an older version may be missing them
 * entirely and every consumer in the app reads `bookmark.health.status` unguarded.
 */
function toBookmark(raw: unknown): Bookmark | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;

  const url = asString(row.url).trim();
  if (!url) return null;

  const health = (row.health ?? {}) as Record<string, unknown>;
  const preview = (row.preview ?? {}) as Record<string, unknown>;
  const meta = row.meta && typeof row.meta === "object" ? (row.meta as Bookmark["meta"]) : undefined;

  const status = asString(health.status, "unchecked");
  const method = asString(preview.method, "card");

  return {
    id: asString(row.id) || newId("bmk"),
    url,
    title: asString(row.title) || getDomain(url),
    domain: asString(row.domain) || getDomain(url),
    icon: typeof row.icon === "string" ? row.icon : undefined,
    description: asString(row.description),
    summary: typeof row.summary === "string" ? row.summary : undefined,
    category: asString(row.category),
    tags: asStringArray(row.tags),
    folderId: typeof row.folderId === "string" ? row.folderId : null,
    boardIds: asStringArray(row.boardIds),
    addedAt: asNumber(row.addedAt, Date.now()),
    lastModifiedAt: typeof row.lastModifiedAt === "number" ? row.lastModifiedAt : undefined,
    lastVisitedAt: typeof row.lastVisitedAt === "number" ? row.lastVisitedAt : undefined,
    visitCount: Math.max(0, asNumber(row.visitCount, 0)),
    health: {
      status: (["live", "redirected", "dead", "blocked", "unchecked"].includes(status)
        ? status
        : "unchecked") as Bookmark["health"]["status"],
      httpCode: typeof health.httpCode === "number" ? health.httpCode : undefined,
      finalUrl: typeof health.finalUrl === "string" ? health.finalUrl : undefined,
      redirectCount: typeof health.redirectCount === "number" ? health.redirectCount : undefined,
      checkedAt: typeof health.checkedAt === "number" ? health.checkedAt : undefined,
      archiveUrl: typeof health.archiveUrl === "string" ? health.archiveUrl : undefined,
      error: typeof health.error === "string" ? health.error : undefined,
    },
    preview: {
      method: (["live", "screenshot", "snapshot", "card"].includes(method)
        ? method
        : "card") as Bookmark["preview"]["method"],
      imageUrl: typeof preview.imageUrl === "string" ? preview.imageUrl : undefined,
      capturedAt: typeof preview.capturedAt === "number" ? preview.capturedAt : undefined,
      colors: asStringArray(preview.colors),
      shotAt: typeof preview.shotAt === "number" ? preview.shotAt : undefined,
      shotDevice: asDevice(preview.shotDevice),
      frameable: typeof preview.frameable === "boolean" ? preview.frameable : undefined,
    },
    enriched: row.enriched === true,
    meta,
    note: typeof row.note === "string" ? row.note : undefined,
    editedAt: typeof row.editedAt === "number" ? row.editedAt : undefined,
    favorite: row.favorite === true || undefined,
    archived: row.archived === true || undefined,
    /**
     * Provenance and ordering, which the restore used to drop on the floor.
     *
     * These three fields are what "As imported" sorts on, what "Recently added" measures
     * against, and what ties a bookmark to the batch it arrived in. Losing them made a
     * restored library subtly but permanently worse than the one it came from: the user's
     * own folder-by-folder arrangement collapsed to alphabetical, "Recently added" read
     * from decade-old browser timestamps and showed nothing, and the Imports rail lost
     * every batch. All three are silent failures — nothing errors, the library simply
     * forgets where it came from.
     */
    sourceOrder: typeof row.sourceOrder === "number" ? row.sourceOrder : undefined,
    importId: typeof row.importId === "string" ? row.importId : undefined,
    importedAt: typeof row.importedAt === "number" ? row.importedAt : undefined,
  };
}

/** Narrows an untrusted viewport name, so a hand-edited file cannot mint a fourth device. */
function asDevice(value: unknown): DeviceName | undefined {
  return value === "desktop" || value === "tablet" || value === "mobile" ? value : undefined;
}

function toFolder(raw: unknown): Folder | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = asString(row.id);
  const name = asString(row.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    parentId: typeof row.parentId === "string" ? row.parentId : null,
    addedAt: asNumber(row.addedAt, Date.now()),
    lastModifiedAt: typeof row.lastModifiedAt === "number" ? row.lastModifiedAt : undefined,
    toolbar: row.toolbar === true || undefined,
    // The tree is drawn in `sourceOrder` before anything else (see `compareFolders`), so
    // dropping it here re-alphabetised the sidebar of every restored library.
    sourceOrder: typeof row.sourceOrder === "number" ? row.sourceOrder : undefined,
    importId: typeof row.importId === "string" ? row.importId : undefined,
  };
}

/**
 * Coerces one record into an {@link ImportBatch}, or returns `null` to drop it.
 *
 * A batch with no id is unreferenceable — nothing can point at it and nothing can open it
 * — so that is the one field without a defensible default. Counts are cosmetic: the rail
 * shows live totals recomputed from the bookmarks themselves, never these.
 */
function toImport(raw: unknown): ImportBatch | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = asString(row.id);
  if (!id) return null;
  const fileName = asString(row.fileName);
  return {
    id,
    name: asString(row.name) || fileName || "Import",
    fileName,
    at: asNumber(row.at, Date.now()),
    format: row.format === "json" ? "json" : "html",
    mode: row.mode === "replace" ? "replace" : "merge",
    bookmarkCount: Math.max(0, asNumber(row.bookmarkCount, 0)),
    folderCount: Math.max(0, asNumber(row.folderCount, 0)),
    duplicateCount: Math.max(0, asNumber(row.duplicateCount, 0)),
  };
}

function toBoard(raw: unknown): Board | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = asString(row.id);
  const name = asString(row.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    color: asString(row.color, "#2457F5"),
    createdAt: asNumber(row.createdAt, Date.now()),
  };
}

/**
 * Parses and validates a JSON backup.
 *
 * @param text Raw file contents.
 * @returns The restorable snapshot plus a count of dropped entries.
 * @throws {BackupFormatError} When the text is not JSON, or is JSON that carries no
 *   recognisable bookmarks — the two cases where continuing would silently wipe a
 *   library on a "replace" restore.
 */
export function parseBackup(text: string): RestoreResult {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new BackupFormatError("That file is not valid JSON.");
  }

  if (!payload || typeof payload !== "object") {
    throw new BackupFormatError("That file does not look like a library backup.");
  }

  const file = payload as Partial<BackupFile>;
  const rawBookmarks = Array.isArray(file.bookmarks) ? file.bookmarks : null;
  if (!rawBookmarks) {
    throw new BackupFormatError("No bookmarks array found in that backup.");
  }

  const bookmarks: Bookmark[] = [];
  let skipped = 0;
  for (const raw of rawBookmarks) {
    const bookmark = toBookmark(raw);
    if (bookmark) bookmarks.push(bookmark);
    else skipped += 1;
  }

  if (!bookmarks.length) {
    throw new BackupFormatError("That backup contains no usable bookmarks.");
  }

  const folders = (Array.isArray(file.folders) ? file.folders : [])
    .map(toFolder)
    .filter((folder): folder is Folder => folder !== null);

  const boards = (Array.isArray(file.boards) ? file.boards : [])
    .map(toBoard)
    .filter((board): board is Board => board !== null);

  const imports = (Array.isArray(file.imports) ? file.imports : [])
    .map(toImport)
    .filter((batch): batch is ImportBatch => batch !== null);

  /**
   * Repair dangling references.
   *
   * A backup can legitimately be a *subset* — the export honours a selection — so a
   * bookmark may point at a folder, board or import batch the file does not carry. Left
   * alone those ids make a bookmark unreachable: filtered out of every folder view, or
   * counted against an import that has no row in the rail, while still contributing to
   * the total. Clearing them puts the row back where it can be seen and re-filed.
   */
  const folderIds = new Set(folders.map((folder) => folder.id));
  const boardIds = new Set(boards.map((board) => board.id));
  const importIds = new Set(imports.map((batch) => batch.id));
  for (const bookmark of bookmarks) {
    if (bookmark.folderId && !folderIds.has(bookmark.folderId)) bookmark.folderId = null;
    bookmark.boardIds = bookmark.boardIds.filter((id) => boardIds.has(id));
    /**
     * An orphaned `importId` is cleared, but `importedAt` is kept.
     *
     * They answer different questions. The id says "which batch", and pointing at a
     * batch that does not exist is worse than pointing at none — the caller re-stamps a
     * cleared id onto the restore's own batch, which is the truthful answer. The
     * timestamp says "when this entered a library", which is still true of a row whose
     * batch record was not carried, and it is what "Recently added" reads.
     */
    if (bookmark.importId && !importIds.has(bookmark.importId)) bookmark.importId = undefined;
  }
  for (const folder of folders) {
    if (folder.parentId && !folderIds.has(folder.parentId)) folder.parentId = null;
    if (folder.importId && !importIds.has(folder.importId)) folder.importId = undefined;
  }
  // A hand-edited or damaged backup can hold folders that name each other as parent. They
  // would be invisible in the tree, with everything in them, until the next reload repaired them.
  repairFolders(folders);

  return {
    bookmarks,
    folders,
    boards,
    imports,
    skipped,
    exportedAt: typeof file.exportedAt === "number" ? file.exportedAt : undefined,
  };
}

/**
 * Merges a restored snapshot into an existing library.
 *
 * Matching is by id, not URL: a backup restored over the library it came from should
 * update rows rather than create near-copies of them. URL-level de-duplication is left
 * to the HTML import path, where ids are genuinely new every time.
 */
export function mergeBackup(
  restored: RestoreResult,
  existing: { bookmarks: Bookmark[]; folders: Folder[]; boards: Board[]; imports?: ImportBatch[] },
): {
  bookmarks: Bookmark[];
  folders: Folder[];
  boards: Board[];
  imports: ImportBatch[];
  added: number;
  updated: number;
} {
  const bookmarksById = new Map(existing.bookmarks.map((row) => [row.id, row]));
  let added = 0;
  let updated = 0;

  for (const row of restored.bookmarks) {
    if (bookmarksById.has(row.id)) updated += 1;
    else added += 1;
    bookmarksById.set(row.id, row);
  }

  const foldersById = new Map(existing.folders.map((row) => [row.id, row]));
  for (const row of restored.folders) foldersById.set(row.id, row);

  const boardsById = new Map(existing.boards.map((row) => [row.id, row]));
  for (const row of restored.boards) boardsById.set(row.id, row);

  /**
   * Batches merge by id like everything else, so restoring a backup over the library it
   * came from re-establishes the Imports rail rather than duplicating it.
   */
  const importsById = new Map((existing.imports ?? []).map((row) => [row.id, row]));
  for (const row of restored.imports) importsById.set(row.id, row);

  return {
    bookmarks: [...bookmarksById.values()],
    folders: [...foldersById.values()],
    boards: [...boardsById.values()],
    imports: [...importsById.values()],
    added,
    updated,
  };
}
