/**
 * The results surface: grid, masonry or list, over a windowed scroller.
 *
 * ## Rows are never materialised in bulk
 *
 * The engine hands this an `Int32Array` of row *positions* — four bytes each, so a
 * hundred-thousand-row result is 400 KB rather than a hundred thousand object references.
 * Only the window the grid is about to mount is turned into `Bookmark` objects, and only
 * the band it is about to reach has its pictures warmed. Nothing here ever walks the whole
 * result set.
 *
 * ## The three views are one component
 *
 * They differ in a row height and a card shape, and everything else — selection,
 * keyboard, prefetching, empty states, the skeleton — is identical. Keeping them apart
 * was how the list view ended up without a "select all" and the masonry without an empty
 * state.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { Board, Bookmark, DeviceName, Folder, ViewMode } from "@shared/types";
import type { LibraryIndex } from "@/lib/engine";
import { hashUnit } from "@/lib/utils";
import { pictureFor } from "./media";
import { prefetchAssets } from "@/lib/prefetch";
import { BookmarkCard, BookmarkRow, CardSkeleton, RowSkeleton, type CardChrome } from "./bookmark-card";
import { VirtualGrid } from "./virtual-grid";
import type { ItemActions } from "./item-actions";

/**
 * The card width — one number, not a setting.
 *
 * This used to be a slider. It is not one any more, and that is a deliberate removal:
 * card width is a typographic decision, not a preference. Every other size in the card —
 * the title, the two-line clamp, the meta row, the thumbnail's aspect ratio — was chosen
 * against a particular width, and letting the width move underneath them meant a card at
 * one end of the slider with a title that no longer fit and a card at the other with a
 * picture the size of a stamp. The columns still respond to the window: this is a
 * *minimum*, and the grid fits as many as the space allows and shares the remainder, so a
 * wide display gets more cards rather than wider ones.
 */
const CARD_WIDTH = 256;
/** On a phone, two columns of this minimum width fit side by side. */
const NARROW_CARD_WIDTH = 158;

const NARROW_QUERY = "(max-width: 639px)";
function subscribeNarrow(callback: () => void): () => void {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW_QUERY).matches, () => false);
}

/** Height of the two-line footer under a card's picture. */
const CARD_FOOTER = 76;
/** Height of a whole card when pictures are off and the description carries it instead. */
const TEXT_ONLY_CARD = 122;

export interface LibraryViewProps {
  index: LibraryIndex;
  positions: Int32Array;
  view: ViewMode;
  device: DeviceName;
  showImages: boolean;
  loading: boolean;
  selection: Set<string>;
  onToggleSelect: (id: string, event: { shiftKey: boolean }) => void;
  onOpenDetail: (bookmark: Bookmark) => void;
  actions: ItemActions;
  folders: Folder[];
  boards: Board[];
  folderPaths: Map<string, string>;
  inTrash?: boolean;
  /** Identity of the list being shown, so scroll position follows navigation. */
  scrollKey: string;
  header?: React.ReactNode;
  empty: React.ReactNode;
}

