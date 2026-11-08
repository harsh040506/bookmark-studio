/**
 * The scroller.
 *
 * ## The goal
 *
 * Scrolling a library of thousands should feel like scrolling a document: the content is
 * simply *there*, above and below, and moving through it costs nothing. Not a list that
 * assembles itself as you arrive, and not one that hitches while it thinks.
 *
 * Two things have to be true at once for that, and they pull against each other:
 *
 *   1. **The DOM must stay small.** Three thousand cards is three thousand images, layers
 *      and event targets; the browser cannot keep that smooth however carefully it is
 *      written.
 *   2. **Nothing may ever be seen arriving.** The moment a card fades in under the
 *      reader's eye, the illusion that the list was always there is gone.
 *
 * ## How both are satisfied
 *
 * **Mount a window, not the list.** Only the rows near the viewport exist. The rest of
 * the scroll height is reserved by a spacer, so the scrollbar still describes the whole
 * library and the position is honest.
 *
 * **Make the window much larger than the viewport.** Overscan is measured in screens, not
 * rows, so it adapts to the window size and to whichever view is active: roughly a screen
 * and a half is rendered above and below what you can see. At any ordinary scroll speed
 * the cards you reach were mounted seconds ago.
 *
 * **Fetch images even further ahead than that.** Mounting early is not enough, because an
 * image that mounts at the edge of the window still has to be fetched and decoded. The
 * grid therefore reports a second, wider range — several screens ahead, biased in the
 * direction of travel — whose images are warmed into the browser cache. By the time those
 * rows mount, their images are local, so they paint in the same frame as the card.
 *
 * **Move the window with `transform`.** The mounted rows sit in one absolutely positioned
 * layer that is translated into place. Changing `translate3d` is a compositor operation;
 * changing `top` is a layout one, and at 120 Hz on a trackpad that difference is the
 * difference between smooth and not.
 *
 * **Coalesce scroll to one update per frame.** A trackpad emits scroll events far faster
 * than the display refreshes, and each one here re-renders the mounted cards. Reading the
 * position inside a frame callback collapses that burst to exactly the number of updates
 * that can be shown.
 *
 * **Promote the layer only while it is moving.** `will-change: transform` earns its keep
 * during a gesture and costs memory the rest of the time, so it is applied on the first
 * scroll event and dropped once the list has been still for a moment.
 */
import { ArrowUp } from "@/components/icons";
import { AnimatePresence, motion } from "motion/react";
import { computeMasonry, itemsInBand } from "@/lib/masonry";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface VirtualGridProps<T> {
  items: T[];
  /**
   * Height of a row in pixels, including the gap below it.
   *
   * Either a fixed number, or — for a card whose picture has a fixed aspect ratio — a
   * function of the width a column actually got. The distinction matters: `minColumnWidth`
   * is a *minimum*, and the grid shares the leftover space among the columns it fitted, so
   * a card is almost always wider than the minimum. Reserving height from the minimum
   * therefore reserves too little, and a 16:10 picture at the real width eats the
   * difference out of whatever is under it — which is how the card footers ended up
   * clipping their second line.
   */
  rowHeight: number | ((columnWidth: number) => number);
  /** Narrowest a column may get before the grid drops to fewer columns. */
  minColumnWidth: number;
  gap?: number;
  renderItem: (item: T, index: number) => ReactNode;
  keyFor: (item: T, index: number) => string;
  header?: ReactNode;
  footer?: ReactNode;
  /**
   * Rows whose images should be warmed: wider than what is mounted, and pushed ahead of
   * the direction of travel. Called only when the range meaningfully changes.
   */
  onPrefetchRange?: (start: number, end: number) => void;
  /**
   * Identity of the list being shown. Changing it resets the scroll position to the top
   * — a different folder is a different document, and starting it half-read is wrong.
   */
  scrollKey?: string;
  /**
   * Turns the grid into a masonry: each item gets the height this returns, and cards
   * flow into whichever column is currently shortest.
   *
   * Supplying a height rather than measuring one is the whole design. Measuring means
   * mounting a card at an unknown size, reading it back, and moving everything below it
   * — a reflow per image, and a column of cards that visibly resettles as pictures
   * arrive. The aspect ratio of a screenshot, an upload or a video poster is known
   * before any of them are fetched, so the layout can be computed once, exactly, and
   * never moved again.
   *
   * `width` is the resolved column width, so a caller can turn an aspect ratio into
   * pixels. The returned height excludes the gap below the card.
   */
  heightFor?: (item: T, width: number) => number;
}

