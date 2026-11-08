/**
 * Search that forgives a typo.
 *
 * ## The failure this fixes
 *
 * TF-IDF matches terms exactly. Type "clipbord" and the index has no such term, so the
 * query contributes nothing, the result list is empty, and the app reports — truthfully
 * and uselessly — that it found nothing. The bookmark was there the whole time.
 *
 * That is the single most damaging failure a personal library can have, because the user
 * cannot tell it apart from "I never saved that", and the correct response to the second
 * is to give up looking.
 *
 * ## The approach
 *
 * Two cheap classical techniques, in the order that costs least:
 *
 *   1. **Exact.** If the term is in the vocabulary, use it. Most queries stop here and
 *      pay nothing.
 *   2. **Prefix.** "clipb" should reach "clipboard" while it is still being typed. A
 *      term the query is a prefix of is nearly always the term that was meant.
 *   3. **Edit distance, bounded.** Only then, and only against vocabulary terms of a
 *      similar length, with a budget that scales with the word: one edit for a short
 *      word, two for a long one. Bounded because unbounded Levenshtein over a whole
 *      vocabulary is both slow and wrong — at distance 3, "cat" reaches "dog".
 *
 * Candidates are narrowed by a trigram overlap before any edit distance is computed, so
 * the expensive step only ever runs against a few dozen plausible words rather than the
 * whole vocabulary.
 *
 * No model, no spell-check dictionary, no network. The vocabulary is the library's own
 * words, which is what makes it correct for *this* library: it will happily fix
 * "figmna" to "figma" because the user saved Figma, and will not invent a correction for
 * a word nobody here has ever used.
 */

/** Terms shorter than this are matched exactly; a typo in them is unrecoverable anyway. */
const MIN_FUZZY_LENGTH = 4;
/** Trigram overlap a candidate needs before its edit distance is worth computing. */
const MIN_TRIGRAM_OVERLAP = 0.3;
/** How many corrections one query term may expand into. */
const MAX_EXPANSIONS = 3;

/** Edits allowed, by term length. Longer words tolerate more without becoming ambiguous. */
function budgetFor(length: number): number {
  if (length <= 4) return 1;
  if (length <= 7) return 1;
  return 2;
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const grams = new Set<string>();
  for (let index = 0; index < padded.length - 2; index += 1) {
    grams.add(padded.slice(index, index + 3));
  }
  return grams;
}

/**
 * Levenshtein distance, abandoned as soon as it cannot come in under `budget`.
 *
 * Two rows rather than a full matrix, and an early exit when the best cell in a row
 * already exceeds the budget — which is what keeps this affordable to run against a
 * candidate list rather than once against one string.
 */
export function editDistance(a: string, b: string, budget: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > budget) return budget + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let best = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (current[j] < best) best = current[j];
    }
    if (best > budget) return budget + 1;
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/**
 * The vocabulary a query is corrected against: every term the index knows.
 *
 * Built once per index build and handed to {@link expandTerm}. Held as an array plus a
 * trigram map so narrowing is a set intersection rather than a scan.
 */
export class Vocabulary {
  private readonly terms: string[] = [];
  private readonly exact = new Set<string>();
  private readonly byTrigram = new Map<string, number[]>();

  constructor(terms: Iterable<string>) {
    for (const term of terms) {
      if (this.exact.has(term)) continue;
      this.exact.add(term);
      const position = this.terms.push(term) - 1;
      if (term.length < MIN_FUZZY_LENGTH) continue;
      for (const gram of trigrams(term)) {
        const bucket = this.byTrigram.get(gram);
        if (bucket) bucket.push(position);
        else this.byTrigram.set(gram, [position]);
      }
    }
  }

  has(term: string): boolean {
    return this.exact.has(term);
  }

  get size(): number {
    return this.terms.length;
  }

  /**
   * Terms this one might have meant, nearest first.
   *
   * Returns the term itself when it is already in the vocabulary and nothing else —
   * a word the library knows is never "corrected", however close something else sits.
   */
  expand(term: string): { term: string; distance: number }[] {
    if (this.exact.has(term)) return [{ term, distance: 0 }];
    if (term.length < MIN_FUZZY_LENGTH) return [];

    const grams = trigrams(term);
    const overlap = new Map<number, number>();
    for (const gram of grams) {
      for (const position of this.byTrigram.get(gram) ?? []) {
        overlap.set(position, (overlap.get(position) ?? 0) + 1);
      }
    }

    const budget = budgetFor(term.length);
    const candidates: { term: string; distance: number }[] = [];

    for (const [position, shared] of overlap) {
      const candidate = this.terms[position];
      if (shared / grams.size < MIN_TRIGRAM_OVERLAP) continue;

      // A term the query is a prefix of is what someone half-way through typing meant,
      // and it needs no edit-distance justification.
      if (candidate.startsWith(term)) {
        candidates.push({ term: candidate, distance: 0.5 });
        continue;
      }
      const distance = editDistance(term, candidate, budget);
      if (distance <= budget) candidates.push({ term: candidate, distance });
    }

    return candidates
      .sort((a, b) => a.distance - b.distance || a.term.length - b.term.length)
      .slice(0, MAX_EXPANSIONS);
  }
}

export interface ExpandedQuery {
  /** Every term to search, corrections included. */
  terms: string[];
  /** Corrections actually applied, so the UI can say "showing results for …". */
  corrections: { from: string; to: string }[];
}

/**
 * Rewrites a query's terms against the library's vocabulary.
 *
 * A correction is reported rather than applied silently. Searching for something you did
 * not type and not being told is worse than finding nothing: the results look wrong and
 * there is no explanation on screen for why.
 */
export function expandQuery(terms: string[], vocabulary: Vocabulary): ExpandedQuery {
  const expanded: string[] = [];
  const corrections: { from: string; to: string }[] = [];

  for (const term of terms) {
    const matches = vocabulary.expand(term);
    if (!matches.length) {
      expanded.push(term);
      continue;
    }
    if (matches[0].distance === 0) {
      expanded.push(term);
      continue;
    }
    for (const match of matches) expanded.push(match.term);
    corrections.push({ from: term, to: matches[0].term });
  }

  return { terms: [...new Set(expanded)], corrections };
}
