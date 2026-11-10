/**
 * The background pipeline.
 *
 * ## What it is for
 *
 * A bookmark arrives as three things: a URL, a title someone typed years ago, and nothing
 * else. Everything that makes it *findable* and *recognisable* — the page's own
 * description, its headings and body text for the index, its keywords for tagging, a
 * screenshot to look at, and whether the link is even alive — has to be fetched.
 *
 * This used to be three separate, mostly manual efforts: a screenshot queue that fired
 * only when a card discovered its own preview was missing, a page-reading trickle that
 * was off by default, and a link check nobody ran until something looked broken. The
 * result was a library that stayed grey and unsearchable until the user thought to press
 * three different buttons.
 *
 * The rule now is simple: **a page is processed as soon as it appears in the app.** Not
 * when its card notices something missing, not when a batch job is started — the moment a
 * bookmark exists, all three passes are queued for it.
 *
 * ## Why it is one queue and not three
 *
 * Because they compete. Screenshot capture drives a real headless browser; page reads and
 * link checks are HTTP requests to other people's servers; and all three go through the
 * same local server behind the same rate limits. Three independent schedulers would
 * discover that only by failing — 429s, a renderer thrashing on forty pages at once, a
 * scroll that stutters because the network is saturated with work for rows nobody has
 * reached.
 *
 * One queue can hold the whole picture, and it makes the ordering decision that matters:
 *
 * ## Sighting
 *
 * Work for what is on screen, or nearly on screen, jumps the queue. The grid already
 * computes a band of rows several screens deep to warm images with; the same band is
 * reported here, so a page you are about to scroll to is captured, read and checked
 * *before* one you may never reach. Everything else drains in the background at a pace
 * chosen to be invisible.
 *
 * That single rule is the difference between "the library fills in as I use it" and "the
 * library is busy".
 *
 * ## Being a good citizen
 *
 * Paced with a token bucket well under the server's own limits, capped in flight per kind,
 * suspended when the tab is hidden or the server is unreachable, yielded entirely while a
 * user-initiated job is running, and backed off per URL after a failure. It also stops
 * asking about anything that has already been answered — the durable record of that is
 * the bookmark itself, so a reload never redoes a page.
 */
import { hasPage, type Bookmark, type DeviceName } from "../../shared/types";
import { wakeAfter } from "./wake";

/**
 * The passes the queue runs.
 *
 * `visual` and `offline` were added when the library stopped being links-only. They sit
 * in the same queue as the rest for the reason the module note gives: they compete for
 * the same server, the same rate budget and the same attention, and three schedulers that
 * cannot see each other discover that only by failing.
 *
 * `visual` is the odd one out in that it makes no network request at all — it reads bytes
 * the asset store already holds. It is still queued here rather than run freely, because
 * it decodes an image per unit and a free-running loop over three thousand of them is a
 * main thread nobody can scroll.
 */
export type TaskKind = "shot" | "meta" | "health" | "visual" | "offline";

/**
 * Every pass, in the order the pump considers them.
 *
 * One array rather than a literal repeated at each loop: the list was written out four
 * times, and adding a pass meant finding all four. The two that were missed would have
 * been silent — a queue that fills and is never drained looks exactly like a queue with
 * nothing in it.
 */
export const TASK_KINDS: TaskKind[] = ["shot", "meta", "health", "visual", "offline"];

