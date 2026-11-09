/**
 * Folding a slow background result into a row that may have moved on.
 *
 * ## The bug this exists for
 *
 * A page read, a screenshot and a link check each start from a copy of the bookmark and
 * finish seconds later. Writing that copy back whole replaced everything that happened in
 * between: a screenshot that landed during a page read was erased when the read finished,
 * so the row looked uncaptured and was queued again, and again. The background queue
 * never finished ("filling in 1,292" forever), and a title edited while a read was in
 * flight was silently reverted.
 *
 * So a background result is applied as a three-way merge. `before` is the copy the work
 * started from, `after` is what the work produced, `latest` is the row as it is now. Only
 * the fields the work changed are applied, one level deep into nested records such as
 * `preview` or `health`; a field that also changed in `latest` since `before` keeps the
 * newer value, because that change is the more recent statement of intent.
 */
import type { Bookmark, DeviceName } from "../../shared/types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality for the JSON-shaped values bookmarks hold. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!sameValue(a[key], b[key])) return false;
    return true;
  }
  return false;
}

function mergeRecord(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  latest: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...latest };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const was = before[key];
    const made = after[key];
    if (sameValue(was, made)) continue; // the work did not touch it
    const now = latest[key];
    if (sameValue(was, now)) {
      // Nobody else touched it: the work's value stands.
      if (made === undefined) delete out[key];
      else out[key] = made;
      continue;
    }
    // Both changed it. Nested records merge field by field; anything else keeps `latest`.
    if (depth > 0 && isPlainObject(was) && isPlainObject(made) && isPlainObject(now)) {
      out[key] = mergeRecord(was, made, now, depth - 1);
    }
  }
  return out;
}

/**
 * The row to write, or `null` when the row no longer exists and the result should be
 * dropped: a deleted bookmark must not come back because a read of it finished late.
 */
export function rebaseRow(before: Bookmark, after: Bookmark, latest: Bookmark | undefined): Bookmark | null {
  if (!latest) return null;
  if (latest.id !== after.id) return null;
  return mergeRecord(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    latest as unknown as Record<string, unknown>,
    1,
  ) as unknown as Bookmark;
}

/**
 * The rows a batch of finished screenshots should mark, as before/after pairs.
 *
 * Every bookmark whose URL was captured, not just the rows that were asked about. The
 * picture is stored per URL, so two bookmarks of one page share it; marking only one
 * left the other looking uncaptured, and it was captured again on every pass, forever.
 */
export function captureResultPairs(
  library: Bookmark[],
  results: { url: string; ok: boolean; capturedAt?: number }[],
  device: DeviceName,
  now = Date.now(),
): { before: Bookmark; after: Bookmark }[] {
  const outcomeByUrl = new Map(results.filter((result) => result.ok).map((result) => [result.url, result]));
  if (!outcomeByUrl.size) return [];
  const pairs: { before: Bookmark; after: Bookmark }[] = [];
  for (const row of library) {
    const outcome = outcomeByUrl.get(row.url);
    if (!outcome) continue;
    pairs.push({
      before: row,
      after: {
        ...row,
        preview: {
          ...row.preview,
          method: "screenshot",
          shotAt: outcome.capturedAt ?? now,
          // Recorded, not assumed: the grid reads this back to decide whether the picture
          // it is about to ask for actually exists.
          shotDevice: device,
        },
      },
    });
  }
  return pairs;
}
