/**
 * The local log behind "Copy diagnostics". It must be useful in a bug report and must never
 * reveal which pages someone saved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLog, diagnosticsReport, log, recentLog, redact } from "../log";

beforeEach(() => {
  clearLog();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("log", () => {
  it("reduces addresses to their site", () => {
    expect(redact("failed https://bank.example/account/123?token=secret#x")).toBe("failed https://bank.example/…");
  });

  it("redacts inside error messages and nested details", () => {
    log.error("test.event", { error: new Error("could not load https://private.example/a/b"), nested: { url: "https://x.example/p?q=1" } });
    const [entry] = recentLog();
    const text = JSON.stringify(entry);
    expect(text).not.toContain("/a/b");
    expect(text).not.toContain("q=1");
    expect(text).toContain("private.example");
    expect(entry.severity).toBe("error");
  });

  it("keeps a bounded history", () => {
    for (let index = 0; index < 500; index += 1) log.info("tick", { index });
    expect(recentLog().length).toBe(200);
    expect(recentLog()[199].details.index).toBe(499);
  });

  it("survives details that cannot be serialised", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => log.warn("loop", { loop })).not.toThrow();
    expect(() => diagnosticsReport()).not.toThrow();
  });

  it("writes a report with the environment and the events", () => {
    log.warn("storage.write-failed", { kind: "quota" });
    const report = diagnosticsReport({ unsavedChanges: 3 });
    expect(report).toContain("storage.write-failed");
    expect(report).toContain("unsavedChanges: 3");
  });
});
