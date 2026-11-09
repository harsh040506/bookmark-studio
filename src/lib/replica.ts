/**
 * One library, two copies: the rules for merging the website's and the extension's.
 *
 * A browser gives a website and an extension separate storage, so each keeps a full copy
 * of the library. While they are connected, each sends the other the rows it changed
 * (`replication.ts` drives that, `db.ts` reads and writes them). This module decides what
 * happens when a row arrives. It is pure, so every rule is tested without a database.
 *
 * ## Who wins
 *
 * Each stored row carries a stamp: when it was last written, and by which copy. The newer
 * stamp wins, with the copy's id breaking ties, so both sides always reach the same answer.
 *
 * Newest-write-wins alone would lose edits. Both copies read pages in the background, so a
 * page read finishing on one side seconds after a tag was added on the other would carry
 * the row without the tag. So the fields a person decides (tags, folder, favourite, trash,
 * notes, a hand-written title) follow `changedAt`, the person's last change, while the
 * fields background work fills in follow the newer write.
 *
 * Screenshots and offline copies are files kept by the copy that made them. A row from the
 * other side keeps this side's own claims about those files, so a card never points at a
 * picture this side does not have, and this side still takes its own when it wants one.
 */
import type { Bookmark, Board, Folder, ImportBatch, SmartCollection, Source } from "../../shared/types";
import { sameValue } from "./rebase";

/** When a stored record was last written, and by which copy of the library. */
export interface Stamp {
  at: number;
  by: string;
}

/** The small stores, copied whole record by record. */
export type ShellStore = "folders" | "boards" | "imports" | "sources" | "smart";
export const SHELL_STORES: readonly ShellStore[] = ["folders", "boards", "imports", "sources", "smart"];
export type ShellRecord = Folder | Board | ImportBatch | Source | SmartCollection;

export interface StampedRow {
  row: Bookmark;
  stamp: Stamp;
}
export interface Tombstone {
  store: "bookmarks" | ShellStore;
  id: string;
  at: number;
  by: string;
}
export interface StampedRecord {
  store: ShellStore;
  record: ShellRecord;
  stamp: Stamp;
}

/** One page of changes, in either direction. */
export interface ChangeBatch {
  rows: StampedRow[];
  tombstones: Tombstone[];
  shell: StampedRecord[];
}

/**
 * Where a reader has got to in another copy's changes.
 *
 * The first contact reads every row in key order (`scan`), because rows written before
 * stamps existed are not in the stamp index. After that, only rows written since.
 */
export type ReplicaCursor =
  | { phase: "scan"; after: string; startedAt: number }
  | { phase: "index"; row: [number, string]; tomb: [number, string]; shellAt: number };

/** How far before a full read started to look again, for writes that were in flight. */
export const SCAN_OVERLAP_MS = 5_000;

export function newer(a: Stamp, b: Stamp | undefined): boolean {
  if (!b) return true;
  if (a.at !== b.at) return a.at > b.at;
  return a.by > b.by;
}

/** Only rows that point at a web page travel: an uploaded file's bytes stay where it was added. */
export function isReplicable(row: Bookmark): boolean {
  return !row.media && /^(https?|ftp):\/\//i.test(row.url);
}

/** Fields a person decides. They follow whoever changed the row last by hand. */
const PERSON_FIELDS = [
  "title",
  "url",
  "domain",
  "description",
  "note",
  "alt",
  "tags",
  "derivedTags",
  "category",
  "folderId",
  "boardIds",
  "favorite",
  "archived",
  "trashedAt",
  "highlights",
  "editedAt",
  "changedAt",
  "kind",
  "sourceOrder",
] as const satisfies readonly (keyof Bookmark)[];

/** Without the parts that describe files only this copy has. */
function portable(row: Bookmark): Bookmark {
  const { offline: _offline, ...rest } = row;
  const { shotAt: _shotAt, shotDevice: _shotDevice, ...preview } = row.preview;
  return { ...rest, preview };
}

/** Puts this copy's own screenshot and offline-copy claims back onto a row. */
function withLocalFiles(row: Bookmark, local: Bookmark | undefined): Bookmark {
  const next = portable(row);
  if (local?.preview.shotAt !== undefined) next.preview.shotAt = local.preview.shotAt;
  if (local?.preview.shotDevice !== undefined) next.preview.shotDevice = local.preview.shotDevice;
  if (local?.offline) next.offline = local.offline;
  return next;
}

export type RowDecision =
  /** Nothing to write: this side already holds the answer. */
  | { action: "keep" }
  /** Write the arriving row under its own stamp. */
  | { action: "take"; row: Bookmark }
  /** Write a blend of both under a new local stamp, so the other side learns it too. */
  | { action: "blend"; row: Bookmark };

/**
 * What to do with a row that arrived from the other copy.
 *
 * `tombstone` is this side's record of having deleted the row, if it did.
 */
export function decideRow(
  local: { row: Bookmark; stamp: Stamp } | undefined,
  incoming: StampedRow,
  tombstone?: { at: number },
): RowDecision {
  if (tombstone && tombstone.at >= incoming.stamp.at) return { action: "keep" };
  if (!local) return { action: "take", row: withLocalFiles(incoming.row, undefined) };

  const incomingWins = newer(incoming.stamp, local.stamp);
  const winner = incomingWins ? incoming.row : local.row;
  const localChange = local.row.changedAt ?? 0;
  const incomingChange = incoming.row.changedAt ?? 0;
  const person = incomingChange > localChange ? incoming.row : localChange > incomingChange ? local.row : winner;

  const merged = { ...winner } as Record<string, unknown>;
  for (const field of PERSON_FIELDS) {
    const value = (person as unknown as Record<string, unknown>)[field];
    if (value === undefined) delete merged[field];
    else merged[field] = value;
  }
  // A description the page read filled in while the person was busy with something else
  // (a tag, a move) is kept, unless the person wrote one by hand.
  if (person !== winner && !merged.description && winner.description && (person.editedAt ?? 0) <= (winner.editedAt ?? 0)) {
    merged.description = winner.description;
  }
  const result = withLocalFiles(merged as unknown as Bookmark, local.row);

  if (sameValue(portable(result), portable(local.row))) return { action: "keep" };
  if (sameValue(portable(result), portable(incoming.row))) return { action: "take", row: result };
  return { action: "blend", row: result };
}

