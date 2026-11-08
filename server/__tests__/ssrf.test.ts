/**
 * The screenshot renderer's subresource filter.
 *
 * ## What was wrong
 *
 * `capture()` validates the URL it navigates to — scheme, then DNS, refusing private
 * address space. A page, however, is not one request. It pulls stylesheets, images,
 * scripts and fonts, and each of those went through a filter that checked only for the
 * literal strings `localhost`, `*.local`, `*.internal` and for addresses written as bare
 * IPs.
 *
 * That misses the case the check exists for. An attacker does not put `http://127.0.0.1`
 * in an image tag; they point `assets.evil.example` at 127.0.0.1 in their own DNS and use
 * that. The name matches none of the patterns, so the request was allowed, and Chrome —
 * running on the host, inside the network — made it. Cloud metadata endpoints, a Redis
 * port, a router admin page and anything else bound to loopback were all reachable from a
 * page the user merely bookmarked.
 *
 * The fix resolves the hostname and applies the same rules the outbound fetcher uses. The
 * tests that matter are therefore the ones about names, not about literals: the literal
 * cases passed before the fix as well.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ default: { lookup } }));

const { resetDnsVerdicts, resolvesToPrivateAddress } = await import("../screenshot");

beforeEach(() => {
  lookup.mockReset();
  resetDnsVerdicts();
});

afterEach(() => {
  resetDnsVerdicts();
});

describe("hosts refused without a lookup", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "printer.local",
    "vault.internal",
    "app.localhost",
    "router.home.arpa",
  ])("refuses %s by name", async (host) => {
    expect(await resolvesToPrivateAddress(host)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "169.254.169.254",
    "::1",
    "[::1]",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
  ])("refuses the literal address %s", async (host) => {
    expect(await resolvesToPrivateAddress(host)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses an empty host", async () => {
    expect(await resolvesToPrivateAddress("")).toBe(true);
  });
});

describe("hosts that need resolving", () => {
  /**
   * The defect, stated directly: an ordinary-looking name whose A record points at
   * loopback. Before the fix this returned `false` and the request was made.
   */
  it("refuses a public-looking name that resolves to loopback", async () => {
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await resolvesToPrivateAddress("assets.evil.example")).toBe(true);
  });

  it("refuses a name that resolves to the cloud metadata address", async () => {
    lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    expect(await resolvesToPrivateAddress("metadata.evil.example")).toBe(true);
  });

  /**
   * A name with several records is only as safe as its least safe one. Answering on the
   * first record would let an attacker pair one public address with one private address
   * and win whenever the browser picked the second.
   */
  it("refuses a name where any one record is private", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.1.2.3", family: 4 },
    ]);
    expect(await resolvesToPrivateAddress("split.evil.example")).toBe(true);
  });

  it("allows an ordinary public host", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    expect(await resolvesToPrivateAddress("cdn.example.com")).toBe(false);
  });
});

describe("failing closed", () => {
  it("refuses when the lookup throws", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await resolvesToPrivateAddress("nowhere.example")).toBe(true);
  });

  /** An empty answer is not permission to proceed. */
  it("refuses when the lookup returns nothing", async () => {
    lookup.mockResolvedValue([]);
    expect(await resolvesToPrivateAddress("empty.example")).toBe(true);
  });
});

describe("the verdict cache", () => {
  it("resolves a repeated host once", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await resolvesToPrivateAddress("cdn.example.com");
    await resolvesToPrivateAddress("cdn.example.com");
    await resolvesToPrivateAddress("cdn.example.com");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  /**
   * Caching a verdict must not cache it for the wrong host — the failure that would turn
   * a performance optimisation into the hole it was meant to help close.
   */
  it("keeps verdicts separate per host", async () => {
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    expect(await resolvesToPrivateAddress("good.example")).toBe(false);
    expect(await resolvesToPrivateAddress("bad.example")).toBe(true);
  });

  it("stays bounded under many distinct hosts", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    for (let i = 0; i < 700; i += 1) {
      await resolvesToPrivateAddress(`host-${i}.example`);
    }
    // Every host was resolved, so nothing was served a wrong verdict from a full cache.
    expect(lookup).toHaveBeenCalledTimes(700);
  });
});