export function LibraryView({
  index,
  positions,
  view,
  device,
  showImages,
  loading,
  selection,
  onToggleSelect,
  onOpenDetail,
  actions,
  folders,
  boards,
  folderPaths,
  inTrash,
  scrollKey,
  header,
  empty,
}: LibraryViewProps) {
  const isList = view === "list";
  const isMasonry = view === "moodboard";

  // Phones get two narrower columns rather than one card the height of the screen.
  const narrow = useNarrowViewport();
  const columnWidth = narrow ? NARROW_CARD_WIDTH : CARD_WIDTH;
  const gap = isList ? 6 : narrow ? 10 : 14;
  /*
   * Uniform-grid row height, derived from the column width.
   *
   * The grid is fixed-height by design: a masonry that has to measure is a masonry that
   * reflows, and the whole reason the aspect ratio of a card is decided up front is so a
   * picture arriving never moves anything below it.
   *
   * The two modes are genuinely different geometries rather than the same one with the
   * picture hidden. With pictures on, a card is a 16:10 frame plus a two-line footer;
   * with them off it is text only, and reserving the picture's height anyway — which is
   * what this did before — left every card in a picture-free library two thirds empty.
   */
  const rowHeight = useMemo(
    () =>
      isList
        ? 52 + gap
        : (width: number) =>
            (showImages ? Math.round(width * 0.625) + CARD_FOOTER : TEXT_ONLY_CARD) + gap,
    [isList, gap, showImages],
  );

  /**
   * The rows currently in the result, materialised lazily by the grid.
   *
   * `VirtualGrid` takes an array and slices it, so it needs something array-shaped of the
   * right length — but building a hundred thousand `Bookmark` references on every filter
   * change is exactly the allocation the position array exists to avoid. A `Proxy` would
   * be too slow per access; instead the array holds positions and `renderItem` resolves
   * the row. `Array.from` on an `Int32Array` is one fast typed copy.
   */
  const items = useMemo(() => Array.from(positions), [positions]);

  const selectionTargets = useCallback(
    (bookmark: Bookmark): Bookmark[] => {
      // A menu opened on a row that is part of a selection acts on the selection; one
      // opened on a row outside it acts on that row alone. Anything else means a
      // right-click can silently affect forty rows the user was not pointing at.
      if (!selection.has(bookmark.id) || selection.size < 2) return [bookmark];
      const rows: Bookmark[] = [];
      for (const id of selection) {
        const position = index.byId.get(id);
        if (position !== undefined) rows.push(index.rows[position]);
      }
      return rows;
    },
    [index, selection],
  );

  const chrome = useMemo<CardChrome>(
    () => ({
      actions,
      folders,
      boards,
      folderPaths,
      device,
      showImages,
      inTrash,
      selectionTargets,
      onOpenDetail,
      onToggleSelect: (id, event) => onToggleSelect(id, event),
    }),
    [
      actions,
      folders,
      boards,
      folderPaths,
      device,
      showImages,
      inTrash,
      selectionTargets,
      onOpenDetail,
      onToggleSelect,
    ],
  );

  /**
   * Warm the pictures the reader is about to reach.
   *
   * Reported by the grid as a *wider* band than what is mounted, biased in the direction
   * of travel — so by the time a card mounts its bytes are local and it paints in the same
   * frame rather than fading in under the reader's eye.
   */
  const onPrefetchRange = useCallback(
    (from: number, to: number) => {
      if (!showImages) return;
      const requests: { key: string; url: string }[] = [];
      const end = Math.min(to, positions.length);
      for (let cursor = Math.max(0, from); cursor < end; cursor += 1) {
        const row = index.rows[positions[cursor]];
        if (!row) continue;
        const picture = pictureFor(row, device);
        if (picture.key && picture.remote) requests.push({ key: picture.key, url: picture.remote });
      }
      prefetchAssets(requests);
    },
    [index, positions, device, showImages],
  );

  /**
   * A card's height in the masonry, from the picture's own aspect ratio — or, for the
   * overwhelming majority of rows, from a stable per-card variation instead.
   *
   * ## Why this cannot just be "the aspect ratio of the picture"
   *
   * That was the original implementation, and it made masonry indistinguishable from the
   * grid: a screenshot is captured at a fixed device viewport (see the `DEVICES` map in
   * `src/ext/background.ts`), so *every* screenshot in the library is the same pixel
   * shape, and an `og:image` is 1.91:1 by convention just as uniformly. A library of
   * ordinary bookmarked pages — which is most libraries — produced a `ratio` that only
   * ever took two values, and a masonry with two row heights is a grid with extra code.
   *
   * Real variety exists in exactly one place: `media.width`/`media.height` on an actual
   * upload. That is a small fraction of any library and stays exactly as authoritative as
   * before. Everything else — every screenshot, every scraped preview — gets a stable
   * multiplier derived from the bookmark's own id: masonry is a curated wall, not a
   * technical drawing, and the box a card gets was already a designed decision rather
   * than a passthrough of a real dimension (this is also why cropping the picture into
   * that box with `object-cover` was always correct). `hashUnit` is deterministic, so the
   * same card is always the same height — a filter, a resort or a re-render never
   * reshuffles the wall — and it is O(1) per card, so it costs nothing at scale.
   *
   * Supplied rather than measured either way: measuring means mounting a card at an
   * unknown size, reading it back and moving everything below it — a reflow per image, and
   * a column that visibly resettles as pictures arrive.
   */
  const heightFor = useCallback(
    (position: number, width: number) => {
      const row = index.rows[position];
      if (!row) return width;
      const media = row.media;
      const realRatio = media?.width && media?.height ? media.height / media.width : null;
      const base =
        realRatio ??
        (row.preview.shotAt
          ? 0.72 // a screenshot is a viewport, and viewports are landscape
          : row.preview.imageUrl
            ? 0.56 // og:images are overwhelmingly 1.91:1
            : 0.62);
      // A real ratio is left alone; everything else is spread across a tasteful range
      // (0.78x - 1.42x) around its baseline, seeded by the one thing about the row that
      // is both unique and constant — its id — rather than by anything that could change
      // between two renders of the same card.
      const ratio = realRatio ?? base * (0.78 + hashUnit(row.id) * 0.64);
      const picture = showImages ? width * Math.min(1.6, Math.max(0.4, ratio)) : 0;
      // The footer is a fixed two lines when there is a picture above it; only the
      // text-only card grows for a description, because only it shows one.
      const text = showImages ? CARD_FOOTER : row.description ? TEXT_ONLY_CARD : 74;
      return Math.round(picture + text);
    },
    [index, showImages],
  );

  /*
   * Nothing to show is three different situations, and only one of them is "empty".
   *
   * Loading has its own skeleton because a spinner over an empty grid reads as "there is
   * nothing here" for as long as it is on screen.
   */
  const skeletonHeight = showImages
    ? Math.round(columnWidth * 0.625) + CARD_FOOTER
    : TEXT_ONLY_CARD;

  if (loading) {
    return (
      <div className="h-full overflow-hidden px-3 pt-1 sm:px-5">
        <div
          className={isList ? "grid gap-1.5" : "grid gap-3.5"}
          // A list is one column; drawn as a grid, its placeholder rows sat side by side.
          style={{ gridTemplateColumns: isList ? "1fr" : `repeat(auto-fill, minmax(${columnWidth}px, 1fr))` }}
          aria-busy
          aria-label="Loading your library"
        >
          {Array.from({ length: 12 }, (_, position) =>
            isList ? (
              <RowSkeleton key={position} />
            ) : (
              <div key={position} style={{ height: skeletonHeight }}>
                <CardSkeleton showImages={showImages} />
              </div>
            ),
          )}
        </div>
      </div>
    );
  }

  if (!positions.length) {
    return (
      <div className="h-full overflow-y-auto px-3 sm:px-5">
        {header}
        {empty}
      </div>
    );
  }

  return (
    <VirtualGrid
      items={items}
      rowHeight={rowHeight}
      minColumnWidth={isList ? 10_000 : columnWidth}
      gap={gap}
      scrollKey={scrollKey}
      header={header}
      onPrefetchRange={onPrefetchRange}
      heightFor={isMasonry && showImages ? heightFor : undefined}
      keyFor={(position) => index.rows[position]?.id ?? String(position)}
      renderItem={(position) => {
        const row = index.rows[position];
        if (!row) return null;
        const selected = selection.has(row.id);
        return isList ? (
          <BookmarkRow
            bookmark={row}
            selected={selected}
            selecting={selection.size > 0}
            chrome={chrome}
          />
        ) : (
          <BookmarkCard
            bookmark={row}
            selected={selected}
            selecting={selection.size > 0}
            chrome={chrome}
          />
        );
      }}
    />
  );
}

/**
 * Warms the first screenful before the grid has reported a range.
 *
 * Without this the opening view waits for a scroll event that may never come — somebody
 * who opens the app and reads what is in front of them would sit looking at plates while
 * every picture they can see is already in the store.
 */
export function useInitialPrefetch(
  index: LibraryIndex,
  positions: Int32Array,
  device: DeviceName,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || !positions.length) return;
    const requests: { key: string; url: string }[] = [];
    const end = Math.min(positions.length, 60);
    for (let cursor = 0; cursor < end; cursor += 1) {
      const row = index.rows[positions[cursor]];
      if (!row) continue;
      const picture = pictureFor(row, device);
      if (picture.key && picture.remote) requests.push({ key: picture.key, url: picture.remote });
    }
    prefetchAssets(requests);
  }, [index, positions, device, enabled]);
}
