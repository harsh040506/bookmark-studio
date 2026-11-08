/**
 * Two properties nobody can see, which is exactly why they need tests.
 *
 * ## Reading order in a masonry
 *
 * The grid mounts absolutely-positioned cards. That means the DOM order and the visual
 * order are decoupled by construction, and a screen reader, a Tab press and a text search
 * all follow the DOM. If `itemsInBand` ever returned indices in the order it happened to
 * find them — which is the order the *band index* holds them, not the order the reader
 * sees — the grid would announce itself scrambled, and no amount of looking at it would
 * reveal that.
 *
 * The design reference flagged this as "the layout sorts ascending, but this is untested
 * with a screen reader". It still has not been tested with a screen reader; what it now has
 * is the invariant a screen reader depends on, asserted directly.
 *
 * ## Exactness of the banded look-alike search
 *
 * The cleanup does not merely *list* look-alikes — it elects a survivor and deletes the
 * rest. So an optimisation that made the comparison approximate would turn a performance
 * improvement into silent data loss. The banding is exact only while the threshold admits
 * at most three differing bits, and the code falls back to the full comparison otherwise;
 * these tests hold that boundary in place.
 */
import { describe, expect, it } from "vitest";
import type { Bookmark } from "../../../shared/types";
import { computeMasonry, itemsInBand } from "../masonry";
import { groupLookalikes, SAME_PICTURE } from "../visual";

describe("what a screen reader is handed", () => {
  /** Heights chosen to be irregular, so cards genuinely interleave across columns. */
  const heights = [120, 300, 80, 220, 160, 400, 90, 140, 260, 110, 330, 70];

  it("returns visible cards in ascending index order at every column count", () => {
    for (const columns of [1, 2, 3, 4, 5, 6]) {
      const layout = computeMasonry(heights, columns, 260, 16, (height) => height);

      // Walk the whole document in overlapping windows, which is what scrolling does.
      for (let top = 0; top < layout.height; top += 137) {
        const visible = itemsInBand(layout, top, top + 600);
        const sorted = [...visible].sort((a, b) => a - b);
        expect(visible).toEqual(sorted);
      }
    }
  });

  it("returns every card exactly once, however many bands it spans", () => {
    // A card taller than a band is filed under several, and the naive implementation
    // returns it once per band — which a reader announces as a duplicate.
    const tall = [700, 900, 50, 1400, 60];
    const layout = computeMasonry(tall, 2, 260, 16, (height) => height);
    const visible = itemsInBand(layout, 0, layout.height);
    expect(new Set(visible).size).toBe(visible.length);
    expect(visible.length).toBe(tall.length);
  });

  it("finds nothing above the content and nothing below it", () => {
    const layout = computeMasonry(heights, 3, 260, 16, (height) => height);
    expect(itemsInBand(layout, layout.height + 500, layout.height + 900)).toEqual([]);
    // The first band always contains the first card, whatever the column count.
    expect(itemsInBand(layout, 0, 10)).toContain(0);
  });
});

describe("the banded look-alike search is exact", () => {
  function pictured(id: string, phash: string): Bookmark {
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
      addedAt: 0,
      visitCount: 0,
      health: { status: "unchecked" },
      preview: { method: "card" },
      visual: { phash, at: 1 },
    };
  }

  /** Flips `count` bits spread across the hash, one per hex character. */
  function perturb(phash: string, count: number): string {
    const chars = phash.split("");
    for (let index = 0; index < count; index += 1) {
      const position = index * 5 % chars.length;
      chars[position] = (Number.parseInt(chars[position], 16) ^ 1).toString(16);
    }
    return chars.join("");
  }

  const base = "0f1e2d3c4b5a6978";

  it("groups near-identical pictures the exhaustive scan would group", () => {
    // Three differing bits is the boundary the pigeonhole argument covers.
    const rows = [pictured("a", base), pictured("b", perturb(base, 3))];
    const groups = groupLookalikes(rows, SAME_PICTURE);
    expect(groups).toHaveLength(1);
    expect(groups[0].rest).toHaveLength(1);
  });

  it("does not group pictures that merely resemble each other", () => {
    // Far apart: half the nibbles differ.
    const distant = "f0e1d2c3b4a58769";
    const groups = groupLookalikes([pictured("a", base), pictured("b", distant)], SAME_PICTURE);
    expect(groups).toHaveLength(0);
  });

  it("collapses a chain of near-copies into one group", () => {
    // a→b and b→c are each within tolerance; a→c may not be. Single-link expansion must
    // still produce one group rather than two overlapping pairs.
    const rows = [
      pictured("a", base),
      pictured("b", perturb(base, 2)),
      pictured("c", perturb(perturb(base, 2), 2)),
    ];
    const groups = groupLookalikes(rows, SAME_PICTURE);
    expect(groups).toHaveLength(1);
    expect(groups[0].rest.length + 1).toBe(3);
  });

  it("ignores trashed rows", () => {
    // A picture in the trash is one the user believes is gone. Offering it as a duplicate
    // to merge would resurrect it into a cleanup they did not ask for.
    const trashed = { ...pictured("b", base), trashedAt: Date.now() };
    expect(groupLookalikes([pictured("a", base), trashed], SAME_PICTURE)).toHaveLength(0);
  });

  it("agrees with the unbanded path at a loose threshold", () => {
    // Below the banding guarantee the code takes the exhaustive route; the answer must not
    // change as the threshold crosses that boundary.
    const rows = [pictured("a", base), pictured("b", perturb(base, 6))];
    const loose = groupLookalikes(rows, 0.85);
    expect(loose).toHaveLength(1);
  });
});
