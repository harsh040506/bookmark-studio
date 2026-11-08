/**
 * The masonry layout.
 *
 * Two invariants carry the whole feature, and both fail silently when broken. If the
 * band index and the boxes disagree, cards vanish from a scroll position that looks
 * perfectly ordinary. If the column balance drifts, one column runs long and the grid
 * ends in a ragged staircase. Neither throws; both just look wrong to somebody who
 * cannot report why.
 */
import { describe, expect, it } from "vitest";
import { BAND_SIZE, computeMasonry, itemsInBand } from "../masonry";

/** Items are plain heights here — the layout never looks inside one. */
const heights = (values: number[]) => values.map((height) => ({ height }));
const heightFor = (item: { height: number }) => item.height;

describe("computeMasonry", () => {
  it("places the first row across the columns before starting a second", () => {
    const layout = computeMasonry(heights([100, 100, 100]), 3, 200, 10, heightFor);
    expect(layout.boxes.map((box) => box.y)).toEqual([0, 0, 0]);
    expect(layout.boxes.map((box) => box.x)).toEqual([0, 210, 420]);
  });

  it("sends the next card to the shortest column rather than the next one along", () => {
    // Column 0 gets a tall card; the short ones must keep landing beside it.
    const layout = computeMasonry(heights([400, 100, 100, 100]), 2, 200, 10, heightFor);
    expect(layout.boxes[0]).toMatchObject({ x: 0, y: 0 });
    expect(layout.boxes[1]).toMatchObject({ x: 210, y: 0 });
    // 110 and 220 are still shorter than the 400 in column 0.
    expect(layout.boxes[2]).toMatchObject({ x: 210, y: 110 });
    expect(layout.boxes[3]).toMatchObject({ x: 210, y: 220 });
  });

  it("breaks a tie to the leftmost column, so a fresh grid fills in reading order", () => {
    const layout = computeMasonry(heights([50, 50, 50, 50]), 2, 100, 0, heightFor);
    expect(layout.boxes.map((box) => box.x)).toEqual([0, 100, 0, 100]);
  });

  it("reports the tallest column as the height, minus the trailing gap", () => {
    const layout = computeMasonry(heights([100, 300]), 2, 100, 20, heightFor);
    // Column 1 holds 300 + 20 of gap; the gap is scaffolding, not document.
    expect(layout.height).toBe(300);
  });

  it("refuses to collapse a column on a zero or negative height", () => {
    const layout = computeMasonry(heights([0, -50]), 1, 100, 0, heightFor);
    for (const box of layout.boxes) expect(box.height).toBeGreaterThanOrEqual(80);
  });

  it("survives an empty list without producing a negative height", () => {
    const layout = computeMasonry([], 3, 200, 10, heightFor);
    expect(layout.boxes).toHaveLength(0);
    expect(layout.height).toBe(0);
  });

  it("treats a column count below one as a single column", () => {
    const layout = computeMasonry(heights([100, 100]), 0, 200, 10, heightFor);
    expect(layout.boxes.map((box) => box.x)).toEqual([0, 0]);
    expect(layout.boxes[1].y).toBe(110);
  });
});

describe("itemsInBand", () => {
  it("finds exactly the cards intersecting a window", () => {
    const layout = computeMasonry(heights([100, 100, 100, 100]), 1, 200, 0, heightFor);
    // Boxes at y = 0, 100, 200, 300.
    expect(itemsInBand(layout, 90, 210)).toEqual([0, 1, 2]);
  });

  it("includes a card that merely touches the edge of the window", () => {
    const layout = computeMasonry(heights([100, 100]), 1, 200, 0, heightFor);
    expect(itemsInBand(layout, 100, 100)).toEqual([0, 1]);
  });

  it("returns nothing for a window past the end of the document", () => {
    const layout = computeMasonry(heights([100]), 1, 200, 0, heightFor);
    expect(itemsInBand(layout, 5_000, 6_000)).toEqual([]);
  });

  it("clamps a window that starts above the document", () => {
    const layout = computeMasonry(heights([100, 100]), 1, 200, 0, heightFor);
    expect(itemsInBand(layout, -900, 50)).toEqual([0]);
  });

  /**
   * The invariant that matters most: the band index must agree with the boxes.
   *
   * A card filed under the wrong band is a card that disappears at one scroll position
   * and reappears at another, which is indistinguishable from a data-loss bug to anyone
   * looking at it.
   */
  it("agrees with a brute-force intersection at every scroll position", () => {
    const values = Array.from({ length: 400 }, (_, index) => 90 + ((index * 37) % 320));
    const layout = computeMasonry(heights(values), 4, 240, 16, heightFor);

    for (let top = 0; top < layout.height; top += 137) {
      const bottom = top + 900;
      const viaBands = itemsInBand(layout, top, bottom);
      const viaScan = layout.boxes
        .map((box, index) => ({ box, index }))
        .filter(({ box }) => box.y <= bottom && box.y + box.height >= top)
        .map(({ index }) => index);
      expect(viaBands).toEqual(viaScan);
    }
  });

  it("files a card spanning several bands under each of them, without duplicating it", () => {
    const layout = computeMasonry(heights([BAND_SIZE * 3]), 1, 200, 0, heightFor);
    expect(itemsInBand(layout, 0, BAND_SIZE * 3)).toEqual([0]);
    // Present in a band it merely passes through, not only where it starts.
    expect(itemsInBand(layout, BAND_SIZE * 1.5, BAND_SIZE * 1.6)).toEqual([0]);
  });
});