/** How much to mount beyond the viewport, in screenfuls, on each side. */
const OVERSCAN_SCREENS = 1.5;
/** How much further to warm images, in screenfuls, ahead of where you are going. */
const PREFETCH_SCREENS_AHEAD = 4;
/** And behind, so reversing direction is covered too. */
const PREFETCH_SCREENS_BEHIND = 1;
/** Silence after the last scroll event before the layer is demoted again. */
const SETTLE_MS = 140;
/**
 * How far down before "back to top" is worth offering.
 *
 * Three screens: below that the top is still reachable by flicking, and a button that
 * appears while someone is browsing the first few rows is an interruption rather than a
 * shortcut.
 */
const BACK_TO_TOP_SCREENS = 3;

/**
 * Remembered scroll offsets, keyed by list identity.
 *
 * Returning to a folder you were half-way down and being put back at the top is a small
 * betrayal that makes people stop using the Back button. Module-level rather than state
 * because it must survive the grid unmounting, which is exactly what happens in between.
 *
 * Bounded, because the key is not a bounded set. It includes the live search text, so
 * every keystroke in the search box mints a new identity — typing one twenty-character
 * query leaves twenty entries behind, and a long session of searching grows this map
 * without limit for offsets that will never be read again. The cap is generous next to
 * the number of places a person actually revisits, and eviction is
 * least-recently-touched: `remember` re-inserts, which moves a key to the end of the
 * Map's iteration order, so the oldest are simply the first out of the iterator.
 */
const scrollMemory = new Map<string, number>();
const MAX_REMEMBERED_OFFSETS = 200;

function remember(key: string, offset: number): void {
  if (!key) return;
  scrollMemory.delete(key);
  scrollMemory.set(key, offset);
  while (scrollMemory.size > MAX_REMEMBERED_OFFSETS) {
    const oldest = scrollMemory.keys().next();
    if (oldest.done) break;
    scrollMemory.delete(oldest.value);
  }
}

