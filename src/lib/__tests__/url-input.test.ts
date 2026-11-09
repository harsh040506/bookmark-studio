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

describe("sharing a link from a phone into the installed app", () => {
  it("takes the link from the URL field when the sharing app fills it", async () => {
    const { sharedLink } = await import("../url-input");
    expect(sharedLink("?share_url=https%3A%2F%2Fexample.com%2Fa")).toBe("https://example.com/a");
  });

  it("finds the link inside the text, where most Android apps put it", async () => {
    const { sharedLink } = await import("../url-input");
    const text = encodeURIComponent("Worth a read: https://blog.example.com/post?id=4).");
    expect(sharedLink(`?share_title=Hi&share_text=${text}`)).toBe("https://blog.example.com/post?id=4");
  });

  it("refuses anything that is not a web address", async () => {
    const { sharedLink } = await import("../url-input");
    expect(sharedLink(`?share_text=${encodeURIComponent("javascript:alert(1)")}`)).toBeNull();
    expect(sharedLink("?share_text=just%20some%20words")).toBeNull();
    expect(sharedLink("")).toBeNull();
  });
});
