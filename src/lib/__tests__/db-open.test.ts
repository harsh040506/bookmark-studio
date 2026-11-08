/**
 * Opening the library database, and recovering when that goes wrong.
 *
 * Every read and write in the app funnels through one cached `openDatabase()` promise, so
 * the ways that promise can go bad are the ways the whole application can go bad — and all
 * three of them ended in the same place: a library that is present on disk, intact, and
 * permanently unreachable, with no error shown and no way back except a reload that would
 * not help.
 *
 *   1. **A failed open was cached as a rejected promise.** The handle was assigned
 *      unconditionally, so one transient failure was remembered for the life of the page.
 *      Every later call returned that same rejection even after the cause had gone.
 *   2. **`blocked` was never handled.** An older connection in a second tab makes a
 *      versioned open wait — not fail, wait — indefinitely. The app simply never finished
 *      loading, and said nothing about why.
 *   3. **`versionchange` was never handled.** This tab was the thing blocking *other*
 *      tabs, so a user who reloaded into a newer version got a tab that hung on the open
 *      until they found and closed the original.
 *
 * These tests drive the `IDBFactory` directly rather than through `fake-indexeddb`, because
 * what is under test is the request lifecycle — which callbacks are attached and what the
 * module does when each one fires — and those states are exactly the ones a working
 * implementation never reaches on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in `IDBOpenDBRequest` whose lifecycle events the test fires by hand. */
interface FakeRequest {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  result: unknown;
  error: unknown;
  transaction: unknown;
}

function makeRequest(): FakeRequest {
  return {
    onsuccess: null,
    onerror: null,
    onblocked: null,
    onupgradeneeded: null,
    result: null,
    error: null,
    transaction: null,
  };
}

/**
 * A connection carrying the surface `openDatabase` touches, plus enough of a transaction
 * to let one `get` complete.
 *
 * The read has to be able to finish. Without it every test here would see the same
 * rejection from the store access downstream, which would mask whether the *open* did what
 * it was supposed to — and the blocked-deadline test in particular can only tell success
 * from failure if a successful open reaches a successful read.
 */
function makeConnection() {
  return {
    objectStoreNames: { contains: () => true },
    createObjectStore: vi.fn(),
    transaction: vi.fn(() => ({
      objectStore: () => ({
        get: () => {
          const request: { onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown; error: unknown } =
            { onsuccess: null, onerror: null, result: undefined, error: null };
          // Settled asynchronously, as a real IndexedDB request is.
          setTimeout(() => request.onsuccess?.(), 0);
          return request;
        },
      }),
    })),
    close: vi.fn(),
    onversionchange: null as null | (() => void),
    onclose: null as null | (() => void),
  };
}

let requests: FakeRequest[] = [];
let openDatabase: () => Promise<unknown>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  requests = [];

  const open = vi.fn(() => {
    const request = makeRequest();
    requests.push(request);
    return request;
  });
  vi.stubGlobal("indexedDB", { open });

  /*
    `openDatabase` is module-private, which is correct — nothing outside this module should
    be opening connections. It is reached through a store accessor instead, which is how
    every real caller reaches it too, so the test exercises the actual path.
  */
  const db = await import("../db");
  openDatabase = () => db.getMeta("anything").catch((error: unknown) => Promise.reject(error));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("a failed open", () => {
  it("is not remembered, so a later attempt can succeed", async () => {
    const first = openDatabase();
    // Attach a handler immediately: the rejection is expected and must not go unobserved.
    const firstOutcome = first.then(
      () => "resolved",
      () => "rejected",
    );

    requests[0].error = new Error("transient");
    requests[0].onerror?.();
    expect(await firstOutcome).toBe("rejected");

    // The second attempt must open a *new* request rather than replay the failed one.
    void openDatabase().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.length).toBe(2);
  });
});

describe("another tab blocking the upgrade", () => {
  /**
   * Without a deadline this promise never settles and the app never finishes loading.
   * The message is part of the contract: it has to name the cause and the remedy, because
   * "close your other tabs" is something only the user can do.
   */
  it("gives up with an explanation rather than waiting forever", async () => {
    const opening = openDatabase();
    const outcome = opening.catch((error: Error) => error);

    requests[0].onblocked?.();
    await vi.advanceTimersByTimeAsync(11_000);

    const error = (await outcome) as Error;
    expect(error.message).toMatch(/another tab/i);
    expect(error.message).toMatch(/close/i);
  });

  /**
   * Blocking is often temporary — the other tab closes and the upgrade proceeds. The
   * deadline must not fire in that case, or a recovery would be reported as a failure.
   */
  it("does not fire the deadline once the open succeeds", async () => {
    const opening = openDatabase();
    const outcome = opening.then(
      () => "resolved",
      (error: Error) => error.message,
    );

    requests[0].onblocked?.();
    await vi.advanceTimersByTimeAsync(2_000);

    // The other tab closed; the open goes through.
    requests[0].result = makeConnection();
    requests[0].onsuccess?.();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await outcome).toBe("resolved");
  });
});

describe("a successful open", () => {
  /**
   * The other half of the blocking problem. This connection is what would stop a newer
   * tab from upgrading, so it has to stand down when asked — otherwise every user who
   * leaves a tab open becomes the reason their next one hangs.
   */
  it("closes itself when another tab needs to upgrade", async () => {
    const opening = openDatabase();
    void opening.catch(() => undefined);

    const connection = makeConnection();
    requests[0].result = connection;
    requests[0].onsuccess?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(typeof connection.onversionchange).toBe("function");
    connection.onversionchange?.();
    expect(connection.close).toHaveBeenCalled();
  });

  /**
   * A connection can close underneath the app — storage eviction, the user clearing site
   * data. Every transaction on it afterwards throws, so the cached handle has to be
   * dropped or the page serves a dead connection until it is reloaded.
   */
  it("drops the cached handle when the connection closes underneath it", async () => {
    void openDatabase().catch(() => undefined);

    const connection = makeConnection();
    requests[0].result = connection;
    requests[0].onsuccess?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(typeof connection.onclose).toBe("function");
    connection.onclose?.();

    void openDatabase().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    // A fresh request, rather than the closed connection handed out again.
    expect(requests.length).toBe(2);
  });
});

describe("storage that is unavailable outright", () => {
  it("reports a readable reason when opening throws", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("storage disabled");
      },
    });

    const error = (await openDatabase().catch((reason: Error) => reason)) as Error;
    expect(error.message).toMatch(/blocked|settings/i);
    // The browser's own wording is never shown; it names an internal cause the user
    // cannot act on.
    expect(error.message).not.toMatch(/storage disabled/);
  });
});
