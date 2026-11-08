/**
 * The browser tab pool behind the screenshot service.
 *
 * A fake driver records every launch, open and close, so each test can check the two
 * promises that matter at any library size: no more than five tabs are open at once, and
 * no new browser starts until the previous one has closed.
 */
import { describe, expect, it } from "vitest";
import { createTabPool, TabPoolTimeout } from "../tab-pool";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface FakeBrowser {
  id: number;
  alive: boolean;
}
interface FakeTab {
  id: number;
  browser: FakeBrowser;
}

function fakeDriver(opts: { hangCloseFor?: Set<number>; launchMs?: number } = {}) {
  let nextTab = 0;
  let nextBrowser = 0;
  const log = { maxOpenTabs: 0, maxAliveBrowsers: 0, launches: 0, killed: 0, openTabs: 0 };
  const browsers: FakeBrowser[] = [];
  const aliveBrowsers = () => browsers.filter((b) => b.alive).length;

  const driver = {
    launch: async () => {
      await wait(opts.launchMs ?? 1);
      const browser = { id: nextBrowser++, alive: true };
      browsers.push(browser);
      log.launches += 1;
      log.maxAliveBrowsers = Math.max(log.maxAliveBrowsers, aliveBrowsers());
      return browser;
    },
    openTab: async (browser: FakeBrowser) => {
      await wait(1);
      log.openTabs += 1;
      log.maxOpenTabs = Math.max(log.maxOpenTabs, log.openTabs);
      return { id: nextTab++, browser };
    },
    closeTab: async (tab: FakeTab) => {
      if (opts.hangCloseFor?.has(tab.id)) return new Promise<void>(() => undefined);
      await wait(2);
      log.openTabs -= 1;
    },
    closeBrowser: async (browser: FakeBrowser) => {
      await wait(2);
      browser.alive = false;
    },
    killBrowser: (browser: FakeBrowser) => {
      if (browser.alive) log.killed += 1;
      browser.alive = false;
    },
    isAlive: (browser: FakeBrowser) => browser.alive,
  };
  return { driver, log, aliveBrowsers };
}

describe("createTabPool", () => {
  it("never opens more than five tabs, even when configured higher", async () => {
    const { driver, log } = fakeDriver();
    const pool = createTabPool(driver, { maxTabs: 50, recycleAfter: 1000, closeGraceMs: 200 });
    expect(pool.state().max).toBe(5);

    await Promise.all(
      Array.from({ length: 60 }, () => pool.use(() => wait(3), { budgetMs: 5_000 })),
    );
    await wait(20);
    expect(log.maxOpenTabs).toBeLessThanOrEqual(5);
    expect(log.openTabs).toBe(0);
    expect(pool.state().tabs).toBe(0);
    expect(log.launches).toBe(1);
  });

  it("keeps a slot taken until its tab has actually closed", async () => {
    const { driver, log } = fakeDriver();
    const pool = createTabPool(driver, { maxTabs: 2, recycleAfter: 1000, closeGraceMs: 200 });

    await Promise.all(Array.from({ length: 12 }, () => pool.use(() => wait(1), { budgetMs: 5_000 })));
    await wait(20);
    // If a slot were freed before close, a third tab would overlap two still closing.
    expect(log.maxOpenTabs).toBeLessThanOrEqual(2);
  });

  it("restarts the browser after a set number of captures, closing the old one first", async () => {
    const { driver, log } = fakeDriver();
    const pool = createTabPool(driver, { maxTabs: 5, recycleAfter: 10, closeGraceMs: 200 });

    await Promise.all(Array.from({ length: 35 }, () => pool.use(() => wait(2), { budgetMs: 5_000 })));
    await wait(30);
    expect(log.launches).toBeGreaterThanOrEqual(3);
    expect(log.maxAliveBrowsers).toBe(1);
    expect(log.maxOpenTabs).toBeLessThanOrEqual(5);
  });

  it("recycles the browser when a tab will not close, instead of leaking the slot", async () => {
    const { driver, log } = fakeDriver({ hangCloseFor: new Set([0]) });
    const pool = createTabPool(driver, { maxTabs: 1, recycleAfter: 1000, closeGraceMs: 20 });

    await pool.use(() => wait(1), { budgetMs: 5_000 });
    // With one slot and a stuck tab, this would hang forever without the recycle.
    await pool.use(() => wait(1), { budgetMs: 5_000 });
    expect(log.launches).toBe(2);
    expect(log.maxAliveBrowsers).toBe(1);
  });

  it("times out a capture that never finishes and still frees its slot", async () => {
    const { driver } = fakeDriver();
    const pool = createTabPool(driver, { maxTabs: 1, recycleAfter: 1000, closeGraceMs: 20 });

    await expect(pool.use(() => new Promise(() => undefined), { budgetMs: 30 })).rejects.toBeInstanceOf(
      TabPoolTimeout,
    );
    await expect(pool.use(async () => "ok", { budgetMs: 1_000 })).resolves.toBe("ok");
  });

  it("does not open a tab for a capture that timed out while the browser was starting", async () => {
    const { driver, log } = fakeDriver({ launchMs: 60 });
    const pool = createTabPool(driver, { maxTabs: 1, recycleAfter: 1000, closeGraceMs: 20 });

    await expect(pool.use(async () => "late", { budgetMs: 10 })).rejects.toBeInstanceOf(TabPoolTimeout);
    await wait(100);
    expect(log.openTabs).toBe(0);
    expect(pool.state().tabs).toBe(0);
  });

  it("serves priority work first", async () => {
    const { driver } = fakeDriver();
    const pool = createTabPool(driver, { maxTabs: 1, recycleAfter: 1000, closeGraceMs: 200 });
    const order: string[] = [];

    const first = pool.use(() => wait(5), { budgetMs: 5_000 });
    const background = pool.use(async () => void order.push("background"), { budgetMs: 5_000 });
    const person = pool.use(async () => void order.push("person"), { budgetMs: 5_000, priority: true });
    await Promise.all([first, background, person]);
    expect(order).toEqual(["person", "background"]);
  });

  it("shuts the browser down and refuses new work", async () => {
    const { driver, aliveBrowsers } = fakeDriver();
    const pool = createTabPool(driver, { maxTabs: 2, recycleAfter: 1000, closeGraceMs: 50 });
    await pool.use(() => wait(1), { budgetMs: 5_000 });
    await pool.shutdown();
    expect(aliveBrowsers()).toBe(0);
    await expect(pool.use(() => wait(1), { budgetMs: 5_000 })).rejects.toThrow();
  });
});
