/**
 * The app's own image store.
 *
 * This module is the reason the library keeps working when the browser empties its cache,
 * when the network goes, and when the same shelf is opened in a second browser — so the
 * properties worth pinning down are not "does it fetch", they are:
 *
 *   · bytes are fetched **once**, ever, and then come from disk;
 *   · a screenshot that does not exist yet is a *distinct answer* from a failure, and is
 *     re-askable once the capture pipeline has produced one;
 *   · the browser's HTTP cache is bypassed, because storing every screenshot twice on the
 *     same disk — once visibly, once invisibly — is the exact thing this replaced;
 *   · the store stays inside its budget without ever evicting something on screen.
 *
 * `fake-indexeddb` stands in for the browser's database; everything else is real.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Assets = typeof import("../assets");

let assets: Assets;
let fetchMock: ReturnType<typeof vi.fn>;

/** A tiny but valid image payload; only its type and size matter here. */
function imageResponse(bytes = 64, type = "image/webp") {
  return {
    ok: true,
    blob: async () => new Blob([new Uint8Array(bytes)], { type }),
  };
}

function notFound() {
  return { ok: false, blob: async () => new Blob([]) };
}

let objectUrlCounter = 0;

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetchMock);
  // Node has no object URLs; the store only needs an opaque, unique string back.
  URL.createObjectURL = () => `blob:test/${(objectUrlCounter += 1)}`;
  URL.revokeObjectURL = () => undefined;

  assets = await import("../assets");
  await assets.initAssets();
  /*
   * Emptied rather than deleted between tests.
   *
   * `deleteDatabase` blocks while any connection is open, and `vi.resetModules()` leaves
   * the previous module instance holding one — so deleting deadlocks the suite instead of
   * isolating it. Clearing the stores does the same job without closing anything.
   */
  await assets.clearAssets();
  assets.setAssetBudget(1024);
});

describe("keys", () => {
  it("separates the same page's screenshots by device", () => {
    expect(assets.assetKey("shot", "https://a.example/", "desktop")).not.toBe(
      assets.assetKey("shot", "https://a.example/", "mobile"),
    );
  });

  it("does not put a device in a key that has no device", () => {
    expect(assets.assetKey("image", "https://a.example/og.png")).toBe(
      "image:https://a.example/og.png",
    );
    expect(assets.assetKey("icon", "a.example")).toBe("icon:a.example");
  });
});

