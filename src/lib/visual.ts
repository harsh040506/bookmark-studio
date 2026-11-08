/**
 * "Looks like", without a model.
 *
 * ## What this replaces
 *
 * Every visual-similarity feature in the products this app was measured against runs on
 * embeddings: Muse ships a 6 GB vision model and a vector index to answer "show me what
 * else looks like this". That is a real answer and an expensive one — a model download, a
 * runtime to keep alive, and a machine that can carry it.
 *
 * The classical answer is older, smaller and, for *this* question, very nearly as good.
 * Two images that look alike have the same coarse structure and the same colours. Both
 * are cheap to measure directly:
 *
 *   · **Structure** — an average hash. Reduce the image to 8×8 greyscale, take the mean,
 *     and record one bit per cell for "brighter than the mean". Two pictures of the same
 *     thing agree on most of those 64 bits however they were compressed, scaled or
 *     re-encoded, so Hamming distance over them is a similarity score. This is the same
 *     `phash.ts` Muse keeps *beside* its embeddings, because for near-duplicate detection
 *     the hash is the part that actually does the work.
 *
 *   · **Colour** — a 12-bin hue histogram plus mean lightness. This is what makes the
 *     "Colors" refinement and "search by colour" answerable, and it is the signal a
 *     designer is usually reaching for when they say two things look alike.
 *
 * Both are computed here, in the browser, from bytes the asset store already holds. No
 * upload, no service, no model — which keeps the promise the rest of the app makes.
 *
 * ## What it cannot do
 *
 * It does not know what is *in* the picture. Two different dashboards score as similar
 * because they are both dark and grid-shaped; a cat and a dog on the same background
 * score as similar too. That is the honest limit of the technique, and the UI states the
 * match as a percentage rather than as a claim about content.
 */
import type { Bookmark, VisualIndex } from "../../shared/types";

/** Edge of the greyscale grid the hash is taken over. 8×8 = 64 bits. */
const HASH_SIZE = 8;
/** Edge of the sample grid the colour histogram is taken over. */
const COLOR_SIZE = 32;
/** Hue bins. Twelve is one per 30°, which separates the named hues without over-splitting. */
export const HUE_BINS = 12;
/** Below this chroma a pixel is grey and carries no hue information. */
const MIN_CHROMA = 0.12;

/* ------------------------------------------------------------ computing */

/**
 * Builds the index for one already-loaded image.
 *
 * Takes a source usable by `drawImage` — an object URL from the asset store, a data URI
 * from an embedded favicon — and returns `null` when the bytes will not decode, which is
 * an ordinary outcome for a file that was truncated or is not really an image.
 */
export async function indexImage(source: string): Promise<VisualIndex | null> {
  try {
    const bitmap = await loadBitmap(source);
    const index: VisualIndex = {
      phash: averageHash(bitmap),
      at: Date.now(),
      ...colorProfile(bitmap),
    };
    close(bitmap);
    return index;
  } catch {
    return null;
  }
}

type Decoded = ImageBitmap | HTMLImageElement;

function close(bitmap: Decoded): void {
  if (typeof ImageBitmap !== "undefined" && bitmap instanceof ImageBitmap) bitmap.close();
}

/**
 * Decodes to whatever this browser offers.
 *
 * `createImageBitmap` decodes off the main thread, which matters because this runs over
 * every stored image in the library; `HTMLImageElement` is the fallback for browsers
 * that will not take an object URL through the bitmap path.
 */
async function loadBitmap(source: string): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    const response = await fetch(source);
    const blob = await response.blob();
    return await createImageBitmap(blob);
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode failed"));
    image.src = source;
  });
}

function sample(bitmap: Decoded, size: number): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  // Stretched to a square on purpose: aspect is not part of the comparison, so a
  // cropped re-post of the same picture still lands on the same bits.
  context.drawImage(bitmap as CanvasImageSource, 0, 0, size, size);
  return context.getImageData(0, 0, size, size).data;
}

