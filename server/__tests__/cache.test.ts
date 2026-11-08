/**
 * Server cache and throttling primitives.
 *
 * Both are invisible when they work and pathological when they do not: a cache that
 * never evicts is a memory leak with a user-controlled growth rate, and a limiter that
 * miscounts either blocks legitimate work or fails to protect anyone. Neither failure
 * announces itself at runtime, which is exactly why they are tested here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SingleFlight, TtlCache } from "../cache";
import { rateLimit, resetRateLimits } from "../rate-limit";

afterEach(() => {
  vi.useRealTimers();
  resetRateLimits();
});

describe("TtlCache", () => {
  it("returns a stored value before it expires", () => {
    const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("returns null for a key it has never seen", () => {
    const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 10 });
    expect(cache.get("nope")).toBeNull();
  });

  it("expires a value once the TTL has passed", () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set("a", 1);
    vi.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeNull();
  });

  it("drops an expired entry on read so it cannot occupy the ceiling", () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set("a", 1);
    vi.advanceTimersByTime(1001);
    cache.get("a");
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entries once the ceiling is exceeded", () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 3 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);

    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("d")).toBe(4);
  });

  it("moves a re-inserted key to the back of the eviction order", () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10); // refreshes "a", making "b" the oldest
    cache.set("c", 3);

    expect(cache.get("a")).toBe(10);
    expect(cache.get("b")).toBeNull();
  });

  it("never grows past the ceiling under sustained writes", () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 50 });
    for (let index = 0; index < 5000; index += 1) cache.set(`key-${index}`, index);
    expect(cache.size).toBe(50);
  });
});

describe("SingleFlight", () => {
  it("runs the work once for concurrent callers of the same key", async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    const work = () => {
      calls += 1;
      return new Promise<number>((resolve) => setTimeout(() => resolve(7), 5));
    };

    const [first, second] = await Promise.all([flight.run("k", work), flight.run("k", work)]);

    expect(calls).toBe(1);
    expect(first).toBe(7);
    expect(second).toBe(7);
  });

  it("keeps different keys independent", async () => {
    const flight = new SingleFlight<string>();
    const [a, b] = await Promise.all([
      flight.run("a", async () => "A"),
      flight.run("b", async () => "B"),
    ]);
    expect([a, b]).toEqual(["A", "B"]);
  });

  it("releases the key after settling, so a later call runs again", async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    const work = async () => {
      calls += 1;
      return calls;
    };

    await flight.run("k", work);
    await flight.run("k", work);

    expect(calls).toBe(2);
  });

  it("does not cache a rejection", async () => {
    const flight = new SingleFlight<number>();
    await expect(flight.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(flight.run("k", async () => 5)).resolves.toBe(5);
    expect(flight.size).toBe(0);
  });
});

/** Minimal Express-shaped doubles: the limiter only touches these few members. */
function fakeExchange() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: unknown = null;
  let nextCalls = 0;

  return {
    req: { ip: "10.0.0.1", socket: { remoteAddress: "10.0.0.1" } },
    res: {
      setHeader: (name: string, value: string) => headers.set(name, value),
      status(code: number) {
        statusCode = code;
        return this;
      },
      json: (payload: unknown) => {
        body = payload;
      },
    },
    next: () => {
      nextCalls += 1;
    },
    get state() {
      return { headers, statusCode, body, nextCalls };
    },
  };
}

describe("rateLimit", () => {
  it("passes requests through while inside the budget", () => {
    const limiter = rateLimit({ windowMs: 1000, max: 3, scope: "test-pass" });
    const exchange = fakeExchange();

    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural doubles
      limiter(exchange.req as any, exchange.res as any, exchange.next);
    }

    expect(exchange.state.nextCalls).toBe(3);
    expect(exchange.state.statusCode).toBe(200);
  });

  it("answers 429 once the budget is exhausted", () => {
    const limiter = rateLimit({ windowMs: 1000, max: 2, scope: "test-block" });
    const exchange = fakeExchange();

    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural doubles
      limiter(exchange.req as any, exchange.res as any, exchange.next);
    }

    expect(exchange.state.nextCalls).toBe(2);
    expect(exchange.state.statusCode).toBe(429);
    expect(exchange.state.headers.get("retry-after")).toBeDefined();
  });

  it("keeps separate budgets per scope, so one endpoint cannot drain another", () => {
    const cheap = rateLimit({ windowMs: 1000, max: 1, scope: "scope-a" });
    const expensive = rateLimit({ windowMs: 1000, max: 1, scope: "scope-b" });
    const exchange = fakeExchange();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural doubles
    cheap(exchange.req as any, exchange.res as any, exchange.next);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural doubles
    expensive(exchange.req as any, exchange.res as any, exchange.next);

    expect(exchange.state.nextCalls).toBe(2);
  });

  it("starts a fresh window once the old one elapses", () => {
    vi.useFakeTimers();
    const limiter = rateLimit({ windowMs: 1000, max: 1, scope: "test-window" });
    const exchange = fakeExchange();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural doubles
    limiter(exchange.req as any, exchange.res as any, exchange.next);
    vi.advanceTimersByTime(1500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural doubles
    limiter(exchange.req as any, exchange.res as any, exchange.next);

    expect(exchange.state.nextCalls).toBe(2);
    expect(exchange.state.statusCode).toBe(200);
  });

  it("reports the remaining budget on every response", () => {
    const limiter = rateLimit({ windowMs: 1000, max: 5, scope: "test-headers" });
    const exchange = fakeExchange();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural doubles
    limiter(exchange.req as any, exchange.res as any, exchange.next);

    expect(exchange.state.headers.get("x-ratelimit-limit")).toBe("5");
    expect(exchange.state.headers.get("x-ratelimit-remaining")).toBe("4");
  });
});