/** What the pipeline needs from the library layer to actually do the work. */
export interface PipelineWorkers {
  /**
   * Resolves to the URLs that actually produced a screenshot.
   *
   * Takes rows rather than URLs: two bookmarks of the same page are two rows, and both
   * need recording, or the second looks uncaptured and is captured again forever.
   */
  capture: (rows: Bookmark[], device: DeviceName) => Promise<string[]>;
  /**
   * Resolves to the number of rows *recorded*, successful or not.
   *
   * Not the number that succeeded: a page that cannot be read is stamped as attempted, so
   * it is finished as far as this queue is concerned. Returning successes here would make
   * the pipeline retry — and eventually abandon — every 404 in the library, for work that
   * was already correctly completed.
   */
  enrich: (bookmarks: Bookmark[]) => Promise<number>;
  check: (bookmarks: Bookmark[]) => Promise<number>;
  /**
   * Builds the perceptual hash and colour histogram. Resolves to rows recorded.
   *
   * No network: reads bytes already in the asset store. A row whose picture will not
   * decode is still counted as recorded, so it drops out of the queue rather than
   * cycling forever.
   *
   * Optional, like `offline` below, so a caller that only wants the three original passes
   * — every existing test among them — configures the pipeline exactly as it always did.
   * A pass with no worker simply never drains, and `blockedBecause` reports it as off.
   */
  indexVisual?: (bookmarks: Bookmark[]) => Promise<number>;
  /** Fetches a self-contained offline copy. Resolves to rows recorded. */
  offline?: (bookmarks: Bookmark[]) => Promise<number>;
}

export interface PipelineSettings {
  shots: boolean;
  meta: boolean;
  health: boolean;
  visual: boolean;
  offline: boolean;
  device: DeviceName;
}

/**
 * One page the pipeline gave up on, and what happened to it.
 *
 * ## Why a count was not enough
 *
 * The toolbar said "12 skipped · retry", which is true and unusable. Twelve failures out
 * of twelve is a server that is not running; twelve out of four thousand is a handful of
 * dead links. Those need completely different responses from the user, and the count
 * cannot tell them apart — nor can it say *which* twelve, so there is no way to look at
 * one, fix it, or decide it does not matter.
 *
 * Recording the URL, the pass and the last error turns "some things failed" into a list
 * somebody can act on, which on a large library is the whole difference between a
 * background system that is trustworthy and one that is merely quiet.
 */
export interface PipelineFailure {
  url: string;
  kind: TaskKind;
  /** The last error seen for this unit, when one was reported. */
  error?: string;
  attempts: number;
  at: number;
}

export interface PipelineState {
  /** Units of work left, per kind. */
  pending: Record<TaskKind, number>;
  /** Units currently being worked on. */
  active: number;
  /** Units completed this session, per kind. */
  done: Record<TaskKind, number>;
  /** Units abandoned after repeated failure. */
  failed: number;
  /**
   * The abandoned units themselves, newest first.
   *
   * Bounded, because a library-wide outage abandons everything and a list of four thousand
   * identical timeouts is not more informative than a list of fifty — it is just a way to
   * spend memory reporting one fact.
   */
  failures: PipelineFailure[];
  running: boolean;
  /** Why nothing is happening, when nothing is happening. */
  reason: "idle" | "offline" | "paused" | "yielded" | "off" | "working";
}

/* ------------------------------------------------------------------ tuning */

/** Simultaneous units, per kind. Screenshots drive a real browser; be conservative. */
const CONCURRENCY: Record<TaskKind, number> = {
  shot: 2,
  meta: 3,
  health: 1,
  // One at a time: it is main-thread work, and two decoders competing is a dropped frame.
  visual: 1,
  // An archive is the most expensive single request the server makes.
  offline: 1,
};

/** Units per batch. One request covers this many URLs. */
const BATCH: Record<TaskKind, number> = { shot: 5, meta: 3, health: 40, visual: 6, offline: 2 };

/**
 * Requests per minute this module will spend, well under what the server allows.
 *
 * The server's own limiters are a backstop against a bug; this is the number chosen for
 * politeness toward the sites being read, which have not agreed to anything.
 */
const RATE_PER_MINUTE: Record<TaskKind, number> = {
  shot: 24,
  meta: 90,
  health: 20,
  // Generous, because none of it leaves the machine.
  visual: 600,
  // Deliberately meagre: one archive is a hundred-odd requests to somebody else's server.
  offline: 6,
};

/** Attempts before a URL is left alone for the rest of the session. */
const MAX_ATTEMPTS = 2;

/** Idle gap between background units, so the machine never feels occupied. */
const BACKGROUND_GAP_MS = 250;

/* ------------------------------------------------------------------- state */