/**
 * Two separate imports of the same page, met for the first time.
 *
 * Neither copy is a later version of the other, so "newest wins" would throw away
 * whichever copy happened to be written a moment earlier, tags and all. Instead the two
 * are combined: tags and boards joined, a favourite or a note kept from either side.
 */
export function mergeSameAddress(local: { row: Bookmark; stamp: Stamp }, incoming: StampedRow, id: string): Bookmark {
  const [first, second] = newer(incoming.stamp, local.stamp) ? [incoming.row, local.row] : [local.row, incoming.row];
  const union = (a: string[] | undefined, b: string[] | undefined) => {
    const all = [...new Set([...(a ?? []), ...(b ?? [])])];
    return all.length ? all : undefined;
  };
  const merged: Bookmark = {
    ...second,
    ...first,
    id,
    tags: union(first.tags, second.tags) ?? [],
    derivedTags: union(first.derivedTags, second.derivedTags),
    boardIds: union(first.boardIds, second.boardIds) ?? [],
    description: first.description || second.description,
    note: first.note ?? second.note,
    favorite: first.favorite || second.favorite || undefined,
    folderId: first.folderId ?? second.folderId,
    changedAt: Math.max(first.changedAt ?? 0, second.changedAt ?? 0) || undefined,
  };
  for (const key of Object.keys(merged) as (keyof Bookmark)[]) if (merged[key] === undefined) delete merged[key];
  return withLocalFiles(merged, local.row);
}

/** Folders, boards and the like are small and edited one at a time: the newer write wins. */
export function decideRecord(
  local: { stamp: Stamp } | undefined,
  incoming: StampedRecord,
  tombstone?: { at: number },
): boolean {
  if (tombstone && tombstone.at >= incoming.stamp.at) return false;
  return newer(incoming.stamp, local?.stamp);
}

/** Whether a deletion from the other side should remove this side's row. */
export function decideTombstone(local: { stamp: Stamp } | undefined, tombstone: Tombstone): boolean {
  return Boolean(local) && tombstone.at >= (local?.stamp.at ?? 0);
}

/* --------------------------------------------------------------- validation */

const MAX_BATCH = 2_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

function readStamp(raw: unknown, fallbackBy: string): Stamp | null {
  if (!isRecord(raw)) return null;
  const at = raw.at;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return null;
  return { at, by: isId(raw.by) ? raw.by : fallbackBy };
}

/**
 * Checks a batch that came over the bridge. The other side is this person's own app, but
 * a page the extension serves could be tampered with, so nothing is trusted: anything
 * malformed is dropped rather than written, and rows must point at an ordinary web page.
 * `repair` is the same row repair used for every stored record.
 */
export function readBatch(
  raw: unknown,
  sender: string,
  repair: (row: unknown) => Bookmark | null,
): ChangeBatch {
  const batch: ChangeBatch = { rows: [], tombstones: [], shell: [] };
  if (!isRecord(raw)) return batch;
  const list = (value: unknown) => (Array.isArray(value) ? value.slice(0, MAX_BATCH) : []);

  for (const entry of list(raw.rows)) {
    if (!isRecord(entry)) continue;
    const stamp = readStamp(entry.stamp, sender);
    const row = stamp ? repair(structuredClone(entry.row)) : null;
    if (stamp && row && isReplicable(row)) batch.rows.push({ row, stamp });
  }
  for (const entry of list(raw.tombstones)) {
    if (!isRecord(entry) || !isId(entry.id)) continue;
    const store = entry.store;
    if (store !== "bookmarks" && !SHELL_STORES.includes(store as ShellStore)) continue;
    const stamp = readStamp(entry, sender);
    if (stamp) batch.tombstones.push({ store: store as Tombstone["store"], id: entry.id, at: stamp.at, by: stamp.by });
  }
  for (const entry of list(raw.shell)) {
    if (!isRecord(entry) || !SHELL_STORES.includes(entry.store as ShellStore)) continue;
    const stamp = readStamp(entry.stamp, sender);
    if (!stamp || !isRecord(entry.record) || !isId(entry.record.id)) continue;
    batch.shell.push({ store: entry.store as ShellStore, record: structuredClone(entry.record) as unknown as ShellRecord, stamp });
  }
  return batch;
}

/** Validates a cursor that came back over the bridge; anything odd starts a fresh read. */
export function readCursor(raw: unknown): ReplicaCursor | null {
  if (!isRecord(raw)) return null;
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const key = (value: unknown): value is [number, string] =>
    Array.isArray(value) && value.length === 2 && finite(value[0]) && typeof value[1] === "string";
  if (raw.phase === "scan" && typeof raw.after === "string" && finite(raw.startedAt)) {
    return { phase: "scan", after: raw.after, startedAt: raw.startedAt as number };
  }
  if (raw.phase === "index" && key(raw.row) && key(raw.tomb) && finite(raw.shellAt)) {
    return { phase: "index", row: raw.row, tomb: raw.tomb, shellAt: raw.shellAt as number };
  }
  return null;
}
