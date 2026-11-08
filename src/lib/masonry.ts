/**
 * Masonry layout: cards of different heights, in balanced columns.
 *
 * ## Why the grid could not stay uniform
 *
 * A uniform grid crops every picture to one shape. That is the right answer for a table
 * and the wrong one for a wall of images: a tall phone screenshot, a wide dashboard and a
 * square logo are recognisable *because* of their proportions, and a layout that flattens
 * all three to 3:2 throws away the fastest signal the eye has for telling them apart.
 *
 * ## Heights are computed, never measured
 *
 * The obvious implementation mounts a card, reads its height back, and moves everything
 * below it. That is a reflow per image and a column that visibly resettles while you are
 * reading it — precisely the "list assembling itself" the scroller exists to prevent.
 *
 * So the caller supplies a height instead, derived from an aspect ratio it already knows:
 * an upload carries its pixel dimensions, a screenshot was rendered at a viewport this
 * app chose, and an `og:image` is 1.91:1 by convention. The layout is computed once, in
 * full, and no card ever moves again while it is on screen.
 *
 * ## Finding what is visible without walking everything
 *
 * A uniform grid can divide an offset by a row height and know instantly which rows are
 * in view. A masonry cannot: positions are irregular, so the question "which cards
 * intersect this window" has no closed form.
 *
 * Scanning all of them per frame is the obvious fallback and is wrong twice over — it is
 * O(n) sixty times a second, and it allocates a fresh array each time, so a long scroll
 * through a large library turns into a stream of garbage for the collector to clear at
 * exactly the moment the frame budget is tightest.
 *
 * Instead the document is cut into fixed horizontal bands and each card is filed under
 * every band it touches. A lookup then reads only the two or three bands the viewport
 * covers. Bands cost one pass to build and are rebuilt only when the layout is.
 */

/** One card's absolute box within the scrolling document. */
export interface MasonryBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MasonryLayout {
  boxes: MasonryBox[];
  /** Total scroll height of the content, excluding the trailing gap. */
  height: number;
  /** Card indices filed by band, for range queries. */
  bands: number[][];
  bandSize: number;
}

/**
 * Height of one bucket in the band index.
 *
 * Bands are cheap — an integer per card per band it spans — and a miss is not, so this
 * errs generous. At 600px a card typically occupies one or two bands and a viewport
 * covers two or three, which keeps a lookup reading tens of indices rather than
 * thousands.
 */
export const BAND_SIZE = 600;

/** Smallest card the layout will place, so a bad height cannot collapse a column. */
const MIN_CARD_HEIGHT = 80;

/**
 * Places every item into the column that is currently shortest.
 *
 * This is the classical greedy masonry, and the reason it is right here is that it keeps
 * the bottom edge of the grid roughly level: no column runs away, so the reader never
 * reaches a point where one column has ended and two are still going. Ties break to the
 * leftmost column, so a fresh grid fills in reading order instead of arbitrarily.
 */
export function computeMasonry<T>(
  items: T[],
  columns: number,
  columnWidth: number,
  gap: number,
  heightFor: (item: T, width: number) => number,
): MasonryLayout {
  const safeColumns = Math.max(1, Math.floor(columns));
  const columnHeights = new Array<number>(safeColumns).fill(0);
  const boxes: MasonryBox[] = new Array(items.length);

  for (let index = 0; index < items.length; index += 1) {
    let target = 0;
    for (let column = 1; column < safeColumns; column += 1) {
      // The epsilon keeps floating-point noise from making equal columns alternate.
      if (columnHeights[column] < columnHeights[target] - 0.5) target = column;
    }
    const height = Math.max(MIN_CARD_HEIGHT, Math.round(heightFor(items[index], columnWidth)));
    boxes[index] = {
      x: target * (columnWidth + gap),
      y: columnHeights[target],
      width: columnWidth,
      height,
    };
    columnHeights[target] += height + gap;
  }

  const tallest = columnHeights.length ? Math.max(...columnHeights) : 0;
  const bandCount = Math.max(1, Math.ceil(tallest / BAND_SIZE));
  const bands: number[][] = Array.from({ length: bandCount }, () => []);
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    const first = Math.max(0, Math.floor(box.y / BAND_SIZE));
    const last = Math.min(bandCount - 1, Math.floor((box.y + box.height) / BAND_SIZE));
    for (let band = first; band <= last; band += 1) bands[band].push(index);
  }

  // The trailing gap is layout scaffolding, not content: leaving it in the total adds a
  // strip of dead space under the last row that the scrollbar claims is document.
  return { boxes, height: Math.max(0, tallest - gap), bands, bandSize: BAND_SIZE };
}

/**
 * Card indices whose boxes intersect the vertical window `[from, to]`.
 *
 * Returned ascending so the DOM order matches reading order — which is what keeps tab
 * order sane and stops a screen reader announcing the grid out of sequence.
 */
export function itemsInBand(layout: MasonryLayout, from: number, to: number): number[] {
  if (!layout.bands.length) return [];
  const first = Math.max(0, Math.floor(from / layout.bandSize));
  const last = Math.min(layout.bands.length - 1, Math.floor(to / layout.bandSize));
  if (last < first) return [];

  // A card spanning two bands is filed under both, so it can be reached twice.
  const seen = new Set<number>();
  for (let band = first; band <= last; band += 1) {
    for (const index of layout.bands[band]) {
      const box = layout.boxes[index];
      if (box.y <= to && box.y + box.height >= from) seen.add(index);
    }
  }
  return [...seen].sort((a, b) => a - b);
}
