/**
 * The circuit breaker that stops a sweep waiting on a site that has stopped answering.
 */
import { describe, expect, it } from "vitest";
import { CircuitOpenError, createBreaker } from "../breaker";

function clock(start = 1_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe("createBreaker", () => {
  it("opens after the threshold of consecutive failures, and fails fast while open", () => {
    const time = clock();
    const breaker = createBreaker({ threshold: 3, windowMs: 60_000, coolOffMs: 30_000, now: time.now });
    breaker.failure("dead.example");
    breaker.failure("dead.example");
    expect(() => breaker.check("dead.example")).not.toThrow();
    breaker.failure("dead.example");
    expect(() => breaker.check("dead.example")).toThrow(CircuitOpenError);
  });

  it("only affects the failing key", () => {
    const time = clock();
    const breaker = createBreaker({ threshold: 1, windowMs: 60_000, coolOffMs: 30_000, now: time.now });
    breaker.failure("dead.example");
    expect(() => breaker.check("alive.example")).not.toThrow();
  });

  it("lets one trial through after the cool-off, and closes on success", () => {
    const time = clock();
    const breaker = createBreaker({ threshold: 1, windowMs: 60_000, coolOffMs: 30_000, now: time.now });
    breaker.failure("site");
    time.advance(30_001);
    expect(() => breaker.check("site")).not.toThrow();
    breaker.success("site");
    expect(breaker.state("site")).toBe("closed");
  });

  it("reopens at once when the trial fails", () => {
    const time = clock();
    const breaker = createBreaker({ threshold: 3, windowMs: 600_000, coolOffMs: 30_000, now: time.now });
    for (let index = 0; index < 3; index += 1) breaker.failure("site");
    time.advance(30_001);
    breaker.failure("site");
    expect(breaker.state("site")).toBe("open");
  });

  it("forgets failures that are spread out longer than the window", () => {
    const time = clock();
    const breaker = createBreaker({ threshold: 3, windowMs: 10_000, coolOffMs: 30_000, now: time.now });
    breaker.failure("site");
    time.advance(11_000);
    breaker.failure("site");
    time.advance(11_000);
    breaker.failure("site");
    expect(breaker.state("site")).toBe("closed");
  });

  it("success resets the count", () => {
    const time = clock();
    const breaker = createBreaker({ threshold: 2, windowMs: 60_000, coolOffMs: 30_000, now: time.now });
    breaker.failure("site");
    breaker.success("site");
    breaker.failure("site");
    expect(breaker.state("site")).toBe("closed");
  });

  it("bounds the number of tracked keys", () => {
    const breaker = createBreaker({ threshold: 1, windowMs: 60_000, coolOffMs: 30_000, maxKeys: 10 });
    for (let index = 0; index < 100; index += 1) breaker.failure(`host-${index}`);
    expect(breaker.state("host-0")).toBe("closed");
    expect(breaker.state("host-99")).toBe("open");
  });
});