interface Entry {
  id: string;
  url: string;
  /** Higher is sooner. Sighted rows get a large boost. */
  priority: number;
  attempts: number;
}

/** One queue per kind: a map for O(1) de-duplication, drained by priority. */
const queues: Record<TaskKind, Map<string, Entry>> = {
  shot: new Map(),
  meta: new Map(),
  health: new Map(),
  visual: new Map(),
  offline: new Map(),
};

/** The library, by id, so a task can be handed the current row rather than a stale copy. */
let library = new Map<string, Bookmark>();

const inFlight: Record<TaskKind, number> = { shot: 0, meta: 0, health: 0, visual: 0, offline: 0 };
/**
 * Ids being worked on right now, per pass.
 *
 * `take` removes an entry from its queue, and every library change re-runs
 * `observeLibrary`; without this set the row being worked on still looked unfinished and
 * was queued again, with its attempt count back at zero, so the same page was fetched
 * twice at once and the failure limit never applied.
 */
const running: Record<TaskKind, Set<string>> = {
  shot: new Set(),
  meta: new Set(),
  health: new Set(),
  visual: new Set(),
  offline: new Set(),
};
const done: Record<TaskKind, number> = { shot: 0, meta: 0, health: 0, visual: 0, offline: 0 };
const spent: Record<TaskKind, number[]> = { shot: [], meta: [], health: [], visual: [], offline: [] };
/**
 * URLs abandoned this session, per pass.
 *
 * Per pass, and that distinction is load-bearing. It was briefly one shared set, and the
 * effect was that a page whose *metadata* could not be read — an ordinary 404, which a
 * large real library has hundreds of — was then never screenshotted and never link-checked
 * either. Three independent capabilities were being switched off by the failure of one,
 * silently, in the background.
 */
const abandoned: Record<TaskKind, Set<string>> = {
  shot: new Set(),
  meta: new Set(),
  health: new Set(),
  visual: new Set(),
  offline: new Set(),
};

let workers: PipelineWorkers | null = null;
let settings: PipelineSettings = {
  shots: true,
  meta: true,
  health: true,
  visual: true,
  offline: false,
  device: "desktop",
};
let online = false;
/** Set while a user-initiated job owns the server; the pipeline yields entirely. */
let yielded = false;
let hidden = false;
let failed = 0;
/**
 * The abandoned units, newest first, capped.
 *
 * The cap is what makes this safe to keep at all: an offline server abandons every URL in
 * the library, and holding four thousand records of the same timeout would cost real
 * memory to say something one record already says. The count above stays exact.
 */
const MAX_TRACKED_FAILURES = 60;
let failures: PipelineFailure[] = [];
let pumping = false;
let timer: (() => void) | null = null;

const subscribers = new Set<(state: PipelineState) => void>();
let lastState: PipelineState | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

/* --------------------------------------------------------------- lifecycle */

export function configurePipeline(next: PipelineWorkers): void {
  workers = next;
  schedule(0);
}

export function setPipelineSettings(next: Partial<PipelineSettings>): void {
  const previousDevice = settings.device;
  settings = { ...settings, ...next };
  // Turning a pass off should stop it immediately, not after the queue drains.
  if (!settings.shots) queues.shot.clear();
  if (!settings.meta) queues.meta.clear();
  if (!settings.health) queues.health.clear();
  if (!settings.visual) queues.visual.clear();
  if (!settings.offline) queues.offline.clear();

  /**
   * A new preview device invalidates every abandonment, not every capture.
   *
   * `needsShot` already re-opens the work by comparing against the requested device, so
   * the queue refills from the next `observeLibrary`. What would *not* recover on its own
   * is the abandoned set: a page that failed to render at desktop is not evidence that it
   * will fail at mobile, and leaving it there means the one viewport the user just chose
   * is the one that stays blank.
   */
  if (settings.device !== previousDevice) abandoned.shot.clear();
  schedule(0);
}

export function setPipelineOnline(value: boolean): void {
  if (online === value) return;
  online = value;
  notify();
  schedule(0);
}

