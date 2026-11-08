/**
 * Bounded reads of untrusted response bodies.
 *
 * These are regression tests for a defect that ran through every fetching route on the
 * server. Each one carried a size limit and a comment describing the limit as protection
 * against a hostile or broken remote host, and each one enforced it by calling
 * `arrayBuffer()` — reading the entire body into memory — and *then* checking how big it
 * was. The check was real; the protection was not. A response with no `Content-Length`, or
 * a dishonest one, was buffered without limit, and the size test ran only once the damage
 * it existed to prevent had already been done.
 *
 * The invariants worth pinning are therefore about *what is pulled off the socket*, not
 * about the value that comes back. A test that only checked the returned length would have
 * passed against the broken implementation too.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ResponseTooLargeError,
  drain,
  mapWithConcurrency,
  readCapped,
  readTruncated,
} from "../safe-fetch";

/**
 * A response whose body is delivered in chunks, counting how many are actually pulled.
 *
 * The counter is the point of the whole harness: it is the only way to distinguish "read
 * everything, then measured it" from "stopped reading at the ceiling", which is exactly
 * the difference between the old behaviour and the new one.
 */
function chunkedResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): { response: Response; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  let index = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    response: new Response(stream, { headers }),
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
}

const block = (size: number, fill = 0x61) => new Uint8Array(size).fill(fill);

describe("readCapped", () => {
  it("returns a body that fits under the ceiling", async () => {
    const { response } = chunkedResponse([block(10), block(10)]);
    const buffer = await readCapped(response, 1000);
    expect(buffer.byteLength).toBe(20);
  });

  /**
   * The boundary case, and the one an off-by-one hides in: a body of exactly the ceiling
   * is the largest legal body, not the smallest illegal one.
   */
  it("accepts a body of exactly the ceiling", async () => {
    const { response } = chunkedResponse([block(50), block(50)]);
    await expect(readCapped(response, 100)).resolves.toHaveLength(100);
  });

  it("rejects a body one byte over the ceiling", async () => {
    const { response } = chunkedResponse([block(50), block(51)]);
    await expect(readCapped(response, 100)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  /**
   * The defect itself. A server that declares no length and streams forever must cost a
   * bounded amount of memory, and the proof is that the reader stops pulling chunks.
   */
  it("stops pulling chunks once the ceiling is passed", async () => {
    const { response, pulled } = chunkedResponse(Array.from({ length: 100 }, () => block(1000)));
    await expect(readCapped(response, 2500)).rejects.toBeInstanceOf(ResponseTooLargeError);
    // Three chunks reach the ceiling; the remaining ninety-seven are never transferred.
    expect(pulled()).toBeLessThanOrEqual(3);
  });

  /** A dishonest `Content-Length` must not be able to buy an unbounded read. */
  it("enforces the ceiling against the bytes that arrive, not the declared length", async () => {
    const { response } = chunkedResponse([block(5000)], { "content-length": "10" });
    await expect(readCapped(response, 1000)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  /** An honest oversized length is refused without opening the transfer at all. */
  it("refuses a declared length over the ceiling without reading the body", async () => {
    const { response, pulled } = chunkedResponse([block(10)], { "content-length": "999999" });
    await expect(readCapped(response, 1000)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(pulled()).toBe(0);
  });

  it("releases the socket when it gives up early", async () => {
    const { response, cancelled } = chunkedResponse(
      Array.from({ length: 50 }, () => block(1000)),
    );
    await expect(readCapped(response, 1500)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled()).toBe(true);
  });

  it("treats a body-less response as empty rather than throwing", async () => {
    await expect(readCapped(new Response(null), 100)).resolves.toHaveLength(0);
  });
});

describe("readTruncated", () => {
  it("returns the first bytes and stops, without treating the excess as an error", async () => {
    const { response, pulled } = chunkedResponse(Array.from({ length: 100 }, () => block(1000)));
    const buffer = await readTruncated(response, 2500);
    expect(buffer.byteLength).toBe(2500);
    expect(pulled()).toBeLessThanOrEqual(3);
  });

  it("returns a short body whole", async () => {
    const { response } = chunkedResponse([block(30)]);
    await expect(readTruncated(response, 5000)).resolves.toHaveLength(30);
  });

  /**
   * The bytes must be the *first* ones, not an arbitrary window: the metadata extractor
   * depends on reading a document from its start, and a truncation that dropped the head
   * would silently stop finding titles.
   */
  it("keeps the leading bytes in order", async () => {
    const { response } = chunkedResponse([
      new TextEncoder().encode("<title>hello"),
      new TextEncoder().encode(" world</title>"),
    ]);
    const buffer = await readTruncated(response, 12);
    expect(buffer.toString("utf8")).toBe("<title>hello");
  });
});

describe("drain", () => {
  it("releases the body without transferring it", async () => {
    const { response, pulled, cancelled } = chunkedResponse(
      Array.from({ length: 20 }, () => block(1000)),
    );
    await drain(response);
    expect(pulled()).toBe(0);
    expect(cancelled()).toBe(true);
  });

  it("is safe on a response whose body is already gone", async () => {
    const response = new Response("done");
    await response.text();
    await expect(drain(response)).resolves.toBeUndefined();
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it("holds concurrency at the limit", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  /**
   * With `Promise.all`, the first rejection returns immediately and leaves the other
   * runners in flight with nobody holding their promises. The second failure then arrives
   * as an unhandled rejection, which under Node's default policy terminates the process —
   * a batch endpoint able to kill the server because two URLs failed instead of one.
   *
   * The rejection still propagates; what must not happen is an unobserved one.
   */
  it("does not orphan the other runners when one fails", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      await expect(
        mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
          await new Promise((resolve) => setTimeout(resolve, value));
          throw new Error(`failed ${value}`);
        }),
      ).rejects.toThrow(/failed/);

      // Long enough for every straggler to have settled and been reported, had it been
      // left unobserved.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("handles an empty input without spawning runners", async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});
