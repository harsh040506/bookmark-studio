/**
 * Getting the search index built without blocking the first paint.
 *
 * ## The rule this module exists to keep
 *
 * **The worker is an optimisation, never a dependency.** Everything here degrades to the
 * synchronous path — in a test runner with no `Worker`, in a browser that refuses the
 * module, and if the worker throws on start-up. The index that comes back is identical
 * either way; only when it arrives differs.
 *
 * That matters because the failure mode of getting this wrong is silent. A worker that
 * never answers leaves a library with no index at all: search returns nothing, "similar"
 * returns nothing, and the app looks like it has forgotten everything the user saved.
 * So every path here either produces an index or falls back to one, and none of them
 * waits forever.
 *
 * ## Why the fallback is not merely a safety net
 *
 * A small library does not benefit from a worker. Spinning one up costs a module fetch, a
 * compile and two structured clones, which is more than tokenising three hundred short
 * documents takes in the first place. Below the threshold the synchronous path *is* the
 * fast path, and the worker is skipped rather than tolerated.
 */
import type { Bookmark } from "../../shared/types";
import { buildIndex, documentSource, pathOf } from "./library";
import { countDoc, type IndexRequest, type IndexResponse, type RawDoc } from "./index.worker";
import { TfIdfIndex } from "./tfidf";

/**
 * Below this many rows the synchronous build wins outright.
 *
 * Chosen from the shape of the costs rather than by taste: worker start-up is a fixed few
 * milliseconds and tokenising is a few microseconds per document, so the crossover sits in
 * the high hundreds. Anything under this and the worker would be pure overhead.
 */
const WORKER_THRESHOLD = 600;

/** How long to wait for the worker before giving up and building here. */
const WORKER_TIMEOUT_MS = 8_000;

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 1;

/**
 * The worker, started on first use and reused thereafter.
 *
 * Lazily, because most sessions never cross the threshold and a worker started at module
 * load would be a thread and a module fetch spent on nothing. `workerBroken` latches, so a
 * browser that cannot start it is asked once rather than on every rebuild.
 */
function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    workerBroken = true;
    return null;
  }
  try {
    worker = new Worker(new URL("./index.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("error", () => {
      // A worker that has errored cannot be trusted to answer the request in flight or
      // any after it. Dropping the reference sends everything back to the sync path.
      workerBroken = true;
      worker?.terminate();
      worker = null;
    });
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Tears the worker down. Used by tests, and when the library is emptied. */
export function stopIndexer(): void {
  worker?.terminate();
  worker = null;
}

function rawDocs(bookmarks: Bookmark[], folderPaths: Map<string, string>): RawDoc[] {
  return bookmarks.map((bookmark) => documentSource(bookmark, pathOf(bookmark, folderPaths)));
}

/**
 * Builds the index, off the main thread when that is worth doing.
 *
 * Always resolves. A rejected promise here would have to be handled identically at every
 * call site — fall back and carry on — so it is handled once, here, instead.
 */
export async function buildIndexAsync(
  bookmarks: Bookmark[],
  folderPaths: Map<string, string>,
): Promise<TfIdfIndex> {
  if (bookmarks.length < WORKER_THRESHOLD) return buildIndex(bookmarks, folderPaths);

  const instance = getWorker();
  if (!instance) return buildIndex(bookmarks, folderPaths);

  const docs = rawDocs(bookmarks, folderPaths);
  const id = nextRequestId++;

  try {
    const counted = await new Promise<IndexResponse["docs"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("indexer timed out"));
      }, WORKER_TIMEOUT_MS);

      const onMessage = (event: MessageEvent<IndexResponse>) => {
        // Responses are matched by id rather than assumed to arrive in order: a rebuild
        // triggered while an earlier one is still running would otherwise resolve the
        // second request with the first request's — older — documents.
        if (event.data.id !== id) return;
        cleanup();
        resolve(event.data.docs);
      };
      const onError = () => {
        cleanup();
        reject(new Error("indexer failed"));
      };
      function cleanup() {
        clearTimeout(timer);
        instance!.removeEventListener("message", onMessage as EventListener);
        instance!.removeEventListener("error", onError);
      }

      instance.addEventListener("message", onMessage as EventListener);
      instance.addEventListener("error", onError);
      const request: IndexRequest = { id, docs };
      instance.postMessage(request);
    });

    return TfIdfIndex.fromCounts(counted);
  } catch {
    return buildIndex(bookmarks, folderPaths);
  }
}

/**
 * The synchronous counting path, exposed so tests can assert the two agree.
 *
 * They must: the worker is only ever a different *place* to run this, and a divergence
 * would show up as search results that change depending on library size, which is the
 * kind of bug nobody thinks to look for.
 */
export function buildIndexFromCounts(
  bookmarks: Bookmark[],
  folderPaths: Map<string, string>,
): TfIdfIndex {
  return TfIdfIndex.fromCounts(rawDocs(bookmarks, folderPaths).map(countDoc));
}