/**
 * Stands the pipeline down while a user-initiated job runs.
 *
 * Not a nicety: a foreground "capture this view" and a background sweep both drive the
 * same single renderer, and letting them interleave makes the thing the user is watching
 * take twice as long for no visible reason.
 */
export function yieldPipeline(value: boolean): void {
  yielded = value;
  notify();
  if (!value) schedule(0);
}

/**
 * Wired to `visibilitychange`.
 *
 * Browsers slow timers in hidden tabs to about once a minute after a few minutes, which
 * would starve the queue. While hidden, the pump is woken by a worker timer instead
 * (see `wake.ts`), which those limits do not apply to.
 */
export function setPipelineHidden(value: boolean): void {
  hidden = value;
  schedule(0);
}

/** Whether the tab is hidden. Read by the scheduler only. */
export function pipelineHidden(): boolean {
  return hidden;
}

/* ------------------------------------------------------------------ intake */

/**
 * Tells the pipeline what the library contains, and queues whatever is still missing.
 *
 * Called on every change to the library, so a bookmark added by hand, restored by undo or
 * brought in by an import is picked up within a render — which is what "as soon as it
 * appears" means in practice.
 */
export function observeLibrary(bookmarks: Bookmark[]): void {
  library = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));

  for (const bookmark of bookmarks) {
    if (bookmark.archived) continue;
    enqueueNeeded(bookmark, 0);
  }
  // Anything deleted since the last pass should stop being worked on.
  for (const kind of TASK_KINDS) {
    for (const key of queues[kind].keys()) {
      if (!library.has(key)) queues[kind].delete(key);
    }
  }
  schedule(0);
}

/**
 * Marks bookmarks as imminent, so their work is done before anything else.
 *
 * Fed from the grid's prefetch band — the same rows whose images are being warmed — which
 * means the page you are scrolling toward is captured and read by the time you get there,
 * and a page four thousand rows away waits its turn.
 */
export function sight(bookmarks: Bookmark[]): void {
  const now = Date.now();
  for (const bookmark of bookmarks) {
    if (bookmark.archived) continue;
    // A recency-based boost, so the most recently sighted rows lead even among sighted
    // ones: reversing direction should not leave you behind a band you have left.
    enqueueNeeded(bookmark, now);
  }
  schedule(0);
}

/**
 * Whether a pass is switched on *and* has something to do the work.
 *
 * A pass whose worker was never supplied is off regardless of the preference — otherwise
 * its queue would fill on every `observeLibrary` and never drain, which reports as
 * permanently-pending work that nothing is doing.
 */
function enabled(kind: TaskKind): boolean {
  switch (kind) {
    case "shot":
      return settings.shots;
    case "meta":
      return settings.meta;
    case "health":
      return settings.health;
    case "visual":
      return settings.visual && Boolean(workers?.indexVisual);
    case "offline":
      return settings.offline && Boolean(workers?.offline);
  }
}

/** Whether a pass still owes this row anything. */
function needs(kind: TaskKind, bookmark: Bookmark): boolean {
  switch (kind) {
    case "shot":
      return needsShot(bookmark);
    case "meta":
      return needsMeta(bookmark);
    case "health":
      return needsHealth(bookmark);
    case "visual":
      return needsVisual(bookmark);
    case "offline":
      return needsOffline(bookmark);
  }
}

function enqueueNeeded(bookmark: Bookmark, priority: number): void {
  /**
   * Rows with no page behind them are skipped by the three passes that need one.
   *
   * An uploaded image has no URL to screenshot, read or check, and queueing it would send
   * three requests per pass at the empty string — failing twice each before being
   * abandoned, for every picture in the library.
   */
  const page = hasPage(bookmark);
  for (const kind of TASK_KINDS) {
    if (!enabled(kind)) continue;
    if (kind !== "visual" && !page) continue;
    if (!needs(kind, bookmark)) continue;
    if (abandoned[kind].has(fingerprintOf(kind, bookmark))) continue;
    push(kind, bookmark, priority);
  }
}

