/**
 * Tokenising and counting, off the main thread.
 *
 * ## What this is for
 *
 * The index build is linear in library size and it used to happen between the library
 * loading and the first paint — so on a large library the app was demonstrably *there*,
 * with every row in memory, and could not draw a single card until every document had
 * been tokenised. That is the worst possible place to spend time, because it is the one
 * stretch where the user has nothing at all to look at.
 *
 * ## Why only half the work moved
 *
 * A worker cannot hand back a class instance, and serialising a finished index — postings
 * sets, document frequencies, cached norms — costs more than rebuilding those structures
 * from counts on arrival. So the split is at the honest seam: the worker does the pass
 * that is genuinely expensive (normalising, splitting and stemming every string in the
 * library), and the main thread does the pass that is cheap and must own the result
 * (assembling postings).
 *
 * Counts rather than repeated terms is the other half of that decision — see
 * `CountedDoc`. A document with a long body crosses back as a few hundred distinct
 * strings instead of a few thousand repeated ones.
 *
 * ## What crosses, and why it is only strings
 *
 * Raw text, never `Bookmark` objects. A Chrome export embeds a base64 favicon per row, so
 * posting the rows themselves would structured-clone several hundred megabytes of images
 * that this pass has no use for — which would cost more on the main thread than the
 * tokenising the worker was hired to take away.
 *
 * ## No imports beyond the pure ones
 *
 * `text.ts` is deliberately free of DOM and network access, which is what lets it be
 * shared verbatim between this worker and the main thread. Nothing else may be pulled in
 * here: a stray import of anything touching `window` fails at worker start-up, and the
 * fallback in `indexer.ts` would silently absorb it — the app would work, slowly, forever,
 * with nobody the wiser.
 */
import { tokenize, tokenizeDomain } from "./text";
import type { CountedDoc } from "./tfidf";

/** One document's raw material: prose to tokenise, and hostnames to split differently. */
export interface RawDoc {
  id: string;
  /** Free text. Repeat a string to weight it — the title appears twice. */
  texts: string[];
  /** Hostnames, split on dots rather than as prose. */
  domains: string[];
}

export interface IndexRequest {
  id: number;
  docs: RawDoc[];
}

export interface IndexResponse {
  id: number;
  docs: CountedDoc[];
}

/** Turns one document's raw material into distinct terms and their counts. */
export function countDoc(doc: RawDoc): CountedDoc {
  const tally = new Map<string, number>();
  const add = (term: string) => tally.set(term, (tally.get(term) ?? 0) + 1);

  for (const text of doc.texts) {
    if (!text) continue;
    for (const term of tokenize(text)) add(term);
  }
  for (const domain of doc.domains) {
    if (!domain) continue;
    for (const term of tokenizeDomain(domain)) add(term);
  }

  const terms: string[] = [];
  const counts: number[] = [];
  for (const [term, total] of tally) {
    terms.push(term);
    counts.push(total);
  }
  return { id: doc.id, terms, counts };
}

/**
 * The listener is installed only when this module really is a worker.
 *
 * ## Why the guard is necessary rather than defensive
 *
 * This file is imported three ways: as a worker entry, as the source of `countDoc` for the
 * synchronous fallback in `indexer.ts`, and as the source of the `RawDoc` type in
 * `library.ts`. Only the first of those has a `self` — so an unguarded
 * `self.addEventListener` at module scope throws a `ReferenceError` the moment anything on
 * the main thread or in a test runner imports the pure functions beside it.
 *
 * That failure is worse than it sounds: it happens at *import* time, so it takes down
 * whatever module reached for `countDoc` rather than surfacing as a worker that would not
 * start. The fallback path exists precisely so the app survives having no worker, and it
 * would have been unreachable.
 *
 * `DedicatedWorkerGlobalScope` is the specific check rather than `typeof self !== "undefined"`,
 * because `self` is also defined on a `Window` — where installing this would be harmless
 * but meaningless, and would quietly claim every `postMessage` the page ever received.
 */
const isWorker =
  typeof self !== "undefined" &&
  typeof (globalThis as { DedicatedWorkerGlobalScope?: unknown }).DedicatedWorkerGlobalScope !==
    "undefined" &&
  self instanceof
    (globalThis as unknown as { DedicatedWorkerGlobalScope: new () => unknown })
      .DedicatedWorkerGlobalScope;

if (isWorker) {
  self.addEventListener("message", (event: MessageEvent<IndexRequest>) => {
    const { id, docs } = event.data;
    const response: IndexResponse = { id, docs: docs.map(countDoc) };
    (self as unknown as Worker).postMessage(response);
  });
}