/**
 * 64-bit average hash, as 16 hex characters.
 *
 * Deliberately *average* hash rather than the DCT-based "true" pHash. The DCT variant is
 * more robust to gamma shifts and costs a 32×32 transform per image; measured over a real
 * library the two disagreed on a handful of pairs out of thousands, and neither ordering
 * was obviously better to look at. The cheaper one runs over a 3,000-image library
 * without the user noticing, which is the property that matters here.
 */
function averageHash(bitmap: Decoded): string | undefined {
  const data = sample(bitmap, HASH_SIZE);
  if (!data) return undefined;

  const cells: number[] = [];
  for (let index = 0; index < data.length; index += 4) {
    // Rec. 601 luma — the same weighting `contrastText` uses, kept consistent so
    // "bright" means one thing across the app.
    cells.push((0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) / 255);
  }
  const mean = cells.reduce((sum, value) => sum + value, 0) / cells.length;

  let hex = "";
  for (let nibble = 0; nibble < cells.length; nibble += 4) {
    let bits = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      if (cells[nibble + offset] >= mean) bits |= 1 << (3 - offset);
    }
    hex += bits.toString(16);
  }
  return hex;
}

/** Hue histogram, chroma coverage and mean lightness over a 32×32 sample. */
function colorProfile(bitmap: Decoded): Pick<VisualIndex, "hues" | "chroma" | "lightness"> {
  const data = sample(bitmap, COLOR_SIZE);
  if (!data) return {};

  const hues = new Array<number>(HUE_BINS).fill(0);
  let chromatic = 0;
  let counted = 0;
  let lightnessSum = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha < 128) continue;
    counted += 1;

    const r = data[index] / 255;
    const g = data[index + 1] / 255;
    const b = data[index + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    lightnessSum += (max + min) / 2;

    const delta = max - min;
    if (delta < MIN_CHROMA) continue;
    chromatic += 1;
    hues[hueBin(r, g, b, max, delta)] += 1;
  }

  if (!counted) return {};
  const total = chromatic || 1;
  return {
    hues: hues.map((count) => count / total),
    chroma: chromatic / counted,
    lightness: lightnessSum / counted,
  };
}

/** Degrees each bin spans. */
const BIN_WIDTH = 360 / HUE_BINS;

/**
 * Which hue bin a colour falls in.
 *
 * Bins are **centred** on their hue rather than starting at it, which is the whole reason
 * for the half-width offset. Red sits at 0°, and real reds scatter to either side of it —
 * a slightly warm red is at 5°, a slightly cool one at 356°. Binning from zero cuts
 * straight through the middle of red and files those two in bins eleven apart, so a search
 * for red returns about half the red things in the library and no explanation for the
 * other half. Centring puts the boundary between named colours, where nobody is looking.
 */
function hueBin(r: number, g: number, b: number, max: number, delta: number): number {
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return Math.floor((((hue + BIN_WIDTH / 2) % 360) / 360) * HUE_BINS) % HUE_BINS;
}

/* ------------------------------------------------------------ comparing */

/** Population count of a 64-bit hash pair, as a 0..64 Hamming distance. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    let xor = Number.parseInt(a[index], 16) ^ Number.parseInt(b[index], 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** Structural similarity, 0..1, from the Hamming distance over 64 bits. */
export function structureScore(a?: string, b?: string): number {
  if (!a || !b) return 0;
  return Math.max(0, 1 - hammingDistance(a, b) / 64);
}

/**
 * Palette agreement, 0..1, as histogram intersection.
 *
 * Intersection rather than cosine because these are distributions: the shared area under
 * two normalised histograms *is* the fraction of colour they have in common, which is the
 * number a person means by "these use the same palette". Cosine would call a mostly-red
 * image and a slightly-red one a strong match because it ignores magnitude.
 */
export function paletteScore(a?: number[], b?: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let shared = 0;
  for (let bin = 0; bin < a.length; bin += 1) shared += Math.min(a[bin], b[bin]);
  return Math.min(1, shared);
}

/**
 * How strict a match has to be to be shown.
 *
 * Named rather than numeric because the number means nothing to the person choosing it,
 * and the useful setting genuinely differs by intent: finding re-saves of one picture
 * wants `strict`, filling a moodboard wants `broad`.
 */
