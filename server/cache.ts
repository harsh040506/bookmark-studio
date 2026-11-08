/**
 * Bounded, time-to-live caches for the API layer.
 *
 * Every cache in this server keys on a URL supplied by the client, so an unbounded
 * `Map` is a memory leak with a user-controlled growth rate: sweeping a 5,000-bookmark
 * library populates 5,000 entries that are never released, and nothing in the process
 * ever evicts them. Each cache therefore carries both a TTL (staleness) and a hard
 * entry ceiling (memory), and evicts insertion-oldest-first when the ceiling is hit.
 *
 * Insertion order is a deliberate choice over true LRU. A strict LRU needs a touch on
 * every read, which turns cache hits into writes and buys very little here: these
 * caches exist to collapse the repeated passes of a single sweep, and a sweep touches
 * each URL a handful of times within one TTL window.
 */

export interface CacheOptions {
  /** How long an entry stays fresh, in milliseconds. */
  ttlMs: number;
  /** Hard ceiling on retained entries; the oldest are dropped past it. */
  maxEntries: number;
}

interface Entry<T> {
  value: T;
  at: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly options: CacheOptions) {}

  /**
   * Returns the cached value, or `null` when absent or stale.
   * A stale entry is deleted on read so it cannot linger against the entry ceiling.
   */
  get(key: string): T | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.options.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    // Re-inserting must refresh position in the eviction order, not just the payload.
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });

    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Collapses concurrent calls for the same key onto one in-flight promise.
 *
 * Without this, a batch containing the same URL twice — or two clients checking the
 * same library at once — issues duplicate outbound requests to somebody else's server
 * for an answer already on its way. The entry is removed as soon as the work settles,
 * so failures are never cached here; that decision belongs to the TTL cache.
 */
export class SingleFlight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = work().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.pending.size;
  }
}