/**
 * What a unit of work is given up on *by*.
 *
 * The address for the passes that fetch a page, so two bookmarks of one dead page are given
 * up on together. The row's id for the picture index, since rows without a page all share
 * the empty address and would otherwise give up on each other.
 *
 * One function for both the check and the record. They were written separately, and the
 * record always used the address: a picture that could not be indexed was written down
 * under a key nothing ever looked up, so it was queued again on every change to the library,
 * forever, with its attempts back at zero.
 */
function fingerprintOf(kind: TaskKind, unit: { id: string; url: string }): string {
  return kind === "visual" ? unit.id : unit.url;
}

function push(kind: TaskKind, bookmark: Bookmark, priority: number): void {
  if (running[kind].has(bookmark.id)) return;
  const queue = queues[kind];
  const existing = queue.get(bookmark.id);
  if (existing) {
    if (priority > existing.priority) existing.priority = priority;
    existing.url = bookmark.url;
    return;
  }
  queue.set(bookmark.id, { id: bookmark.id, url: bookmark.url, priority, attempts: 0 });
}

/* ------------------------------------------------------------ what is left */

/**
 * Whether a pass still owes this bookmark anything.
 *
 * Each answer is read from the bookmark itself rather than from a session-local set,
 * which is what makes the work survive a reload: a page read yesterday is not read again
 * today, and closing the tab halfway through a library loses only the unfinished part.
 */
/**
 * A screenshot is owed unless one exists *at the viewport currently being displayed*.
 *
 * The device comparison is the load-bearing half. Cards key their preview on
 * `shot:<device>:<url>`, so a desktop capture is invisible to a grid asking for mobile —
 * and a device-blind `shotAt` check reported that page as finished, permanently. Rows
 * captured before the viewport was recorded are read as desktop, which is what every
 * capture path defaulted to at the time they were written.
 */
function needsShot(bookmark: Bookmark): boolean {
  if (bookmark.health.status === "dead") return false;
  if (!bookmark.preview.shotAt) return true;
  return (bookmark.preview.shotDevice ?? "desktop") !== settings.device;
}

function needsMeta(bookmark: Bookmark): boolean {
  // `meta.fetchedAt` is stamped even when a read fails, precisely so a page that cannot
  // be reached is not retried forever.
  return !bookmark.enriched && !bookmark.meta?.fetchedAt;
}

function needsHealth(bookmark: Bookmark): boolean {
  return bookmark.health.status === "unchecked" && !bookmark.health.checkedAt;
}

/**
 * A row is owed a visual index once it has a picture and has not been indexed.
 *
 * The picture can arrive long after the row does — a screenshot lands, an `og:image` is
 * scraped — so this is re-evaluated on every `observeLibrary`, and a capture landing is
 * what puts the row into this queue for the first time.
 */
function needsVisual(bookmark: Bookmark): boolean {
  if (bookmark.visual?.at) return false;
  return Boolean(bookmark.media?.assetKey || bookmark.preview.shotAt || bookmark.preview.imageUrl);
}

/** `offline.capturedAt` is stamped even on failure, so a dead page is not retried forever. */
function needsOffline(bookmark: Bookmark): boolean {
  return !bookmark.offline?.capturedAt;
}

/* -------------------------------------------------------------------- pump */

function schedule(delay = BACKGROUND_GAP_MS): void {
  if (timer) return;
  timer = wakeAfter(delay, hidden, () => {
    timer = null;
    void pump();
  });
}

function blockedBecause(): PipelineState["reason"] {
  if (!workers) return "idle";
  if (!online) return "offline";
  if (yielded) return "yielded";
  if (!TASK_KINDS.some((kind) => enabled(kind))) return "off";
  /*
    A hidden tab keeps working. Pausing it meant a library only filled in while someone
    sat watching it, which on a few thousand bookmarks is never. `hidden` now only
    changes ordering (nothing is "on screen"), and the token bucket keeps the pace polite.
  */
  return "working";
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const reason = blockedBecause();
    if (reason !== "working") {
      notify();
      return;
    }

    let started = false;
    for (const kind of TASK_KINDS) {
      if (!queues[kind].size) continue;
      if (inFlight[kind] >= CONCURRENCY[kind]) continue;
      if (!spendToken(kind)) continue;
      const batch = take(kind);
      if (!batch.length) continue;
      started = true;
      void run(kind, batch);
    }

    notify();
    if (started || totalPending()) schedule(started ? 0 : BACKGROUND_GAP_MS * 4);
  } finally {
    pumping = false;
  }
}