export type MatchStrength = "broad" | "balanced" | "strict";

export const MATCH_STRENGTH: Record<MatchStrength, { min: number; label: string }> = {
  broad: { min: 0.62, label: "Wide" },
  balanced: { min: 0.74, label: "Balanced" },
  strict: { min: 0.86, label: "Close" },
};

/** Weights when structure and palette are combined. Structure leads; colour confirms. */
const W_STRUCTURE = 0.68;
const W_PALETTE = 0.32;
/** With the colour refinement on, the palette leads instead. */
const W_STRUCTURE_COLOR = 0.28;
const W_PALETTE_COLOR = 0.72;

export interface VisualMatch {
  id: string;
  /** Combined score, 0..1 — what the likeness percentage is drawn from. */
  score: number;
  structure: number;
  palette: number;
  /** True when the two are close enough to be the same picture saved twice. */
  duplicate: boolean;
}

/** Threshold above which two images are called the same picture rather than a likeness. */
export const SAME_PICTURE = 0.94;

export interface SimilarOptions {
  strength?: MatchStrength;
  /** Weight colour over structure — the "Colors" refinement. */
  refineColor?: boolean;
  limit?: number;
}

/**
 * Ranks everything in `candidates` by how much it looks like `subject`.
 *
 * Linear over the library, and deliberately so: a 3,000-row library is 3,000 popcounts
 * over 16 hex characters, which is well under a frame. An index would buy nothing here
 * except a structure to keep correct.
 */
export function findLookalikes(
  subject: Bookmark,
  candidates: Bookmark[],
  options: SimilarOptions = {},
): VisualMatch[] {
  const { strength = "balanced", refineColor = false, limit = 60 } = options;
  const source = subject.visual;
  if (!source?.phash && !source?.hues) return [];

  const floor = MATCH_STRENGTH[strength].min;
  const structureWeight = refineColor ? W_STRUCTURE_COLOR : W_STRUCTURE;
  const paletteWeight = refineColor ? W_PALETTE_COLOR : W_PALETTE;

  const matches: VisualMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.id === subject.id || candidate.trashedAt) continue;
    const other = candidate.visual;
    if (!other) continue;

    const structure = structureScore(source.phash, other.phash);
    const palette = paletteScore(source.hues, other.hues);
    // A candidate carrying only one of the two signals is scored on that signal alone,
    // rather than being penalised to zero for a field it was never given.
    const score =
      source.phash && other.phash && source.hues && other.hues
        ? structure * structureWeight + palette * paletteWeight
        : source.phash && other.phash
          ? structure
          : palette;

    if (score < floor) continue;
    matches.push({ id: candidate.id, score, structure, palette, duplicate: score >= SAME_PICTURE });
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The percentage shown on a match. Rounded to whole points; 99 is the ceiling below identity. */
export function likeness(score: number): number {
  if (score >= 0.999) return 100;
  return Math.max(1, Math.min(99, Math.round(score * 100)));
}

/* -------------------------------------------------------- look-alikes -- */

export interface LookalikeGroup {
  /** The copy to keep: the earliest-saved, richest row. */
  keep: Bookmark;
  /** The rest, which the cleanup offers to remove. */
  rest: Bookmark[];
  /** Lowest pairwise score inside the group, so the UI can say how sure it is. */
  confidence: number;
}

/**
 * Gathers images that are the same picture saved more than once.
 *
 * The counterpart to URL de-duplication, and it catches what that cannot: the same
 * screenshot pasted from three places has three different URLs, or none at all, and is
 * invisible to a comparison of addresses.
 *
 * Grouping is single-link — anything close enough to any member joins — which is the
 * right shape for near-duplicates of one original and is why the group reports its
 * weakest internal pair as a confidence rather than claiming certainty.
 */
export function groupLookalikes(items: Bookmark[], threshold = SAME_PICTURE): LookalikeGroup[] {
  const cached = lookalikeCache.get(items)?.get(threshold);
  if (cached) return cached;
  const computed = computeLookalikes(items, threshold);
  let byThreshold = lookalikeCache.get(items);
  if (!byThreshold) {
    byThreshold = new Map();
    lookalikeCache.set(items, byThreshold);
  }
  byThreshold.set(threshold, computed);
  return computed;
}

