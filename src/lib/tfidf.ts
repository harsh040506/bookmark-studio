/**
 * A small TF-IDF vector-space index.
 *
 * This is what powers "find similar" and relevance ranking. It is the honest,
 * classical alternative to embeddings: no API, no model, no network — just term
 * statistics over the library, rebuilt in milliseconds for thousands of bookmarks.
 *
 * ## Why it is incremental
 *
 * It used to be immutable: every change that touched indexed text threw the whole index
 * away and built a new one from every document in the library. That is linear in library
 * size, it ran on the main thread, and it ran from eight different places — favouriting
 * nothing, but editing one title, importing one file, or undoing one delete all paid the
 * same full price. Measured at ~25 ms for 1,200 rows, which is a dropped frame per edit
 * and several seconds on a library ten times that.
 *
 * So the index now takes writes. `add`, `remove` and `update` touch only the postings of
 * the terms actually involved, and a full rebuild is reserved for the two cases that
 * genuinely replace the corpus — import and restore.
 *
 * ## What that costs, and where it is paid
 *
 * Document frequency changes when a document is added or removed, and every weight in
 * the index is derived from it. Recomputing them all on each write would put the cost
 * straight back, so nothing is recomputed on write at all: the index stores raw term
 * counts, and the normalising factor for a document is computed the first time somebody
 * asks about that document and cached until the corpus changes underneath it.
 *
 * The effect is that the work is proportional to what is *read* rather than to what is
 * *stored*. A search touches the few hundred documents that share a term with the query;
 * a library of fifty thousand that nobody searched pays nothing.
 */

export interface IndexDoc {
  id: string;
  /** Already tokenised and stemmed. Repeat a term to weight it higher. */
  terms: string[];
}

export interface Scored {
  id: string;
  score: number;
}

/**
 * One document as distinct terms plus their counts.
 *
 * The shape the worker sends back. Deliberately not `IndexDoc`: a document with a
 * thousand-word body serialises as a thousand strings in that form and as a few hundred
 * in this one, and the crossing is the expensive part of using a worker at all.
 */
export interface CountedDoc {
  id: string;
  terms: string[];
  counts: number[];
}

export class TfIdfIndex {
  /** Raw term counts per document — the only thing written on an update. */
  private readonly frequencies = new Map<string, Map<string, number>>();
  private readonly documentFrequency = new Map<string, number>();
  private readonly inverted = new Map<string, Set<string>>();

  /**
   * Cached L2 norms, and the corpus generation each was computed against.
   *
   * Held apart from the frequencies because they are derived and disposable: anything in
   * here can be thrown away at any time and recomputed from the counts, which is what
   * makes invalidation a single integer rather than a dependency graph.
   */
  private readonly norms = new Map<string, { generation: number; value: number }>();
  private readonly vectorCache = new Map<string, { generation: number; value: Map<string, number> }>();

  /**
   * Bumped whenever document frequency or corpus size changes.
   *
   * Every derived value is stamped with the generation it was computed under, so a stale
   * cache entry is detected by comparing two numbers rather than by tracking which
   * documents a given write could possibly have affected — which is, transitively, all of
   * them, since corpus size appears in every idf.
   */
  private generation = 0;

  constructor(docs: IndexDoc[] = []) {
    for (const doc of docs) this.write(doc);
    // One bump for the whole build rather than one per document: nothing can have read a
    // cached value yet, so the intermediate generations would be invalidating nothing.
    this.generation += 1;
  }

  get size(): number {
    return this.frequencies.size;
  }

  /**
   * Builds from pre-counted documents, as produced off the main thread.
   *
   * The counting is the linear pass; postings and document frequencies are a second,
   * much cheaper one over distinct terms only. Splitting them at this seam is what lets
   * the expensive half happen in a worker while the half that must own the final object
   * stays here.
   */
  static fromCounts(docs: CountedDoc[]): TfIdfIndex {
    const index = new TfIdfIndex();
    for (const doc of docs) index.writeCounts(doc);
    index.generation += 1;
    return index;
  }