/**
 * Takes the next batch of one kind, most-imminent first.
 *
 * A sighted row is worth more than any number of background ones, so the sort is on
 * priority alone; ties fall back to insertion order, which for a background sweep means
 * the library's own order and therefore fills the top of the list first.
 */
function take(kind: TaskKind): Entry[] {
  const queue = queues[kind];
  const size = Math.min(BATCH[kind], queue.size);
  const entries = [...queue.values()];
  // A partial sort would be tidier, but these queues are small — at most one entry per
  // bookmark — and this runs a few times a second at most.
  entries.sort((a, b) => b.priority - a.priority);
  const batch = entries.slice(0, size);
  for (const entry of batch) {
    queue.delete(entry.id);
    running[kind].add(entry.id);
  }
  return batch;
}

function totalPending(): number {
  return TASK_KINDS.reduce((sum, kind) => sum + queues[kind].size, 0);
}

async function run(kind: TaskKind, batch: Entry[]): Promise<void> {
  inFlight[kind] += 1;
  try {
    const rows = batch
      .map((entry) => library.get(entry.id))
      .filter((row): row is Bookmark => Boolean(row) && !row!.archived);
    if (!rows.length) return;

    if (kind === "shot") {
      const captured = new Set(await workers!.capture(rows, settings.device));
      for (const entry of batch) {
        if (captured.has(entry.url)) done.shot += 1;
        else retry("shot", entry);
      }
    } else if (kind === "meta") {
      const recorded = await workers!.enrich(rows);
      done.meta += recorded;
      // A page that will never parse is still *recorded* as attempted, so it drops out of
      // `needsMeta` on the next observe rather than looping here. Only a batch that failed
      // wholesale — the server went away mid-request — leaves rows to retry.
      if (recorded < rows.length) retryUnfinished("meta", batch);
    } else if (kind === "health") {
      const checked = await workers!.check(rows);
      done.health += checked;
      if (!checked) for (const entry of batch) retry("health", entry);
    } else if (kind === "visual") {
      const recorded = (await workers!.indexVisual?.(rows)) ?? 0;
      done.visual += recorded;
      if (recorded < rows.length) retryUnfinished("visual", batch);
    } else {
      const recorded = (await workers!.offline?.(rows)) ?? 0;
      done.offline += recorded;
      if (recorded < rows.length) retryUnfinished("offline", batch);
    }
  } catch (error) {
    // The reason travels with the retry, so that if this unit is eventually abandoned the
    // record says *why* rather than only that it happened.
    const reason = error instanceof Error ? error.message : undefined;
    for (const entry of batch) retry(kind, entry, reason);
  } finally {
    inFlight[kind] -= 1;
    for (const entry of batch) running[kind].delete(entry.id);
    notify();
    schedule(BACKGROUND_GAP_MS);
  }
}

/**
 * Retries only the rows that still need the pass, judged from the library as it is now.
 *
 * A count of "recorded" rows cannot say *which* ones were recorded, and slicing the batch
 * by that count retried the wrong rows whenever a missing or archived row had been
 * filtered out first.
 */
function retryUnfinished(kind: TaskKind, batch: Entry[]): void {
  for (const entry of batch) {
    const row = library.get(entry.id);
    if (row && !row.archived && needs(kind, row)) retry(kind, entry);
  }
}

/**
 * Puts a failed unit back, or gives up on it.
 *
 * Giving up is the important half. A URL that times out on every attempt would otherwise
 * cycle through the queue forever, spending the rate budget that the rest of the library
 * needs — and it would do so silently, because a background pass has no user watching it
 * to notice that nothing is progressing.
 */
