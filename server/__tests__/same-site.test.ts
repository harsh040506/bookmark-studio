import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiApp, hostAllowed } from "../app";

let port = 0;
let close: () => void = () => undefined;

beforeAll(async () => {
  const server = createApiApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
  close = () => server.close();
});
afterAll(() => close());

function ping(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/ping", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the local API answers only its own app", () => {
  it("accepts loopback hosts", async () => {
    expect(await ping({ host: `127.0.0.1:${port}` })).toBe(200);
    expect(await ping({ host: `localhost:${port}` })).toBe(200);
  });

  it("refuses a rebound foreign hostname", async () => {
    expect(await ping({ host: "attacker.example:5174" })).toBe(403);
  });

  it("refuses cross-site browser requests", async () => {
    expect(await ping({ host: `127.0.0.1:${port}`, origin: "https://evil.example" })).toBe(403);
    expect(await ping({ host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" })).toBe(403);
  });

  it("accepts the app's own origin", async () => {
    expect(await ping({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" })).toBe(200);
  });

  it("matches hosts case-insensitively and rejects a missing host", () => {
    expect(hostAllowed("LOCALHOST:80")).toBe(true);
    expect(hostAllowed(undefined)).toBe(false);
    expect(hostAllowed("127.0.0.1.evil.example")).toBe(false);
  });
});