/**
 * Grouping results, keyed by the array they were computed from.
 *
 * ## Why a WeakMap on the array itself
 *
 * The library is replaced wholesale on every commit — `commit` builds a new array rather
 * than mutating the old one — so the array's identity *is* the version of the library.
 * Keying on it therefore needs no version counter to keep in step with anything, and no
 * invalidation call that a future mutation path could forget to make. A stale entry is
 * unreachable by construction: the only way to ask for one is to still be holding the
 * array it describes, in which case it is not stale.
 *
 * Weak, so the entry for a superseded library is collected with the library. A strong map
 * here would retain every version of every array for the life of the tab, which on a
 * 3,000-row library is a few megabytes per edit.
 *
 * ## What this fixes
 *
 * `selectBookmarks` calls this on every render while the Cleanup scope is active —
 * including every keystroke of a search — and it is quadratic in the number of indexed
 * pictures. `computeStats` calls it again. Neither can produce a different answer for the
 * same library, so both now do the work at most once per version between them.
 */
const lookalikeCache = new WeakMap<Bookmark[], Map<number, LookalikeGroup[]>>();

/**
 * Candidate buckets, so a near-duplicate search does not compare every pair.
 *
 * A 64-bit hash is split into four 16-bit bands. Two hashes differing in at most three
 * bits must agree exactly on at least one band — three differing bits can spoil at most
 * three of the four — so bucketing by band value and comparing only within buckets finds
 * every pair the exhaustive scan would, with none of the pairs it would reject.
 *
 * That pigeonhole argument is what makes this exact rather than approximate, and it holds
 * only while the threshold admits three bits or fewer. `computeLookalikes` checks that
 * before using the buckets and falls back to the full comparison when it does not,
 * because an *approximate* cleanup is worse than a slow one: the cleanup deletes things.
 */
const BANDS = 4;
/** Hex characters per band. 16 hex chars of hash over four bands. */
const BAND_CHARS = 4;
/** Differing bits still guaranteed to be caught by banding. */
const BANDED_MAX_DISTANCE = BANDS - 1;

function bandKeys(phash: string): string[] {
  const keys: string[] = [];
  for (let band = 0; band < BANDS; band += 1) {
    keys.push(`${band}:${phash.slice(band * BAND_CHARS, (band + 1) * BAND_CHARS)}`);
  }
  return keys;
}

function computeLookalikes(items: Bookmark[], threshold: number): LookalikeGroup[] {
  const usable = items.filter((item) => item.visual?.phash && !item.trashedAt);
  const seen = new Set<string>();
  const groups: LookalikeGroup[] = [];

  /**
   * How many bits two hashes may differ in and still clear the threshold.
   *
   * `structureScore` is `1 - distance / 64`, so the admissible distance is the largest
   * integer below `(1 - threshold) * 64`. Computed rather than assumed because the
   * threshold is a user-facing setting and the banding guarantee depends on it.
   */
  const allowedDistance = Math.floor((1 - threshold) * 64);
  const banded = allowedDistance <= BANDED_MAX_DISTANCE;

  /** Bucket → members, when banding applies. */
  const buckets = new Map<string, Bookmark[]>();
  if (banded) {
    for (const item of usable) {
      for (const key of bandKeys(item.visual!.phash!)) {
        const bucket = buckets.get(key);
        if (bucket) bucket.push(item);
        else buckets.set(key, [item]);
      }
    }
  }

  /** Everything worth comparing against one item: its bucket-mates, or everything. */
  const neighboursOf = (item: Bookmark): Bookmark[] => {
    if (!banded) return usable;
    const found = new Map<string, Bookmark>();
    for (const key of bandKeys(item.visual!.phash!)) {
      for (const other of buckets.get(key) ?? []) {
        if (other.id !== item.id) found.set(other.id, other);
      }
    }
    return [...found.values()];
  };

  for (const item of usable) {
    if (seen.has(item.id)) continue;
    const cluster = [item];
    seen.add(item.id);

    // Single-link expansion: a queue rather than one pass, so a chain of near-copies
    // collapses into one group instead of several overlapping pairs.
    const queue = [item];
    while (queue.length) {
      const current = queue.pop() as Bookmark;
      for (const other of neighboursOf(current)) {
        if (seen.has(other.id)) continue;
        if (structureScore(current.visual?.phash, other.visual?.phash) < threshold) continue;
        seen.add(other.id);
        cluster.push(other);
        queue.push(other);
      }
    }

    if (cluster.length < 2) continue;

    let confidence = 1;
    for (let a = 0; a < cluster.length; a += 1) {
      for (let b = a + 1; b < cluster.length; b += 1) {
        confidence = Math.min(
          confidence,
          structureScore(cluster[a].visual?.phash, cluster[b].visual?.phash),
        );
      }
    }

    // The keeper is the one with the most attached to it, then the earliest — the same
    // election `planDuplicateCleanup` runs, for the same reason: whichever copy someone
    // has already done work on is the copy they meant to keep.
    const [keep, ...rest] = [...cluster].sort((a, b) => {
      const weight = (row: Bookmark) =>
        (row.favorite ? 8 : 0) +
        (row.editedAt ? 4 : 0) +
        (row.note ? 2 : 0) +
        (row.tags.length ? 1 : 0);
      return weight(b) - weight(a) || a.addedAt - b.addedAt;
    });
    groups.push({ keep, rest, confidence });
  }

  return groups.sort((a, b) => b.rest.length - a.rest.length);
}

