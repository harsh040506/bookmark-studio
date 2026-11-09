/**
 * "A bookmark must never be a way into my own network."
 *
 * Every case goes through `new URL()` first, because that is what the real code sees. The
 * old tests passed the dotted string `::ffff:127.0.0.1` straight to the check, a spelling
 * the URL parser never produces (it rewrites it to `[::ffff:7f00:1]`), so they passed
 * while the guard let loopback through.
 */
import { describe, expect, it } from "vitest";
import { isLocalHostname, isPrivateAddress } from "../../../shared/ip";
import { assertPlausiblyPublic, BlockedUrlError } from "../net-guard";

const hostOf = (url: string) => new URL(url).hostname;

describe("a bookmark that points into your own network is refused", () => {
  it.each([
    ["loopback, written plainly", "http://127.0.0.1:6379/"],
    ["loopback, as the URL parser rewrites an IPv4-mapped address", "http://[::ffff:127.0.0.1]:8080/"],
    ["loopback, IPv4-mapped written in hex", "http://[::ffff:7f00:1]/"],
    ["loopback, IPv4-translated form", "http://[::ffff:0:127.0.0.1]/"],
    ["loopback, deprecated IPv4-compatible form", "http://[::127.0.0.1]/"],
    ["loopback through NAT64", "http://[64:ff9b::127.0.0.1]/"],
    ["loopback through 6to4", "http://[2002:7f00:1::]/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["the unspecified address", "http://[::]/"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["cloud metadata, IPv4-mapped", "http://[::ffff:169.254.169.254]/"],
    ["a home router", "http://192.168.1.1/"],
    ["a home router, IPv4-mapped", "http://[::ffff:c0a8:101]/"],
    ["an office network", "http://10.20.30.40/"],
    ["a 172.16/12 network", "http://172.20.0.5/"],
    ["carrier-grade NAT", "http://100.64.0.1/"],
    ["loopback written as one decimal number", "http://2130706433/"],
    ["loopback written in hex", "http://0x7f.0.0.1/"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    ["IPv6 unique-local", "http://[fd12:3456::1]/"],
    ["multicast", "http://224.0.0.1/"],
    ["a documentation-only address", "http://192.0.2.10/"],
  ])("refuses %s", (_label, url) => {
    expect(isPrivateAddress(hostOf(url))).toBe(true);
    expect(() => assertPlausiblyPublic(url)).toThrow(BlockedUrlError);
  });

  it.each([
    "http://localhost:3000/",
    "http://localhost./admin",
    "http://printer.local/",
    "http://vault.internal/",
    "http://dev.localhost/",
    "http://router.home.arpa/",
  ])("refuses the local name %s, including with a trailing dot", (url) => {
    expect(isLocalHostname(hostOf(url))).toBe(true);
    expect(() => assertPlausiblyPublic(url)).toThrow(BlockedUrlError);
  });

  it("refuses addresses that carry a password, which would be sent to the site", () => {
    expect(() => assertPlausiblyPublic("https://user:secret@example.com/")).toThrow(BlockedUrlError);
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "ftp://example.com/"])(
    "refuses %s, which is not a web page to read",
    (url) => {
      expect(() => assertPlausiblyPublic(url)).toThrow(BlockedUrlError);
    },
  );

  it("refuses something that is not an address at all", () => {
    expect(() => assertPlausiblyPublic("not a url")).toThrow(BlockedUrlError);
  });
});

describe("ordinary public sites still work", () => {
  it.each([
    "https://example.com/",
    "https://93.184.216.34/",
    "https://[2606:2800:220:1:248:1893:25c8:1946]/",
    "https://[::ffff:93.184.216.34]/",
    "https://8.8.8.8/",
    "https://172.32.0.1/", // just outside 172.16/12
    "https://my-local-bakery.com/", // "local" inside a name is fine
  ])("allows %s", (url) => {
    expect(() => assertPlausiblyPublic(url)).not.toThrow();
  });
});

describe("addresses the classifier cannot read are treated as unsafe", () => {
  it.each(["", "999.1.1.1", "1.2.3", ":::1", "fe80::zz", "1:2:3:4:5:6:7:8:9"])("treats %j as private", (value) => {
    expect(isPrivateAddress(value)).toBe(true);
  });
});
