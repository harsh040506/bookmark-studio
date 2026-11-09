/**
 * Types and helpers shared by the library hooks (see `../useLibrary.ts`).
 */
import {
  
  type Bookmark,
  
  
  
  
} from "../../../shared/types";
import {
  CHROME_SOURCE_ID,
  
  
  
  
  
} from "../../lib/chrome-bookmarks";
import * as db from "../../lib/db";
import { announceCommit } from "../../lib/sync";
import { parseBackupFile } from "../../lib/backup";
import { type ColumnMap, type ImportOutcome, type SourceDefinition } from "../../lib/import";

/** What the import dialog hands the library, for a preview or for the real thing. */
export interface ImportRunOptions {
  file: File;
  source: SourceDefinition;
  csvColumns?: ColumnMap;
  mode: "merge" | "replace";
  keepDuplicates: boolean;
  /** Text already read from the file, so a preview and its import read the disk once. */
  text?: string;
}

/**
 * The rows a "replace" import keeps.
 *
 * Replacing the library means replacing what earlier *imports* brought in. The browser's
 * own bookmarks (mirrored two-way when sync is on) are not the importer's to delete: wiping
 * them here would delete them from the browser too.
 */
export function keptOnReplace(rows: Bookmark[]): Bookmark[] {
  return rows.filter((row) => row.sourceId === CHROME_SOURCE_ID);
}

/** A backup's numbers for the review step, without writing anything. */
export async function previewBackup(file: File): Promise<ImportOutcome> {
  try {
    const restored = await parseBackupFile(file);
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const row of restored.bookmarks) {
      if (row.addedAt < from) from = row.addedAt;
      if (row.addedAt > to) to = row.addedAt;
    }
    return {
      ok: true,
      parser: "backup",
      warnings: [],
      skipped: restored.skipped,
      duplicates: 0,
      internalDuplicates: 0,
      total: restored.bookmarks.length,
      folderCount: restored.folders.length,
      span: Number.isFinite(from) ? { from, to } : undefined,
      sample: restored.bookmarks.slice(0, 6).map((row) => ({ title: row.title, url: row.url, folder: "" })),
      bookmarks: [],
      newFolders: [],
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "That backup could not be read",
      parser: "backup",
      warnings: [],
      skipped: 0,
      duplicates: 0,
      internalDuplicates: 0,
      total: 0,
      folderCount: 0,
      sample: [],
      bookmarks: [],
      newFolders: [],
    };
  }
}

export interface JobState {
  running: boolean;
  done: number;
  total: number;
  label: string;
  /** Failures are surfaced rather than silently swallowed. */
  failed: number;
  /** False for work that cannot be interrupted safely (an import mid-write). */
  cancellable?: boolean;
}

export const IDLE_JOB: JobState = { running: false, done: 0, total: 0, label: "", failed: 0 };
export const UNDO_LIMIT = 40;

/**
 * How many rows the first paint reads before showing anything.
 *
 * Sized to comfortably exceed a screenful at the largest card size on the widest display,
 * so the user never sees the grid end at a boundary that is an artefact of loading. The
 * remainder follows immediately; this is a head start, not a page size.
 */
export const FIRST_PAINT_ROWS = 240;
/** Meta key recording that old word tags have been replaced with topic tags. */
export const TOPIC_TAGS_MIGRATION = "migration:topic-tags";

/**
 * Batch sizes for user-initiated jobs.
 *
 * Larger than the background pipeline's, because somebody is watching these and the
 * politeness budget can be spent on the thing they asked for.
 */
export const JOB_CAPTURE_BATCH = 6;
export const JOB_ENRICH_BATCH = 6;
export const JOB_HEALTH_BATCH = 40;

/**
 * An undoable change: the previous version of every row it touched, plus the ids of rows
 * that did not exist before (which undo removes).
 *
 * `before` is a *diff*, not a row. Complete `Bookmark` objects are the obvious
 * implementation and quietly enormous — a bookmark carries an embedded base64 favicon and
 * a scraped text blob, so one entry for a whole-import delete of 5,000 rows put hundreds
 * of megabytes on a stack that holds forty of them. Deletions are the exception and carry
 * the whole row, because there is nothing left to patch.
 */
export type Patch =
  | { id: string; fields: Partial<Bookmark>; whole?: undefined }
  | { id: string; whole: Bookmark; fields?: undefined };

export interface Mutation {
  label: string;
  before: Patch[];
  createdIds: string[];
}

/**
 * Fields that differ between two versions of a row.
 *
 * Compared by reference for objects and arrays rather than deeply: every mutation path
 * here produces new objects for the parts it changes and reuses the parts it does not —
 * which is what makes the memoised cards work at all — so reference equality is both
 * correct and cheap. `undefined` is written explicitly for a field that was present and is
 * now gone, because a patch that merely omits it would leave the current value in place,
 * which is how an "undo archive" quietly fails to un-archive anything.
 */
export function diffRow(before: Bookmark, after: Bookmark): Partial<Bookmark> {
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const left = (before as unknown as Record<string, unknown>)[key];
    const right = (after as unknown as Record<string, unknown>)[key];
    if (left !== right) patch[key] = left;
  }
  return patch as Partial<Bookmark>;
}

export function applyPatch(current: Bookmark | undefined, patch: Patch): Bookmark | null {
  if (patch.whole) return patch.whole;
  if (!current) return null;
  return { ...current, ...patch.fields };
}

/**
 * Saves rows, then tells other tabs.
 *
 * The notice used to go out the moment the write was *started*. The other tab re-read the
 * database at once, often before the write had landed, and missed the new rows until it
 * was reloaded. Announcing after the write completes makes the other tab's read see it.
 * A failed write is already tracked and retried by `writeKeyed`, so it is not announced:
 * there is nothing new on disk for another tab to read.
 */
/**
 * Marks rows as changed by the person just now. The other copy of the library (website or
 * extension) uses it to keep the person's latest decision when both changed a row.
 */
export function touched(rows: Bookmark[]): Bookmark[] {
  const at = Date.now();
  return rows.map((row) => ({ ...row, changedAt: at }));
}

export function persistAndAnnounce(next: Bookmark[], remove: string[]): void {
  const writes: Promise<void>[] = [];
  if (next.length) writes.push(db.putBookmarks(next));
  if (remove.length) writes.push(db.deleteBookmarks(remove));
  if (!writes.length) return;
  void Promise.all(writes)
    .then(() => announceCommit({ changed: next.map((row) => row.id), removed: remove }))
    .catch(() => {
      // Reported through the write-health banner; see `db.writeKeyed`.
    });
}