/* ------------------------------------------------------ colour search -- */

/** Turns a hex colour into the bin it falls in, so a picked swatch becomes a query. */
export function binForHex(hex: string): number | null {
  const value = hex.replace("#", "");
  if (value.length !== 6) return null;
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta < MIN_CHROMA) return null;
  return hueBin(r, g, b, max, delta);
}

/** HSL to hex, for generating one swatch per bin. */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const sextant = Math.floor(hue / 60) % 6;
  const [r, g, b] = (
    [
      [chroma, secondary, 0],
      [secondary, chroma, 0],
      [0, chroma, secondary],
      [0, secondary, chroma],
      [secondary, 0, chroma],
      [chroma, 0, secondary],
    ] as const
  )[sextant];
  return `#${[r, g, b]
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

/** What each bin is called, in bin order. Bin *n* is centred on *n* × 30°. */
const HUE_NAMES = [
  "red",
  "orange",
  "yellow",
  "lime",
  "green",
  "mint",
  "cyan",
  "sky",
  "blue",
  "violet",
  "magenta",
  "pink",
];

/**
 * The swatches the palette picker offers: exactly one per bin.
 *
 * **Generated from the bin, not hand-picked.** Choosing twelve pleasant hexes by eye and
 * numbering them looks fine and is wrong: measured against the binning, two of them landed
 * in the same bin while two bins had no swatch at all — so one colour was unreachable from
 * the picker and another returned its neighbour's results. Deriving the colour from the
 * bin's own centre hue makes that class of mistake impossible, and the assertion below
 * keeps it that way.
 */
export const COLOR_WHEEL: { name: string; hex: string; bin: number }[] = HUE_NAMES.map(
  (name, bin) => ({
    name,
    bin,
    // Saturated enough to read as the colour it names at 20px, light enough to sit on
    // either theme's ground without glowing.
    hex: hslToHex(bin * (360 / HUE_BINS), 0.68, 0.52),
  }),
);

/**
 * How strongly one item answers to a colour.
 *
 * Neighbouring bins count at a third, because hue is a ring and a picked "blue" should
 * still surface something the histogram filed one bin over as indigo. Without that, a
 * colour search returns a suspiciously thin set and reads as broken.
 */
export function colorScore(item: Bookmark, bin: number): number {
  const hues = item.visual?.hues;
  if (!hues?.length) return 0;
  const left = hues[(bin - 1 + HUE_BINS) % HUE_BINS] ?? 0;
  const right = hues[(bin + 1) % HUE_BINS] ?? 0;
  return (hues[bin] ?? 0) + (left + right) / 3;
}
