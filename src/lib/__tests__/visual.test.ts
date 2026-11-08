/**
 * The visual-similarity maths.
 *
 * The comparison functions are tested rather than the indexer: `indexImage` needs a real
 * canvas and a real decoder, which is an integration concern, while the scoring is pure
 * arithmetic and is where an error would be both silent and wrong in a way nobody could
 * see — a likeness percentage is plausible whatever it says.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark } from "../../../shared/types";
import {
  binForHex,
  COLOR_WHEEL,
  colorScore,
  findLookalikes,
  groupLookalikes,
  hammingDistance,
  likeness,
  paletteScore,
  structureScore,
  SAME_PICTURE,
} from "../visual";

function row(id: string, patch: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    domain: "example.com",
    description: "",
    category: "Unsorted",
    tags: [],
    folderId: null,
    boardIds: [],
    addedAt: 1_700_000_000_000,
    visitCount: 0,
    health: { status: "unchecked" },
    preview: { method: "card" },
    ...patch,
  };
}

describe("hamming distance", () => {
  it("is zero for identical hashes", () => {
    expect(hammingDistance("ffffffffffffffff", "ffffffffffffffff")).toBe(0);
  });

  it("counts differing bits, not differing characters", () => {
    // 0x0 vs 0x1 differs in one bit, though the characters are wholly different.
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
    // 0x0 vs 0xf is four bits.
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
  });

  it("treats a length mismatch as maximally distant rather than throwing", () => {
    expect(hammingDistance("ffff", "ffffffffffffffff")).toBe(64);
  });
});

describe("structure score", () => {
  it("is 1 for the same hash and 0 for its inverse", () => {
    expect(structureScore("ffffffffffffffff", "ffffffffffffffff")).toBe(1);
    expect(structureScore("0000000000000000", "ffffffffffffffff")).toBe(0);
  });

  it("is zero when either side has never been indexed", () => {
    expect(structureScore(undefined, "ffffffffffffffff")).toBe(0);
    expect(structureScore("ffffffffffffffff", undefined)).toBe(0);
  });
});

describe("palette score", () => {
  it("is the shared area of two histograms", () => {
    // Half of each distribution sits in a bin the other also occupies.
    const a = [0.5, 0.5, 0, 0];
    const b = [0.5, 0, 0.5, 0];
    expect(paletteScore(a, b)).toBeCloseTo(0.5, 5);
  });

  it("is 1 for identical palettes and 0 for disjoint ones", () => {
    expect(paletteScore([1, 0, 0], [1, 0, 0])).toBe(1);
    expect(paletteScore([1, 0, 0], [0, 1, 0])).toBe(0);
  });

  it("refuses to compare histograms of different lengths", () => {
    expect(paletteScore([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("finding look-alikes", () => {
  const subject = row("subject", { visual: { phash: "ffffffff00000000", at: 1 } });

  it("returns nothing when the subject has never been indexed", () => {
    expect(findLookalikes(row("bare"), [subject])).toEqual([]);
  });

  it("ranks a closer picture above a more distant one", () => {
    const near = row("near", { visual: { phash: "ffffffff00000001", at: 1 } });
    const far = row("far", { visual: { phash: "ffffffff0000ffff", at: 1 } });
    const matches = findLookalikes(subject, [near, far], { strength: "broad" });
    expect(matches[0]?.id).toBe("near");
  });

  it("never returns the subject itself", () => {
    const matches = findLookalikes(subject, [subject], { strength: "broad" });
    expect(matches).toEqual([]);
  });

  it("excludes trashed rows, which are not in the library any more", () => {
    const trashed = row("trashed", {
      visual: { phash: "ffffffff00000000", at: 1 },
      trashedAt: 2,
    });
    expect(findLookalikes(subject, [trashed], { strength: "broad" })).toEqual([]);
  });

  it("honours the strength floor", () => {
    // Twelve bits apart is 1 - 12/64 = 0.8125: above "broad" (0.62) and "balanced"
    // (0.74), below "strict" (0.86).
    const candidate = row("c", { visual: { phash: "ffffffff00000fff", at: 1 } });
    expect(findLookalikes(subject, [candidate], { strength: "broad" })).toHaveLength(1);
    expect(findLookalikes(subject, [candidate], { strength: "balanced" })).toHaveLength(1);
    expect(findLookalikes(subject, [candidate], { strength: "strict" })).toHaveLength(0);
  });

  it("scores on structure alone when neither side carries a palette", () => {
    const candidate = row("c", { visual: { phash: "ffffffff00000000", at: 1 } });
    const [match] = findLookalikes(subject, [candidate], { strength: "strict" });
    expect(match.score).toBe(1);
  });

  it("lets colour lead when the refinement is on", () => {
    const withPalette = row("subject2", {
      visual: { phash: "ffffffff00000000", hues: [1, 0, 0, 0], at: 1 },
    });
    // Same colours, quite different shape.
    const sameColour = row("same-colour", {
      visual: { phash: "ff00ff00ff00ff00", hues: [1, 0, 0, 0], at: 1 },
    });
    const plain = findLookalikes(withPalette, [sameColour], { strength: "broad" });
    const refined = findLookalikes(withPalette, [sameColour], {
      strength: "broad",
      refineColor: true,
    });
    expect(refined[0].score).toBeGreaterThan(plain[0].score);
  });
});

describe("grouping look-alikes", () => {
  it("gathers the same picture saved three times into one group", () => {
    const hash = "aaaaaaaaaaaaaaaa";
    const items = [
      row("a", { visual: { phash: hash, at: 1 }, addedAt: 100 }),
      row("b", { visual: { phash: hash, at: 1 }, addedAt: 200 }),
      row("c", { visual: { phash: hash, at: 1 }, addedAt: 300 }),
    ];
    const groups = groupLookalikes(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].rest).toHaveLength(2);
  });

  it("keeps the earliest copy when nothing else distinguishes them", () => {
    const hash = "aaaaaaaaaaaaaaaa";
    const groups = groupLookalikes([
      row("late", { visual: { phash: hash, at: 1 }, addedAt: 900 }),
      row("early", { visual: { phash: hash, at: 1 }, addedAt: 100 }),
    ]);
    expect(groups[0].keep.id).toBe("early");
  });

  it("keeps the copy somebody has already worked on, whenever it was saved", () => {
    const hash = "aaaaaaaaaaaaaaaa";
    const groups = groupLookalikes([
      row("plain", { visual: { phash: hash, at: 1 }, addedAt: 100 }),
      row("noted", { visual: { phash: hash, at: 1 }, addedAt: 900, note: "keep this one" }),
    ]);
    expect(groups[0].keep.id).toBe("noted");
  });

  it("leaves genuinely different pictures alone", () => {
    expect(
      groupLookalikes([
        row("a", { visual: { phash: "0000000000000000", at: 1 } }),
        row("b", { visual: { phash: "ffffffffffffffff", at: 1 } }),
      ]),
    ).toEqual([]);
  });

  it("ignores rows with no index, rather than treating them as identical", () => {
    expect(groupLookalikes([row("a"), row("b")])).toEqual([]);
  });

  it("reports the weakest pair in the group as its confidence", () => {
    const groups = groupLookalikes(
      [
        row("a", { visual: { phash: "0000000000000000", at: 1 } }),
        row("b", { visual: { phash: "0000000000000001", at: 1 } }),
        row("c", { visual: { phash: "0000000000000003", at: 1 } }),
      ],
      0.9,
    );
    expect(groups[0].confidence).toBeLessThan(1);
    expect(groups[0].confidence).toBeGreaterThan(0.9);
  });
});

describe("colour", () => {
  it("maps a hex to the hue bin a query would use", () => {
    // A saturated blue lands in the blue bin, a saturated red in the red one.
    expect(binForHex("#3e63dd")).toBe(8);
    expect(binForHex("#e5484d")).toBe(0);
  });

  /**
   * The bug this exists to prevent: red straddling a bin edge.
   *
   * Reds scatter either side of 0°, and with bins starting at zero the two halves land
   * eleven bins apart — so a search for red silently returns about half of it.
   */
  it("keeps reds on both sides of 0 degrees in the same bin", () => {
    expect(binForHex("#ff0011")).toBe(0); // a few degrees clockwise
    expect(binForHex("#ff1100")).toBe(0); // a few degrees anticlockwise
  });

  it("gives every swatch its own bin, so none is unreachable from the picker", () => {
    const bins = COLOR_WHEEL.map((swatch) => swatch.bin);
    expect(new Set(bins).size).toBe(COLOR_WHEEL.length);
    // And each swatch really does resolve to the bin it claims.
    for (const swatch of COLOR_WHEEL) {
      expect(binForHex(swatch.hex)).toBe(swatch.bin);
    }
  });

  it("refuses a grey, which carries no hue", () => {
    expect(binForHex("#808080")).toBeNull();
    expect(binForHex("#ffffff")).toBeNull();
  });

  it("rejects a malformed value rather than guessing", () => {
    expect(binForHex("nonsense")).toBeNull();
  });

  it("counts a neighbouring bin at a third, because hue is a ring", () => {
    const exact = row("a", { visual: { hues: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], at: 1 } });
    const beside = row("b", { visual: { hues: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], at: 1 } });
    expect(colorScore(exact, 7)).toBe(1);
    expect(colorScore(beside, 7)).toBeCloseTo(1 / 3, 5);
  });

  it("wraps around the ring, so red and pink are neighbours", () => {
    const pink = row("p", { visual: { hues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], at: 1 } });
    // Bin 0 is red; bin 11 is its neighbour going backwards round the ring.
    expect(colorScore(pink, 0)).toBeCloseTo(1 / 3, 5);
  });

  it("is zero for an unindexed row", () => {
    expect(colorScore(row("bare"), 3)).toBe(0);
  });
});

describe("likeness percentage", () => {
  it("caps below 100 unless the match is exact", () => {
    expect(likeness(SAME_PICTURE)).toBeLessThan(100);
    expect(likeness(1)).toBe(100);
  });

  it("never reports zero, since a shown match is by definition above the floor", () => {
    expect(likeness(0)).toBe(1);
  });
});
