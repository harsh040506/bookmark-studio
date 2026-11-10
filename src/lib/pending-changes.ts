/**
 * Changes that have arrived from outside and are waiting to be applied together.
 *
 * The browser reports one event per bookmark. Its own sync signing in on a new device, a
 * folder dragged in the bookmark manager or another extension tidying up can each deliver
 * thousands in a burst. Applying them one at a time meant rebuilding the library's index,
 * redrawing and opening a database transaction for every single one, so they are collected
 * here and applied in one step a moment later (`hooks/library/browser-sync.ts`).
 *
 * A change to an existing record is kept as *what changed*, not as a whole record, and is
 * applied to the record as it is when the batch is taken. A whole record built when the
 * event arrived would overwrite anything the person did to it in between.
 */
export class PendingChanges<T extends { id: string }> {
  private created = new Map<string, T>();
  private patches = new Map<string, Partial<T>>();
  private removed = new Set<string>();

  get empty(): boolean {
    return !this.created.size && !this.patches.size && !this.removed.size;
  }

  /** A record that did not exist before. */
  create(record: T): void {
    this.removed.delete(record.id);
    this.created.set(record.id, record);
  }

  /** Fields of an existing record that changed. Later changes to a field win. */
  patch(id: string, patch: Partial<T>): void {
    this.patches.set(id, { ...this.patches.get(id), ...patch });
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) {
      this.created.delete(id);
      this.patches.delete(id);
      this.removed.add(id);
    }
  }

  /**
   * One record as it will be once the waiting changes are applied.
   *
   * @param stored Looks a record up in what has already been applied.
   */
  find(id: string, stored: (id: string) => T | undefined): T | undefined {
    if (this.removed.has(id)) return undefined;
    const base = stored(id) ?? this.created.get(id);
    const patch = this.patches.get(id);
    return base && patch ? { ...base, ...patch } : base;
  }

  /**
   * Takes everything waiting, as records to write and ids to delete, and starts again empty.
   *
   * A created record that is already stored is not written again: the app made it itself,
   * and its own copy (with the folder, tags and title the person chose) is the better one.
   * Changes reported for it since are still applied. A change or removal for a record that
   * is not stored is dropped, because there is nothing for it to apply to.
   */
  take(stored: (id: string) => T | undefined): { upserts: T[]; removals: string[] } {
    const { created, patches, removed } = this;
    this.created = new Map();
    this.patches = new Map();
    this.removed = new Set();

    const upserts: T[] = [];
    for (const [id, record] of created) {
      if (removed.has(id) || stored(id)) continue;
      upserts.push({ ...record, ...patches.get(id) });
    }
    for (const [id, patch] of patches) {
      if (removed.has(id)) continue;
      const current = stored(id);
      if (current) upserts.push({ ...current, ...patch });
    }
    const removals = [...removed].filter((id) => stored(id) !== undefined);
    return { upserts, removals };
  }
}