  private writeCounts(doc: CountedDoc): void {
    const counts = new Map<string, number>();
    for (let position = 0; position < doc.terms.length; position += 1) {
      counts.set(doc.terms[position], doc.counts[position] ?? 1);
    }
    this.frequencies.set(doc.id, counts);
    for (const term of counts.keys()) {
      this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      let postings = this.inverted.get(term);
      if (!postings) {
        postings = new Set();
        this.inverted.set(term, postings);
      }
      postings.add(doc.id);
    }
  }

  /* --------------------------------------------------------------- writes */

  /**
   * Adds or replaces one document.
   *
   * Replacement is expressed as remove-then-write rather than as a diff of the two term
   * sets. The diff is the obvious optimisation and it is not worth it here: a document is
   * a few dozen distinct terms, the postings are sets, and the bookkeeping to get an
   * in-place update right — a term that dropped to zero must leave the postings, or
   * `similar` starts proposing candidates that share nothing — is where the bugs live.
   */
  add(doc: IndexDoc): void {
    if (this.frequencies.has(doc.id)) this.unwrite(doc.id);
    this.write(doc);
    this.generation += 1;
  }

  /** Alias for {@link add}, for call sites where replacing reads better than adding. */
  update(doc: IndexDoc): void {
    this.add(doc);
  }

  remove(id: string): void {
    if (!this.frequencies.has(id)) return;
    this.unwrite(id);
    this.generation += 1;
  }

  /**
   * Applies many changes with a single invalidation.
   *
   * A batch of five hundred edits should cost one generation bump, not five hundred —
   * each bump throws away every cached norm, so bumping per document inside a loop turns
   * a linear write into a quadratic read for whoever queries next.
   */
  bulk(changes: { add?: IndexDoc[]; remove?: string[] }): void {
    for (const id of changes.remove ?? []) {
      if (this.frequencies.has(id)) this.unwrite(id);
    }
    for (const doc of changes.add ?? []) {
      if (this.frequencies.has(doc.id)) this.unwrite(doc.id);
      this.write(doc);
    }
    this.generation += 1;
  }

  private write(doc: IndexDoc): void {
    const counts = new Map<string, number>();
    for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    this.frequencies.set(doc.id, counts);

    for (const term of counts.keys()) {
      this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      let postings = this.inverted.get(term);
      if (!postings) {
        postings = new Set();
        this.inverted.set(term, postings);
      }
      postings.add(doc.id);
    }
  }

  private unwrite(id: string): void {
    const counts = this.frequencies.get(id);
    if (!counts) return;
    for (const term of counts.keys()) {
      const frequency = (this.documentFrequency.get(term) ?? 1) - 1;
      if (frequency <= 0) {
        // The last document carrying this term has gone. Dropping the entries rather than
        // leaving them at zero is what keeps `vocabulary()` honest: a spelling corrector
        // offering a word no document contains sends every search that accepts the
        // suggestion to an empty result.
        this.documentFrequency.delete(term);
        this.inverted.delete(term);
      } else {
        this.documentFrequency.set(term, frequency);
        this.inverted.get(term)?.delete(id);
      }
    }
    this.frequencies.delete(id);
    this.norms.delete(id);
    this.vectorCache.delete(id);
  }

  /* ---------------------------------------------------------- arithmetic */

  private idf(term: string): number {
    const frequency = this.documentFrequency.get(term) ?? 0;
    if (!frequency) return 0;
    // Smoothed inverse document frequency.
    return Math.log((this.size + 1) / (frequency + 0.5));
  }

  /** Unnormalised weight of one term in one document. */
  private weight(count: number, term: string): number {
    return (1 + Math.log(count)) * this.idf(term);
  }

  /**
   * The L2 norm of a document's weight vector, computed once per corpus generation.
   *
   * This is the whole reason writes are cheap: it is the only quantity that depends on
   * every other document, and deferring it means a write never has to visit them.
   */
  private norm(id: string): number {
    const cached = this.norms.get(id);
    if (cached && cached.generation === this.generation) return cached.value;

    const counts = this.frequencies.get(id);
    if (!counts) return 1;
    let total = 0;
    for (const [term, count] of counts) {
      const weight = this.weight(count, term);
      if (weight > 0) total += weight * weight;
    }
    const value = Math.sqrt(total) || 1;
    this.norms.set(id, { generation: this.generation, value });
    return value;
  }