function retry(kind: TaskKind, entry: Entry, error?: string): void {
  entry.attempts += 1;
  if (entry.attempts >= MAX_ATTEMPTS) {
    failed += 1;
    abandoned[kind].add(fingerprintOf(kind, entry));
    // Newest first, and trimmed from the tail: the most recent failures are the ones a
    // user is most likely to be able to do something about.
    failures = [
      { url: entry.url, kind, error, attempts: entry.attempts, at: Date.now() },
      ...failures,
    ].slice(0, MAX_TRACKED_FAILURES);
    return;
  }
  // Back to the queue, but behind everything that has not failed yet.
  entry.priority = Math.max(0, entry.priority - 1_000);
  queues[kind].set(entry.id, entry);
}

/* --------------------------------------------------------------- the pacer */

/**
 * A sliding-window token bucket, one per kind.
 *
 * Chosen over a fixed delay because the work is bursty by nature — a sighted band queues
 * twenty pages at once — and a fixed delay would either throttle that burst pointlessly or
 * allow a sustained rate far above what was intended. A window enforces the average while
 * letting a burst through.
 */
function spendToken(kind: TaskKind): boolean {
  const now = Date.now();
  const window = spent[kind];
  while (window.length && now - window[0] > 60_000) window.shift();
  if (window.length >= RATE_PER_MINUTE[kind]) return false;
  window.push(now);
  return true;
}

/* ------------------------------------------------------------- subscribers */

export function subscribePipeline(listener: (state: PipelineState) => void): () => void {
  subscribers.add(listener);
  listener(pipelineState());
  return () => subscribers.delete(listener);
}

export function pipelineState(): PipelineState {
  const active = TASK_KINDS.reduce((sum, kind) => sum + inFlight[kind], 0);
  return {
    pending: {
      shot: queues.shot.size,
      meta: queues.meta.size,
      health: queues.health.size,
      visual: queues.visual.size,
      offline: queues.offline.size,
    },
    active,
    done: { ...done },
    failed,
    failures,
    running: active > 0,
    reason: blockedBecause(),
  };
}

/**
 * Coalesced notification.
 *
 * State changes on every unit started and finished, which during a burst is dozens of
 * times a second — and every one of those would re-render a status readout in the
 * toolbar. Once every 400 ms is faster than anyone can read a changing number and slow
 * enough to cost nothing.
 */
function notify(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const state = pipelineState();
    if (
      lastState &&
      lastState.active === state.active &&
      lastState.reason === state.reason &&
      lastState.failed === state.failed &&
      TASK_KINDS.every((kind) => lastState!.pending[kind] === state.pending[kind])
    ) {
      return;
    }
    lastState = state;
    for (const listener of subscribers) listener(state);
  }, 400);
}

/** Lets Settings offer a fresh start after a failure the user has since fixed. */
export function resetPipelineFailures(): void {
  for (const set of Object.values(abandoned)) set.clear();
  failed = 0;
  failures = [];
  schedule(0);
}

/**
 * Gives up on one page for good, without re-opening the rest.
 *
 * The counterpart to "retry everything". Some failures are permanent and known to be — a
 * link that is genuinely dead, a site that will never allow a render — and leaving them in
 * the list means the readout keeps reporting work nobody intends to do. Dismissing one
 * keeps it abandoned but stops it being counted, so the number in the toolbar comes to
 * mean "outstanding" rather than "ever failed".
 */
export function dismissPipelineFailure(url: string, kind: TaskKind): void {
  const before = failures.length;
  failures = failures.filter((entry) => !(entry.url === url && entry.kind === kind));
  if (failures.length !== before) failed = Math.max(0, failed - 1);
  notify();
}

/** Re-opens exactly one abandoned page. */
export function retryPipelineFailure(url: string, kind: TaskKind): void {
  abandoned[kind].delete(url);
  const before = failures.length;
  failures = failures.filter((entry) => !(entry.url === url && entry.kind === kind));
  if (failures.length !== before) failed = Math.max(0, failed - 1);
  schedule(0);
  notify();
}
