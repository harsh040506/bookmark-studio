/**
 * Environment-variable validation.
 *
 * The idiom this replaces — `Number(process.env.X ?? default)` — has no failure mode that
 * looks like a failure. Each bad value produces a number, the number flows into a
 * comparison, and the comparison quietly stops meaning what it was written to mean:
 *
 *   - `NaN` in the tab gate makes `active < max` false forever, so the gate admits nobody
 *     and every screenshot request waits indefinitely with nothing logged.
 *   - `NaN` in the cache budget makes `total <= max` false forever, so the prune that was
 *     meant to trim the cache deletes all of it instead.
 *   - `0` from an empty `PORT` binds a random free port, so the server starts successfully
 *     somewhere nobody is looking.
 *
 * These tests pin the boundaries, because a validator is only worth having if it rejects
 * the values that actually get typed into shell profiles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { intFromEnv, portFromEnv, resetConfigWarnings } from "../config";

const NAME = "TEST_SETTING";

beforeEach(() => {
  resetConfigWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env[NAME];
  vi.restoreAllMocks();
  resetConfigWarnings();
});

describe("intFromEnv", () => {
  it("uses the fallback when the variable is unset", () => {
    expect(intFromEnv(NAME, 3)).toBe(3);
  });

  /** Set-but-empty is the one that used to become `0` silently. */
  it("uses the fallback when the variable is set but empty", () => {
    process.env[NAME] = "";
    expect(intFromEnv(NAME, 3)).toBe(3);
    process.env[NAME] = "   ";
    expect(intFromEnv(NAME, 3)).toBe(3);
  });

  it("accepts a valid value", () => {
    process.env[NAME] = "8";
    expect(intFromEnv(NAME, 3)).toBe(8);
  });

  it.each(["abc", "auto", "512MB", "1e", "NaN", "Infinity"])(
    "falls back on the unparseable value %s",
    (raw) => {
      process.env[NAME] = raw;
      expect(intFromEnv(NAME, 3)).toBe(3);
    },
  );

  it("falls back on a non-integer", () => {
    process.env[NAME] = "2.5";
    expect(intFromEnv(NAME, 3)).toBe(3);
  });

  it("falls back below the minimum", () => {
    process.env[NAME] = "0";
    expect(intFromEnv(NAME, 3, { min: 1 })).toBe(3);
    process.env[NAME] = "-4";
    expect(intFromEnv(NAME, 3, { min: 1 })).toBe(3);
  });

  it("falls back above the maximum", () => {
    process.env[NAME] = "10000";
    expect(intFromEnv(NAME, 3, { min: 1, max: 32 })).toBe(3);
  });

  it("accepts the exact bounds", () => {
    process.env[NAME] = "1";
    expect(intFromEnv(NAME, 3, { min: 1, max: 32 })).toBe(1);
    process.env[NAME] = "32";
    expect(intFromEnv(NAME, 3, { min: 1, max: 32 })).toBe(32);
  });

  /**
   * A misconfiguration the operator cannot see is the whole problem being solved, so the
   * warning is part of the contract rather than a nicety.
   */
  it("warns about a bad value", () => {
    process.env[NAME] = "auto";
    intFromEnv(NAME, 3);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(NAME));
  });

  it("warns only once, so a repeated read cannot flood the log", () => {
    process.env[NAME] = "auto";
    intFromEnv(NAME, 3);
    intFromEnv(NAME, 3);
    intFromEnv(NAME, 3);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a valid value", () => {
    process.env[NAME] = "4";
    intFromEnv(NAME, 3);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("portFromEnv", () => {
  it("accepts an ordinary port", () => {
    process.env[NAME] = "3000";
    expect(portFromEnv(NAME, 5174)).toBe(3000);
  });

  /**
   * Zero is a legal argument to `listen` — it means "any free port" — and is never what
   * was intended for a server whose client is pointed at a fixed address.
   */
  it("refuses port 0", () => {
    process.env[NAME] = "0";
    expect(portFromEnv(NAME, 5174)).toBe(5174);
  });

  it("refuses a port above the legal range", () => {
    process.env[NAME] = "70000";
    expect(portFromEnv(NAME, 5174)).toBe(5174);
  });
});