  /** The full normalised vector, for the pairwise comparison `similar` needs. */
  private vector(id: string): Map<string, number> | undefined {
    const cached = this.vectorCache.get(id);
    if (cached && cached.generation === this.generation) return cached.value;

    const counts = this.frequencies.get(id);
    if (!counts) return undefined;
    const norm = this.norm(id);
    const value = new Map<string, number>();
    for (const [term, count] of counts) {
      const weight = this.weight(count, term);
      if (weight > 0) value.set(term, weight / norm);
    }
    this.vectorCache.set(id, { generation: this.generation, value });
    return value;
  }

  /* ---------------------------------------------------------------- reads */

  /** Documents containing at least one query term, ranked by cosine similarity. */
  search(queryTerms: string[], limit = 500): Scored[] {
    if (!queryTerms.length) return [];

    const queryVector = new Map<string, number>();
    let norm = 0;
    for (const term of queryTerms) {
      const weight = this.idf(term);
      if (weight <= 0) continue;
      queryVector.set(term, (queryVector.get(term) ?? 0) + weight);
    }
    for (const weight of queryVector.values()) norm += weight * weight;
    norm = Math.sqrt(norm) || 1;

    const scores = new Map<string, number>();
    for (const [term, queryWeight] of queryVector) {
      const postings = this.inverted.get(term);
      if (!postings) continue;
      const normalisedQueryWeight = queryWeight / norm;
      for (const id of postings) {
        const count = this.frequencies.get(id)?.get(term);
        if (!count) continue;
        const documentWeight = this.weight(count, term) / this.norm(id);
        scores.set(id, (scores.get(id) ?? 0) + documentWeight * normalisedQueryWeight);
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Nearest neighbours of a document — the "find similar" feature. */
  similar(id: string, limit = 6): Scored[] {
    const vector = this.vector(id);
    if (!vector) return [];

    // Only documents sharing a term can have non-zero cosine similarity.
    const candidates = new Set<string>();
    for (const term of vector.keys()) {
      for (const other of this.inverted.get(term) ?? []) {
        if (other !== id) candidates.add(other);
      }
    }

    const scored: Scored[] = [];
    for (const candidate of candidates) {
      const other = this.vector(candidate);
      if (!other) continue;
      // Iterate the smaller vector for the dot product.
      const [small, large] = vector.size < other.size ? [vector, other] : [other, vector];
      let score = 0;
      for (const [term, weight] of small) {
        const counterpart = large.get(term);
        if (counterpart) score += weight * counterpart;
      }
      if (score > 0) scored.push({ id: candidate, score });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** The terms that most distinguish this document — used to suggest tags. */
  topTerms(id: string, limit = 5): string[] {
    const vector = this.vector(id);
    if (!vector) return [];
    return [...vector.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([term]) => term);
  }

  has(id: string): boolean {
    return this.frequencies.has(id);
  }

  /**
   * Every term the index knows, for spelling correction.
   *
   * The vocabulary a query is corrected against has to be *this library's* words rather
   * than a dictionary: correcting "figmna" to "figma" is only right because the user
   * saved Figma, and a general dictionary would neither know that nor leave alone the
   * hundreds of product names, handles and stems that are not words at all.
   */
  vocabulary(): string[] {
    return [...this.documentFrequency.keys()];
  }

  /* ----------------------------------------------------------- transport */

  /**
   * The index as plain data, for handing across a worker boundary.
   *
   * Only the counts travel. Everything else — postings, document frequencies, norms — is
   * derived, and rebuilding it on arrival is a single pass that costs less than
   * serialising it would.
   */
  toTransferable(): IndexDoc[] {
    const docs: IndexDoc[] = [];
    for (const [id, counts] of this.frequencies) {
      const terms: string[] = [];
      for (const [term, count] of counts) {
        for (let repeat = 0; repeat < count; repeat += 1) terms.push(term);
      }
      docs.push({ id, terms });
    }
    return docs;
  }
}
