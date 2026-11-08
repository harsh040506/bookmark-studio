/**
 * A bounded pool of browser tabs over at most one browser process.
 *
 * Guarantees, each one tested in `__tests__/tab-pool.test.ts`:
 *
 *  1. **No more than `maxTabs` tabs are ever open at once.** A slot is taken before a tab
 *     is opened and is only given back once that tab has *actually closed*. A tab that is
 *     still closing still counts, so a new one cannot open alongside it.
 *  2. **At most one browser exists at a time, and an old one is fully closed before a new
 *     one launches.** A replacement launch waits on the previous browser's shutdown.
 *  3. **A stuck tab cannot leak.** If a tab will not close within the grace period, the
 *     pool stops admitting work, lets the other tabs finish, then shuts the browser down
 *     (killing the process if it will not exit) and only then reopens.
 *  4. **Memory stays bounded on long sweeps.** After `recycleAfter` captures the browser
 *     is drained and restarted the same way, so a 5,000-bookmark library does not grow one
 *     Chrome process for an hour.
 *  5. **People go first.** `priority` work joins the front of the queue.
 *
 * The browser operations are injected so the scheduling can be tested without Chrome.
 */

export interface TabPoolDriver<B, T> {
  launch: () => Promise<B>;
  openTab: (browser: B) => Promise<T>;
  /** May hang; the pool bounds it with `closeGraceMs`. A rejection counts as closed. */
  closeTab: (tab: T) => Promise<void>;
  /** May hang; the pool bounds it and falls back to `killBrowser`. */
  closeBrowser: (browser: B) => Promise<void>;
  /** Hard stop. Must be safe to call on a browser that has already exited. */
  killBrowser: (browser: B) => void;
  isAlive: (browser: B) => boolean;
}

export interface TabPoolOptions {
  maxTabs: number;
  recycleAfter: number;
  closeGraceMs: number;
}

export interface TabPoolState {
  /** Tabs open or still closing. Never above `max`. */
  tabs: number;
  waiting: number;
  max: number;
  draining: boolean;
  browserRunning: boolean;
  /** Captures served by the current browser since it launched. */
  served: number;
  /** Browser processes started since the pool was created. */
  launches: number;
}

export class TabPoolTimeout extends Error {}

export class TabPoolClosed extends Error {}

/** The hard ceiling the product promises, whatever the configuration says. */
export const ABSOLUTE_MAX_TABS = 5;

