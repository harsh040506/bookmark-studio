/**
 * A counting semaphore with FIFO hand-off.
 *
 * Extracted from the screenshot service because its invariant is easy to get subtly
 * wrong and impossible to observe once it is: a leaked or double-counted slot does not
 * throw, it just makes every later request hang forever.
 *
 * The rule that matters is in `release`. Handing the slot *directly* to the next waiter
 * keeps the count constant across the transfer. The obvious alternative — decrement,
 * then let the woken waiter increment — opens a window between the two, because the
 * waiter resumes on a microtask. Anything that calls `acquire` inside that window sees
 * a free slot and takes it, and the cap is quietly exceeded.
 */
export interface Gate {
  /** `priority` jumps the queue — for work a person is waiting on. */
  acquire: (priority?: boolean) => Promise<void>;
  release: () => void;
  state: () => { active: number; waiting: number; max: number };
  /** Runs `work` while holding a slot, releasing it however `work` ends. */
  run: <T>(work: () => Promise<T>, priority?: boolean) => Promise<T>;
}

export function createGate(max: number): Gate {
  let active = 0;
  const waiting: (() => void)[] = [];

  /**
   * Priority matters more than it looks. A background sweep can hold every slot for
   * tens of seconds at a time, so a plain FIFO queue makes a button someone just
   * pressed wait behind work they never asked for — which reads as the button being
   * broken rather than busy.
   */
  const acquire = async (priority = false): Promise<void> => {
    if (active < max) {
      active += 1;
      return;
    }
    // The slot is handed over already counted, so there is no increment here.
    await new Promise<void>((resolve) => {
      if (priority) waiting.unshift(resolve);
      else waiting.push(resolve);
    });
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active = Math.max(0, active - 1);
  };

  return {
    acquire,
    release,
    state: () => ({ active, waiting: waiting.length, max }),
    run: async (work, priority) => {
      await acquire(priority);
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}
