/**
 * "A site cannot trick the local server into reading my machine by changing its DNS."
 *
 * DNS rebinding: a hostile name answers the safety check with a public address and the
 * real connection with 127.0.0.1. These tests run a real HTTP server on loopback, make
 * the check's lookup say "public" and the connection's lookup say "loopback", and assert
 * that the server on loopback never receives a single request.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** What the safety check's lookup (`dns/promises`) answers. */
const checkLookup = vi.hoisted(() => vi.fn());
/** What the connection's lookup (callback `dns.lookup`) answers. */
const connectAnswer = vi.hoisted(() => ({ address: "127.0.0.1", family: 4 }));
/** Lets one test treat loopback as public, to exercise the success path end to end. */
const trustLoopback = vi.hoisted(() => ({ value: false }));

vi.mock("node:dns/promises", () => ({ default: { lookup: checkLookup } }));
vi.mock("node:dns", () => ({
  default: {
    lookup: (_host: string, _options: unknown, callback: (error: null, all: { address: string; family: number }[]) => void) =>
      callback(null, [{ ...connectAnswer }]),
  },
}));
vi.mock("../../shared/ip", async (original) => {
  const actual = await original<typeof import("../../shared/ip")>();
  return {
    ...actual,
    isPrivateAddress: (address: string) =>
      trustLoopback.value && address === "127.0.0.1" ? false : actual.isPrivateAddress(address),
  };
});

const { followedFetch, BlockedUrlError, hostBreaker } = await import("../safe-fetch");

let server: Server;
let port = 0;
let hits: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(request.url ?? "");
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "http://[::ffff:7f00:1]:" + port + "/secret" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html", "x-test": "yes" });
    response.end("<title>hello</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  hits = [];
  trustLoopback.value = false;
  checkLookup.mockReset();
  connectAnswer.address = "127.0.0.1";
  hostBreaker.reset?.();
});

describe("a name that changes its answer between check and connect", () => {
  it("is refused, and the service on loopback never sees the request", async () => {
    checkLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(followedFetch(`http://rebind.example:${port}/`)).rejects.toBeInstanceOf(BlockedUrlError);
    expect(hits).toEqual([]);
  });

  it("is reported as blocked, not as the site being down", async () => {
    checkLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const error = await followedFetch(`http://rebind.example:${port}/`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlockedUrlError);
    expect((error as Error).message).toMatch(/private/i);
  });
});

describe("a site that redirects into the machine", () => {
  it("refuses the hop to an IPv4-mapped loopback address", async () => {
    trustLoopback.value = true; // let the first request reach the test server
    checkLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(followedFetch(`http://site.example:${port}/redirect`)).rejects.toBeInstanceOf(BlockedUrlError);
    expect(hits).toEqual(["/redirect"]);
  });
});

describe("an ordinary page", () => {
  it("is read normally: status, headers and body come through", async () => {
    trustLoopback.value = true;
    checkLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const { response, redirectCount } = await followedFetch(`http://site.example:${port}/page`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-test")).toBe("yes");
    expect(await response.text()).toContain("hello");
    expect(redirectCount).toBe(0);
  });

  it("stops waiting when the caller gives up", async () => {
    trustLoopback.value = true;
    checkLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const slow = createServer(() => undefined); // never answers
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const slowPort = (slow.address() as AddressInfo).port;
    try {
      await expect(followedFetch(`http://slow.example:${slowPort}/`, { timeoutMs: 200 })).rejects.toThrow();
    } finally {
      slow.closeAllConnections?.();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});
