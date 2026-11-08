/**
 * Typo-tolerant search.
 *
 * The behaviour worth pinning down is not "it corrects things" — it is *when it declines
 * to*. A correction that fires too eagerly turns a search for a real word into a search
 * for a different one, and the user has no way to tell that happened.
 */
import { describe, expect, it } from "vitest";
import { editDistance, expandQuery, Vocabulary } from "../fuzzy";

const LIBRARY = new Vocabulary([
  "clipboard",
  "manager",
  "figma",
  "design",
  "react",
  "typescript",
  "bookmark",
  "screenshot",
  "cat",
  "dog",
]);

describe("editDistance", () => {
  it("is zero for identical strings", () => {
    expect(editDistance("figma", "figma", 2)).toBe(0);
  });

  it("counts a single substitution, insertion or deletion as one", () => {
    expect(editDistance("figma", "figna", 2)).toBe(1);
    expect(editDistance("figma", "figmar", 2)).toBe(1);
    expect(editDistance("figma", "figm", 2)).toBe(1);
  });

  it("gives up rather than computing a distance past the budget", () => {
    // Not the true distance — just "more than you asked about", which is all the caller
    // needs and is what makes the early exit safe.
    expect(editDistance("cat", "elephant", 1)).toBeGreaterThan(1);
  });

  it("rejects on length difference alone, without walking the matrix", () => {
    expect(editDistance("a", "abcdefgh", 2)).toBeGreaterThan(2);
  });
});

describe("Vocabulary", () => {
  it("returns a known word unchanged, and offers nothing else", () => {
    expect(LIBRARY.expand("figma")).toEqual([{ term: "figma", distance: 0 }]);
  });

  it("corrects a one-letter typo to the word the library actually has", () => {
    const [best] = LIBRARY.expand("clipbord");
    expect(best?.term).toBe("clipboard");
  });

  it("completes a half-typed word by prefix", () => {
    const [best] = LIBRARY.expand("clipb");
    expect(best?.term).toBe("clipboard");
  });

  it("leaves a short word alone, where a typo is unrecoverable anyway", () => {
    // "ca" is one edit from both "cat" and — via the vocabulary — nothing useful.
    expect(LIBRARY.expand("ca")).toEqual([]);
  });

  /**
   * The failure that matters: correcting across meanings.
   *
   * At an unbounded edit distance "cat" reaches "dog" in three steps. A search that
   * quietly did that would be worse than one that found nothing.
   */
  it("never corrects one real word into an unrelated one", () => {
    const suggestions = LIBRARY.expand("cot").map((entry) => entry.term);
    expect(suggestions).not.toContain("dog");
  });

  it("offers nothing for a word with no plausible neighbour", () => {
    expect(LIBRARY.expand("xylophone")).toEqual([]);
  });

  it("knows which terms it holds", () => {
    expect(LIBRARY.has("react")).toBe(true);
    expect(LIBRARY.has("angular")).toBe(false);
  });
});

describe("expandQuery", () => {
  it("reports what it corrected rather than rewriting silently", () => {
    const result = expandQuery(["clipbord"], LIBRARY);
    expect(result.corrections).toEqual([{ from: "clipbord", to: "clipboard" }]);
    expect(result.terms).toContain("clipboard");
  });

  it("reports no correction when every term was already known", () => {
    const result = expandQuery(["figma", "design"], LIBRARY);
    expect(result.corrections).toEqual([]);
    expect(result.terms).toEqual(["figma", "design"]);
  });

  it("keeps an unrecognised term rather than dropping it", () => {
    // The substring fallback in `selectBookmarks` may still match it, so discarding it
    // here would lose a result the app can otherwise find.
    const result = expandQuery(["xylophone"], LIBRARY);
    expect(result.terms).toContain("xylophone");
  });

  it("corrects one term in a phrase and leaves the rest", () => {
    const result = expandQuery(["clipbord", "manager"], LIBRARY);
    expect(result.terms).toContain("clipboard");
    expect(result.terms).toContain("manager");
    expect(result.corrections).toHaveLength(1);
  });

  it("de-duplicates when two typed terms correct to the same word", () => {
    const result = expandQuery(["clipbord", "clipboatd"], LIBRARY);
    expect(result.terms.filter((term) => term === "clipboard")).toHaveLength(1);
  });
});
