import { describe, expect, it } from "vitest";

import { normalizeUserUrl, pastedLink } from "../url-input";

describe("turning typed text into a bookmark address", () => {
  it("adds https:// when it is missing", () => {
    expect(normalizeUserUrl("example.com/a?b=1")).toEqual({ ok: true, url: "https://example.com/a?b=1" });
    expect(normalizeUserUrl("  www.example.com  ")).toEqual({ ok: true, url: "https://www.example.com/" });
  });

  it("keeps http, https and ftp addresses", () => {
    expect(normalizeUserUrl("http://example.com").ok).toBe(true);
    expect(normalizeUserUrl("ftp://files.example.com/x").ok).toBe(true);
  });

  it("reads host:port as a host, not a scheme", () => {
    expect(normalizeUserUrl("localhost:3000/app")).toEqual({ ok: true, url: "https://localhost:3000/app" });
  });

  it("refuses script and data links", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "chrome://settings"]) {
      const result = normalizeUserUrl(value);
      expect(result.ok).toBe(false);
    }
  });

  it("explains what is wrong", () => {
    expect(normalizeUserUrl("")).toEqual({ ok: false, error: "Enter a web address." });
    expect(normalizeUserUrl("two words")).toMatchObject({ ok: false });
    expect(normalizeUserUrl("notasite")).toMatchObject({ ok: false, error: expect.stringContaining("full site name") });
    expect(normalizeUserUrl(`https://example.com/${"a".repeat(3000)}`)).toMatchObject({ ok: false });
  });
});

describe("recognising a pasted link", () => {
  it("accepts a lone http(s) or www link", () => {
    expect(pastedLink("https://example.com/x")).toBe("https://example.com/x");
    expect(pastedLink("www.example.com")).toBe("https://www.example.com/");
  });

  it("ignores prose, bare words and unsafe schemes", () => {
    expect(pastedLink("see https://example.com")).toBeNull();
    expect(pastedLink("example")).toBeNull();
    expect(pastedLink("javascript:alert(1)")).toBeNull();
    expect(pastedLink("")).toBeNull();
  });
});
