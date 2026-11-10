/**
 * Repairs what comes back out of storage before the app relies on it.
 *
 * Everything in IndexedDB was written by *some* version of this app, but not necessarily
 * this one, and a disk, a browser bug or a hand-edited backup can leave a record that does
 * not match today's types. The app reads those records with `.map`, `.length` and property
 * access everywhere, so one row with `tags: null` used to be enough to crash every page load,
 * which reads to the person exactly like losing their library.
 *
 * The rule here is "keep the data, fix the shape": a field with the wrong type falls back
 * to a safe default, and a record is only dropped when it has no usable id at all (there is
 * nothing to show or address it by). Every repair is counted so it can be logged once.
 */
import { DEFAULT_SETTINGS, type Bookmark, type Folder, type Settings } from "../../shared/types";

export interface RepairReport {
  repaired: number;
  dropped: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** Returns a well-formed bookmark, or `null` when the record cannot be identified. */
export function repairBookmark(raw: unknown, report?: RepairReport): Bookmark | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) {
    if (report) report.dropped += 1;
    return null;
  }
  const row = raw as unknown as Bookmark;
  let changed = false;
  const fix = <K extends keyof Bookmark>(key: K, value: Bookmark[K]) => {
    if (row[key] !== value) {
      (row as unknown as Record<string, unknown>)[key as string] = value;
      changed = true;
    }
  };

  if (typeof raw.url !== "string") fix("url", "");
  if (typeof raw.title !== "string") fix("title", text(raw.url) || "Untitled");
  if (typeof raw.domain !== "string") fix("domain", "");
  if (typeof raw.description !== "string") fix("description", "");
  if (typeof raw.category !== "string") fix("category", "Other");
  if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string")) fix("tags", strings(raw.tags));
  if (!Array.isArray(raw.boardIds) || raw.boardIds.some((id) => typeof id !== "string")) {
    fix("boardIds", strings(raw.boardIds));
  }
  if (raw.folderId !== null && typeof raw.folderId !== "string") fix("folderId", null);
  if (typeof raw.addedAt !== "number" || !Number.isFinite(raw.addedAt)) fix("addedAt", finite(raw.importedAt, 0));
  if (typeof raw.visitCount !== "number" || !Number.isFinite(raw.visitCount)) fix("visitCount", 0);
  if (!isRecord(raw.health) || typeof raw.health.status !== "string") fix("health", { status: "unchecked" });
  if (!isRecord(raw.preview) || typeof raw.preview.method !== "string") {
    fix("preview", { ...(isRecord(raw.preview) ? raw.preview : {}), method: "card" } as Bookmark["preview"]);
  }
  if (raw.derivedTags !== undefined && !Array.isArray(raw.derivedTags)) fix("derivedTags", undefined);
  // A bad stamp would win or lose every merge with the other copy of the library.
  if (raw.changedAt !== undefined && (typeof raw.changedAt !== "number" || !Number.isFinite(raw.changedAt))) {
    fix("changedAt", undefined);
  }

  if (changed && report) report.repaired += 1;
  return row;
}

/**
 * Repairs folders, including the tree itself.
 *
 * A folder whose parent no longer exists, or two folders that name each other as parent,
 * are invisible in a tree drawn from the root down, along with every bookmark filed in
 * them. Such folders are moved to the top level, where they can be seen and tidied.
 */
export function repairFolders(raw: unknown[], report?: RepairReport): Folder[] {
  const folders: Folder[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) {
      if (report) report.dropped += 1;
      continue;
    }
    const folder = entry as unknown as Folder;
    let changed = false;
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      folder.name = "Untitled folder";
      changed = true;
    }
    if (entry.parentId !== null && typeof entry.parentId !== "string") {
      folder.parentId = null;
      changed = true;
    }
    if (typeof entry.addedAt !== "number" || !Number.isFinite(entry.addedAt)) {
      folder.addedAt = 0;
      changed = true;
    }
    if (changed && report) report.repaired += 1;
    folders.push(folder);
  }

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    if (folder.parentId === null) continue;
    if (!byId.has(folder.parentId) || folder.parentId === folder.id) {
      folder.parentId = null;
      if (report) report.repaired += 1;
    }
  }

  /*
    Loops, found in one pass. Each folder is walked up from at most once: a folder already
    known to reach the top ends the walk. Walking the whole chain again for every folder was
    quadratic, which a damaged backup with one very long chain turned into seconds on every
    page load.
  */
  const settled = new Set<string>();
  for (const start of folders) {
    if (settled.has(start.id)) continue;
    const chain: Folder[] = [];
    const onChain = new Set<string>();
    let cursor: Folder | undefined = start;
    while (cursor && !settled.has(cursor.id)) {
      if (onChain.has(cursor.id)) {
        // The last folder walked points back into this chain: cut the loop there.
        const last = chain[chain.length - 1];
        last.parentId = null;
        if (report) report.repaired += 1;
        break;
      }
      chain.push(cursor);
      onChain.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    for (const folder of chain) settled.add(folder.id);
  }
  return folders;
}

/**
 * Settings merged over the defaults, keeping only stored values of the right type.
 *
 * A stored `assetBudgetMb: "abc"` or `NaN` would otherwise flow straight into arithmetic
 * and quietly disable eviction, and a wrong-typed switch would render as the wrong state.
 */
const ALLOWED_SETTING_VALUES: Record<string, string[]> = {
  previewDevice: ["desktop", "tablet", "mobile"],
  lookalikeStrength: ["broad", "balanced", "strict"],
};

export function repairSettings(stored: unknown): Settings {
  const result: Settings = { ...DEFAULT_SETTINGS };
  if (!isRecord(stored)) return result;
  const target = result as unknown as Record<string, unknown>;
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const value = stored[key];
    if (value === undefined) continue;
    if (typeof fallback === "number") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) target[key] = value;
    } else if (typeof value === typeof fallback && !(Array.isArray(fallback) && !Array.isArray(value))) {
      target[key] = value;
    }
  }
  // A string of the right type can still be a value nothing understands.
  for (const [key, allowed] of Object.entries(ALLOWED_SETTING_VALUES)) {
    if (!allowed.includes(target[key] as string)) target[key] = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
  }
  // Keys the defaults do not know are kept, so settings written by a newer version survive
  // a visit from an older one.
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in DEFAULT_SETTINGS)) target[key] = value;
  }
  return result;
}