export function VirtualGrid<T>({
  items,
  rowHeight: rowHeightProp,
  minColumnWidth,
  gap = 16,
  renderItem,
  keyFor,
  header,
  footer,
  onPrefetchRange,
  scrollKey = "",
  heightFor,
}: VirtualGridProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [headerHeight, setHeaderHeight] = useState(0);
  const [moving, setMoving] = useState(false);

  /** Direction of travel, so images are warmed where the reader is actually heading. */
  const direction = useRef<1 | -1>(1);
  const lastTop = useRef(0);
  const frame = useRef<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onScroll = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setMoving(false), SETTLE_MS);
    setMoving(true);

    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const element = scrollRef.current;
      if (!element) return;
      const top = element.scrollTop;
      if (top !== lastTop.current) direction.current = top > lastTop.current ? 1 : -1;
      lastTop.current = top;
      remember(scrollKey, top);
      setScrollTop(top);
    });
  }, [scrollKey]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    /**
     * Measure the *content* box, not the padding box.
     *
     * `clientWidth` includes the scroller's own horizontal padding. The uniform grid
     * never noticed, because it is a CSS grid laid out inside that padding and the
     * browser does the arithmetic. Masonry positions every card by hand, so counting the
     * padding as usable width makes each column too wide and pushes the last one off the
     * right-hand edge — cards visibly clipped, and the further right the worse.
     */
    const measure = () => {
      const style = getComputedStyle(element);
      const padding =
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      setViewport({
        width: Math.max(0, element.clientWidth - padding),
        height: element.clientHeight,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  // The header scrolls with the content, so its height shifts where the grid starts.
  useLayoutEffect(() => {
    const element = headerRef.current;
    if (!element) {
      setHeaderHeight(0);
      return;
    }
    const observer = new ResizeObserver(() => setHeaderHeight(element.offsetHeight));
    observer.observe(element);
    setHeaderHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, [header]);

  /**
   * A different list starts at the top; the same list resumes where it was left.
   *
   * Applied in a layout effect so the restored position is in place before the browser
   * paints — restoring after paint shows a frame of the top of the list and reads as a
   * flicker rather than as continuity.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const remembered = scrollMemory.get(scrollKey) ?? 0;
    element.scrollTop = remembered;
    lastTop.current = remembered;
    setScrollTop(remembered);
  }, [scrollKey]);

  const columns = Math.max(
    1,
    Math.floor((viewport.width + gap) / (minColumnWidth + gap)) || 1,
  );
  const rows = Math.ceil(items.length / columns);

  const columnWidth = columns > 0 ? (viewport.width - gap * (columns - 1)) / columns : 0;
  // Before the first measurement there is no real width to ask about; the minimum is the
  // best guess and is replaced on the layout effect that follows the first paint.
  const rowHeight =
    typeof rowHeightProp === "function"
      ? rowHeightProp(columnWidth > 0 ? columnWidth : minColumnWidth)
      : rowHeightProp;

  /**
   * The masonry layout, recomputed only when its inputs actually move.
   *
   * Not on scroll: this walks every item, and doing that per frame is precisely the cost
   * the windowing exists to avoid. It depends on the list, the column count and the
   * column width, all of which change on a resize or a filter — never on a gesture.
   */
  const masonry = useMemo(() => {
    if (!heightFor || !viewport.width || !items.length) return null;
    return computeMasonry(items, columns, columnWidth, gap, heightFor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- heightFor is memoised upstream
  }, [items, columns, columnWidth, gap, heightFor, viewport.width]);

  /** Total scroll height, from whichever layout is in force. */
  const contentHeight = masonry ? masonry.height : rows * rowHeight;

  /**
   * Keep the viewport inside the content after the list shrinks.
   *
   * Narrowing a filter can cut the list from 900 items to 12 while the scroll position
   * stays at row 300 — the browser clamps the scrollbar but fires no event, so the grid
   * would keep rendering a window past the end and the user would see an empty page with
   * no indication that results exist above. Clamping rather than jumping to zero matters:
   * this runs after *any* change to the list, a favourite being toggled included, and
   * snapping to the top on each of those would throw away the reader's place.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    if (element.scrollTop > maxScroll) {
      element.scrollTop = maxScroll;
      lastTop.current = maxScroll;
      setScrollTop(maxScroll);
    }
  }, [items.length, columns, rowHeight, headerHeight, contentHeight]);

  const relativeScroll = Math.max(0, scrollTop - headerHeight);
  const overscan = Math.max(viewport.height * OVERSCAN_SCREENS, rowHeight * 2);

  const firstRow = Math.max(0, Math.floor((relativeScroll - overscan) / rowHeight));
  const lastRow = Math.min(
    rows,
    Math.ceil((relativeScroll + viewport.height + overscan) / rowHeight),
  );

  const startIndex = firstRow * columns;
  const endIndex = Math.min(items.length, lastRow * columns);
  const visible = useMemo(
    () => items.slice(startIndex, endIndex),
    [items, startIndex, endIndex],
  );

  /** The masonry's mounted set: item indices whose boxes fall inside the same window. */
  const visibleMasonry = useMemo(() => {
    if (!masonry) return [];
    return itemsInBand(masonry, relativeScroll - overscan, relativeScroll + viewport.height + overscan);
  }, [masonry, relativeScroll, overscan, viewport.height]);


  /**
   * Warm a wider band than is mounted, weighted towards where the reader is going.
   *
   * Reported to the parent rather than acted on here: this component knows about rows,
   * not about what a row contains or how to fetch it.
   */
  const lastPrefetch = useRef({ start: -1, end: -1 });
  useEffect(() => {
    if (!onPrefetchRange || !viewport.height) return;
    const ahead = viewport.height * PREFETCH_SCREENS_AHEAD;
    const behind = viewport.height * PREFETCH_SCREENS_BEHIND;
    const downwards = direction.current === 1;

    let from: number;
    let to: number;
    if (masonry) {
      // The band index already answers "what is between these two offsets"; the warm-up
      // is the same question asked of a taller window. Reported as a contiguous span
      // because that is the contract the parent prefetches against, and in a masonry the
      // indices in a band are near-contiguous anyway.
      const inBand = itemsInBand(
        masonry,
        relativeScroll - (downwards ? behind : ahead),
        relativeScroll + viewport.height + (downwards ? ahead : behind),
      );
      if (!inBand.length) return;
      from = inBand[0];
      to = inBand[inBand.length - 1] + 1;
    } else {
      from = Math.max(
        0,
        Math.floor((relativeScroll - (downwards ? behind : ahead)) / rowHeight) * columns,
      );
      to = Math.min(
        items.length,
        Math.ceil(
          (relativeScroll + viewport.height + (downwards ? ahead : behind)) / rowHeight,
        ) * columns,
      );
    }

    // Only re-report on a real change, or every scroll frame would re-walk the range.
    if (from === lastPrefetch.current.start && to === lastPrefetch.current.end) return;
    lastPrefetch.current = { start: from, end: to };
    onPrefetchRange(from, to);
  }, [relativeScroll, viewport.height, rowHeight, columns, items.length, onPrefetchRange, masonry]);

  /**
   * Where the reader is, as a position in the list rather than as a fraction of a bar.
   *
   * A scrollbar on a windowed grid is easy to distrust — the content is synthesised, so
   * people reasonably wonder whether the thumb means anything. "1,240 of 3,000" is drawn
   * from the same arithmetic that decides what to mount, and it is the number someone
   * actually wants when they are three thousand rows into a library.
   */
  const positionLabel = useMemo(() => {
    if (!items.length || !viewport.height) return "";
    // In a masonry the same question is answered by asking the layout which card sits at
    // the middle of the viewport, rather than by dividing an offset by a row height that
    // no longer describes anything.
    const middle = masonry
      ? (itemsInBand(masonry, relativeScroll + viewport.height / 2, relativeScroll + viewport.height / 2)[0] ?? 0) + 1
      : Math.min(
          items.length,
          Math.max(1, Math.round(((relativeScroll + viewport.height / 2) / rowHeight) * columns)),
        );
    return `${middle.toLocaleString()} of ${items.length.toLocaleString()}`;
  }, [items.length, relativeScroll, viewport.height, rowHeight, columns, masonry]);

  const farDown = relativeScroll > viewport.height * BACK_TO_TOP_SCREENS;

  /**
   * How far through the list, as a fraction.
   *
   * Drawn from the same arithmetic that decides which rows to mount, so it is an honest
   * readout of the real position rather than a second opinion. A native scrollbar answers
   * the same question, but on a windowed grid people reasonably distrust it — the content
   * is synthesised, so the thumb *looks* like it might be describing something else.
   */
  const progress =
    contentHeight > viewport.height
      ? relativeScroll / Math.max(1, contentHeight - viewport.height)
      : 0;

  const backToTop = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Smooth, because the point is to show that this is the *same* list arriving back at
    // its start; an instant jump is indistinguishable from having navigated somewhere.
    element.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <div className="relative h-full">
      {/*
        Progress as a hairline rather than as a component.

        A native scrollbar answers the same question, but on a windowed grid people
        reasonably distrust it — the content is synthesised, so the thumb looks like it
        might be describing something else. This is drawn from the same arithmetic that
        decides which rows to mount, and a `scaleX` on an existing layer is free.
      */}
      {progress > 0.002 ? (
        <div className="bs-scroll-progress">
          <div
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>
      ) : null}
      {/*
        The list dissolves at its bottom edge rather than being cut by one.

        A hard edge asserts that the content ends there. It does not — there is more, just
        out of frame — and a fade says so without adding an object to the page.
        Deliberately a `mask-image` on the scroller and not a stack of `backdrop-filter`
        layers: a backdrop filter over a region that is moving forces the compositor to
        re-read and re-blur the page behind it on every single frame, which measured at
        roughly 50 ms a frame here. A mask is applied by the compositor for free.
      */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          maskImage:
            "linear-gradient(to bottom, #000 0, #000 calc(100% - 56px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, #000 0, #000 calc(100% - 56px), transparent 100%)",
        }}
        className="h-full overflow-x-hidden overflow-y-auto px-3 pt-1 pb-24 sm:px-5"
      >
        {header && <div ref={headerRef}>{header}</div>}

        <div style={{ height: contentHeight, position: "relative" }}>
          {masonry ? (
            /*
              Masonry mounts each card at its own absolute box.

              There is no moving layer to translate here — every card already carries its
              own `y`, so the window is expressed by *which* cards exist rather than by
              where a container sits. That is strictly cheaper: no transform to
              recompute, and a card's position never changes for the whole time it is
              mounted, so nothing it contains can be asked to re-layout by the scroller.
            */
            <div style={{ willChange: moving ? "transform" : "auto" }}>
              {visibleMasonry.map((index) => {
                const box = masonry.boxes[index];
                return (
                  <div
                    key={keyFor(items[index], index)}
                    style={{
                      position: "absolute",
                      transform: `translate3d(${box.x}px, ${box.y}px, 0)`,
                      width: box.width,
                      height: box.height,
                    }}
                  >
                    {renderItem(items[index], index)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translate3d(0, ${firstRow * rowHeight}px, 0)`,
                willChange: moving ? "transform" : "auto",
                display: "grid",
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap,
                alignContent: "start",
              }}
            >
              {visible.map((item, offset) => (
                <div key={keyFor(item, startIndex + offset)} style={{ height: rowHeight - gap }}>
                  {renderItem(item, startIndex + offset)}
                </div>
              ))}
            </div>
          )}
        </div>

        {footer}
      </div>

      {/*
        Two things that only exist while the list is moving or deep.

        Both are absent at rest, which is the whole point: a persistent position readout and
        a permanent "back to top" are two more objects to look past on every screen, and
        neither has anything to say until you are somewhere a long way from where you
        started.
      */}
      <AnimatePresence>
        {moving && positionLabel && contentHeight > viewport.height * 2 && (
          <motion.div
            key="position"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6, transition: { duration: 0.15 } }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="bs-position tabular"
          >
            {positionLabel}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {farDown && !moving && (
          <motion.button
            key="top"
            type="button"
            onClick={backToTop}
            initial={{ opacity: 0, scale: 0.9, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 4, transition: { duration: 0.14 } }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="bs-backtotop"
            aria-label="Back to the top of the list"
            title="Back to top"
          >
            <ArrowUp size={16} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