describe("fetching", () => {
  it("fetches once and then answers from memory", async () => {
    const key = assets.assetKey("icon", "a.example");
    const first = await assets.ensureAsset(key, "/api/favicon?domain=a.example");
    expect(first).toMatch(/^blob:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Synchronously, with no await at all — this is the path that lets a warmed card
    // render its real image on its very first frame.
    expect(assets.peekAsset(key)).toBe(first);

    await assets.ensureAsset(key, "/api/favicon?domain=a.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Storing the bytes twice on the same disk — once here, once in a cache the app cannot
   * see, measure or clear — is the specific problem this module was written to remove.
   */
  it("bypasses the browser cache on the way in", async () => {
    await assets.ensureAsset(assets.assetKey("icon", "a.example"), "/api/favicon?domain=a.example");
    // Matched by the fields that carry the meaning rather than by the whole options
    // object: the claim under test is "no second copy in the browser's cache", and an
    // exact-match assertion breaks whenever an unrelated option is added.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/favicon?domain=a.example",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  /**
   * Every asset fetch holds one of six concurrency slots and releases it in a `finally`.
   * A fetch with no deadline never reaches that `finally`, so a handful of hung requests
   * retires every slot and the loader stops fetching anything — silently, with an empty
   * grid as the only symptom. The signal is the whole defence, so it is asserted.
   */
  it("gives every asset fetch a deadline, so a hung request cannot retire a slot", async () => {
    await assets.ensureAsset(assets.assetKey("icon", "a.example"), "/api/favicon?domain=a.example");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("collapses concurrent requests for the same key into one fetch", async () => {
    const key = assets.assetKey("icon", "a.example");
    const url = "/api/favicon?domain=a.example";
    const [a, b, c] = await Promise.all([
      assets.ensureAsset(key, url),
      assets.ensureAsset(key, url),
      assets.ensureAsset(key, url),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("counts what it is holding", async () => {
    await assets.ensureAsset(assets.assetKey("icon", "a.example"), "/a");
    await assets.ensureAsset(assets.assetKey("icon", "b.example"), "/b");

    const stats = assets.assetStats();
    expect(stats.count).toBe(2);
    expect(stats.bytes).toBe(128);
  });
});

describe("absence", () => {
  /**
   * "Nothing captured yet" is the normal state of a freshly imported library, not an
   * error — and the card that gets it falls through to its next preview tier rather than
   * showing a broken image.
   */
  it("answers null when the source has nothing, and remembers it briefly", async () => {
    fetchMock.mockResolvedValue(notFound());
    const key = assets.assetKey("shot", "https://a.example/");

    expect(await assets.ensureAsset(key, "/api/screenshot?url=a")).toBeNull();
    expect(assets.assetMissed(key)).toBe(true);

    // Remembered, so scrolling past the same uncaptured card does not re-request a 404 on
    // every pass.
    await assets.ensureAsset(key, "/api/screenshot?url=a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a non-image response as nothing rather than storing it", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["<html>404</html>"], { type: "text/html" }),
    });

    expect(await assets.ensureAsset(assets.assetKey("icon", "a.example"), "/a")).toBeNull();
    expect(assets.assetStats().count).toBe(0);
  });

  it("survives a fetch that throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(
      assets.ensureAsset(assets.assetKey("icon", "a.example"), "/a"),
    ).resolves.toBeNull();
  });
});

describe("invalidation", () => {
  /**
   * The screenshot endpoint's URL does not change when a page is re-rendered, so nothing
   * about an `<img src>` would tell a card that the bytes behind it are now different
   * ones. Dropping the key is what does — and it has to clear the *miss* too, or a card
   * that asked a moment before the capture landed stays grey until the miss expires.
   */
  it("forgetting a key clears the bytes, the miss and the subscribers", async () => {
    const key = assets.assetKey("shot", "https://a.example/", "desktop");
    await assets.ensureAsset(key, "/api/screenshot?url=a");
    expect(assets.peekAsset(key)).toBeTruthy();

    const seen = vi.fn();
    assets.subscribeAsset(key, seen);

    await assets.forgetAsset(key);

    expect(assets.peekAsset(key)).toBeUndefined();
    expect(assets.assetMissed(key)).toBe(false);
    expect(assets.assetStats().count).toBe(0);
    expect(seen).toHaveBeenCalled();

    // And the next ask really does go back to the network.
    await assets.ensureAsset(key, "/api/screenshot?url=a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("notifies a waiting card when its bytes land", async () => {
    const key = assets.assetKey("shot", "https://a.example/");
    const seen = vi.fn();
    assets.subscribeAsset(key, seen);

    await assets.ensureAsset(key, "/api/screenshot?url=a");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("clearing empties the store", async () => {
    await assets.ensureAsset(assets.assetKey("icon", "a.example"), "/a");
    await assets.clearAssets();

    expect(assets.assetStats()).toMatchObject({ count: 0, bytes: 0 });
  });
});

describe("durability", () => {
  /**
   * The whole point: a second session reads the bytes off disk instead of asking the
   * network again. Simulated by re-importing the module — a fresh set of module-level maps
   * against the same database, which is exactly what a reload is.
   */
  it("a second session reads from disk rather than the network", async () => {
    const key = assets.assetKey("icon", "a.example");
    await assets.ensureAsset(key, "/api/favicon?domain=a.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const reloaded: Assets = await import("../assets");
    await reloaded.initAssets();

    expect(reloaded.assetStats().count).toBe(1);
    const url = await reloaded.ensureAsset(key, "/api/favicon?domain=a.example");
    expect(url).toMatch(/^blob:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the budget", () => {
  /**
   * The store is bounded, and the bound is enforced by dropping what has been looked at
   * least recently — never by refusing to store something new, which would leave the app
   * permanently unable to show whatever the user navigated to next.
   */
  it("evicts down under the budget", async () => {
    // 1 MB budget against 300 KB assets: room for three, then eviction.
    assets.setAssetBudget(1);
    fetchMock.mockResolvedValue(imageResponse(300_000));

    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      await assets.ensureAsset(assets.assetKey("image", `https://${name}.example/x.png`), `/${name}`);
      // Release the live URL, or nothing is evictable: an asset on screen is never dropped
      // out from under the card showing it.
      await Promise.resolve();
    }

    const stats = assets.assetStats();
    expect(stats.bytes).toBeLessThanOrEqual(stats.budget);
  });

  it("never evicts something that is still on screen", async () => {
    assets.setAssetBudget(1);
    fetchMock.mockResolvedValue(imageResponse(400_000));

    const keys = ["a", "b", "c", "d"].map((name) => assets.assetKey("image", `https://${name}.example/x.png`));
    for (const key of keys) await assets.ensureAsset(key, "/x");

    // Every one of these is materialised, so the eviction pass has nothing it may take —
    // and must leave the store over budget rather than break a visible card.
    for (const key of keys) expect(assets.peekAsset(key)).toBeTruthy();
  });
});
