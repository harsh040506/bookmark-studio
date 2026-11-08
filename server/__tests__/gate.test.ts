/**
 * The concurrency gate that bounds headless-browser tabs.
 *
 * These are regression tests for a bug that cost a whole feature: when `release()`
 * decremented before waking a waiter, a slot could be double-issued; and when the
 * caller awaited a hanging `page.close()` before releasing, slots leaked until every
 * screenshot request in the app hung forever with no error surfaced anywhere.
 */
import { describe, expect, it } from "vitest";
import { createGate } from "../gate";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createGate", () => {
  it("admits up to the cap without waiting", async () => {
    const gate = createGate(3);
    await gate.acquire();
    await gate.acquire();
    await gate.acquire();
    expect(gate.state()).toEqual({ active: 3, waiting: 0, max: 3 });
  });

  it("queues callers beyond the cap", async () => {
    const gate = createGate(2);
    await gate.acquire();
    await gate.acquire();

    let admitted = false;
    void gate.acquire().then(() => {
      admitted = true;
    });
    await tick();

    expect(admitted).toBe(false);
    expect(gate.state().waiting).toBe(1);
  });

  it("never exceeds the cap when a release and a fresh acquire race", async () => {
    const gate = createGate(1);
    await gate.acquire();

    // One caller parked behind the slot.
    let parkedRan = false;
    void gate.acquire().then(() => {
      parkedRan = true;
    });

    // Release wakes the parked caller, whose continuation is a microtask. A newcomer
    // arriving in that window must not be able to take the same slot.
    gate.release();
    const newcomer = gate.acquire();
    let newcomerRan = false;
    void newcomer.then(() => {
      newcomerRan = true;
    });

    await tick();

    expect(parkedRan).toBe(true);
    expect(newcomerRan).toBe(false);
    expect(gate.state().active).toBe(1);
  });

  it("lets a priority caller jump the queue", async () => {
    const gate = createGate(1);
    await gate.acquire();

    const order: string[] = [];
    void gate.acquire().then(() => order.push("background-1"));
    void gate.acquire().then(() => order.push("background-2"));
    void gate.acquire(true).then(() => order.push("interactive"));

    // Drain one waiter at a time so the ordering is observable.
    for (let step = 0; step < 3; step += 1) {
      gate.release();
      await tick();
    }

    expect(order).toEqual(["interactive", "background-1", "background-2"]);
  });

  it("releases the slot even when the work throws", async () => {
    const gate = createGate(1);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(gate.state().active).toBe(0);
  });

  it("drains a burst without leaking slots", async () => {
    const gate = createGate(3);
    let peak = 0;

    await Promise.all(
      Array.from({ length: 25 }, () =>
        gate.run(async () => {
          peak = Math.max(peak, gate.state().active);
          await tick();
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(gate.state()).toEqual({ active: 0, waiting: 0, max: 3 });
  });

  it("cannot be driven negative by an unbalanced release", () => {
    const gate = createGate(2);
    gate.release();
    gate.release();
    expect(gate.state().active).toBe(0);
  });
});