/** Resolves `true` if `work` settled within `ms`, `false` if the time ran out first. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createTabPool<B, T>(driver: TabPoolDriver<B, T>, options: TabPoolOptions) {
  const max = Math.max(1, Math.min(ABSOLUTE_MAX_TABS, Math.floor(options.maxTabs) || 1));
  const recycleAfter = Math.max(1, Math.floor(options.recycleAfter) || 1);
  const grace = Math.max(1, options.closeGraceMs);

  let tabs = 0;
  /** Tabs whose close timed out. Still counted in `tabs` until the browser is gone. */
  let stuck = 0;
  let served = 0;
  let launches = 0;
  let draining = false;
  let closed = false;
  let browser: Promise<B> | null = null;
  /** The previous browser's shutdown; a new launch waits for it. */
  let retiring: Promise<void> | null = null;
  const waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];

  function pump(): void {
    while (!closed && !draining && tabs < max && waiting.length) {
      tabs += 1;
      waiting.shift()!.resolve();
    }
  }

  function admit(priority: boolean): Promise<void> {
    if (closed) return Promise.reject(new TabPoolClosed("The browser pool has shut down"));
    if (!draining && tabs < max && !waiting.length) {
      tabs += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      if (priority) waiting.unshift(entry);
      else waiting.push(entry);
    });
  }

  /** Closes a browser, killing it if it will not go quietly. Never rejects. */
  async function retire(handle: Promise<B>): Promise<void> {
    const instance = await handle.catch(() => null);
    if (!instance) return;
    const exited = await settledWithin(driver.closeBrowser(instance), grace);
    if (!exited || driver.isAlive(instance)) {
      try {
        driver.killBrowser(instance);
      } catch {
        // Already gone.
      }
    }
  }

  /** Called whenever a tab finishes closing: recycles if draining and idle, else admits. */
  let recycling = false;

  function settle(): void {
    if (recycling) return;
    if (draining && tabs === stuck) {
      recycling = true;
      const old = browser;
      browser = null;
      const shutdown = (old ? retire(old) : Promise.resolve()).then(() => {
        // The stuck tabs died with their browser, so their slots are free now.
        tabs -= stuck;
        stuck = 0;
        served = 0;
        draining = false;
        recycling = false;
        if (retiring === shutdown) retiring = null;
        pump();
      });
      retiring = shutdown;
      return;
    }
    pump();
  }

  async function getBrowser(): Promise<B> {
    // Never two browsers: wait for the last one to be fully gone.
    while (retiring) await retiring;
    if (closed) throw new TabPoolClosed("The browser pool has shut down");

    if (browser) {
      const current = browser;
      const instance = await current.catch(() => null);
      if (instance && driver.isAlive(instance)) return instance;
      // Crashed or failed to launch. Make sure the process is really gone before replacing it.
      if (browser === current) {
        browser = null;
        const shutdown = retire(current).then(() => {
          if (retiring === shutdown) retiring = null;
        });
        retiring = shutdown;
      }
      return getBrowser();
    }

    // Published before any await, so concurrent callers share one launch.
    const launching = driver.launch();
    browser = launching;
    launches += 1;
    launching.catch(() => {
      if (browser === launching) browser = null;
    });
    return launching;
  }

  /**
   * Runs `work` in a fresh tab and closes the tab afterwards, however `work` ends.
   *
   * `budgetMs` covers launching, opening and the work itself. When it runs out the caller
   * gets a `TabPoolTimeout` at once, and the tab is still closed (or the browser recycled)
   * before its slot is given to anyone else.
   */
  async function use<R>(
    work: (tab: T) => Promise<R>,
    { priority = false, budgetMs }: { priority?: boolean; budgetMs: number },
  ): Promise<R> {
    await admit(priority);

    const slot: { opening: Promise<T> | null; cancelled: boolean } = { opening: null, cancelled: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = (async () => {
        const instance = await getBrowser();
        // The deadline may have passed while the browser was starting; the slot is already
        // being handed back, so opening a tab now would put one outside the count.
        if (slot.cancelled) throw new TabPoolTimeout("Capture was abandoned before its tab opened");
        served += 1;
        if (served >= recycleAfter) draining = true;
        slot.opening = driver.openTab(instance);
        const tab = await slot.opening;
        return work(tab);
      })();
      run.catch(() => undefined);
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TabPoolTimeout(`Capture exceeded ${budgetMs}ms`)), budgetMs);
      });
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
      slot.cancelled = true;
      // Released in the background so the caller is not kept waiting on a slow close; the
      // slot itself is not free until that close has finished.
      void releaseTab(slot.opening);
    }
  }

  async function releaseTab(opening: Promise<T> | null): Promise<void> {
    if (opening) {
      // If the deadline fired while the tab was still opening, wait (bounded) for it to
      // open so it can be closed rather than orphaned.
      const box: { tab?: T } = {};
      const opened = await settledWithin(
        opening.then((value) => {
          box.tab = value;
        }),
        grace,
      );
      let didClose = opened;
      if (opened && box.tab !== undefined) didClose = await settledWithin(driver.closeTab(box.tab), grace);
      if (!didClose) {
        // Still open somewhere; only stopping the browser can be sure of it.
        stuck += 1;
        draining = true;
        settle();
        return;
      }
    }
    tabs -= 1;
    settle();
  }

  async function shutdown(): Promise<void> {
    closed = true;
    for (const entry of waiting.splice(0)) entry.reject(new TabPoolClosed("The browser pool has shut down"));
    const old = browser;
    browser = null;
    if (old) await retire(old);
    if (retiring) await retiring;
  }

  function state(): TabPoolState {
    return { tabs, waiting: waiting.length, max, draining, browserRunning: browser !== null, served, launches };
  }

  return { use, shutdown, state };
}

export type TabPool<B, T> = ReturnType<typeof createTabPool<B, T>>;
