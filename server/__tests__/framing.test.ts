/**
 * The framing decision is what stops the preview from claiming "Live" over an empty box,
 * so it gets its own tests. Pure header logic — no server needed.
 */
import { describe, expect, it } from "vitest";
import { evaluateFraming } from "../routes";

describe("evaluateFraming", () => {
  it("blocks on X-Frame-Options DENY and SAMEORIGIN", () => {
    expect(evaluateFraming("DENY", null).frameable).toBe(false);
    expect(evaluateFraming("SAMEORIGIN", null).frameable).toBe(false);
    expect(evaluateFraming("sameorigin", null).frameable).toBe(false);
  });

  it("allows pages with no framing headers", () => {
    expect(evaluateFraming(null, null).frameable).toBe(true);
    expect(evaluateFraming(null, "default-src 'self'").frameable).toBe(true);
  });

  it("honours CSP frame-ancestors", () => {
    expect(evaluateFraming(null, "frame-ancestors 'none'").frameable).toBe(false);
    expect(evaluateFraming(null, "frame-ancestors *").frameable).toBe(true);
    expect(evaluateFraming(null, "frame-ancestors 'self' https://cms.example.com").frameable).toBe(false);
  });

  it("lets frame-ancestors override a permissive X-Frame-Options", () => {
    // CSP supersedes XFO where both are present.
    expect(evaluateFraming(null, "default-src 'self'; frame-ancestors 'none'").frameable).toBe(false);
  });

  it("explains the reason so the UI can say why", () => {
    expect(evaluateFraming("DENY", null).reason).toMatch(/DENY/);
    expect(evaluateFraming(null, "frame-ancestors 'none'").reason).toMatch(/frame-ancestors/);
  });
});
