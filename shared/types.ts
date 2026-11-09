/**
 * Data model shared by the client and the scraping/health server.
 * Everything here is derived deterministically — no model calls anywhere in this app.
 */

export type HealthStatus =
  | "live"
  | "redirected"
  | "dead"
  | "blocked"
  | "unchecked";

export type PreviewMethod = "live" | "screenshot" | "snapshot" | "card";

export type DeviceName = "desktop" | "tablet" | "mobile";

/**
 * What a saved item actually *is*.
 *
 * The library began as links only, which made one assumption at the type level: every
 * row has a URL, a domain and a page behind it worth screenshotting. That is false for
 * most of what people save. A pasted screenshot has no page; a tweet is text that may
 * carry a video; an uploaded image is bytes and nothing else.
 *
 * `link` is the original behaviour and stays the default, so every row written before
 * this field existed reads correctly without a migration pass.
 */
export type ItemKind = "link" | "image" | "video" | "note" | "clip" | "code";

export const ITEM_KINDS: ItemKind[] = ["link", "image", "video", "note", "clip", "code"];

/**
 * The coarse facet the format filter offers: All / Videos / Images / Links / Notes.
 *
 * Distinct from {@link ItemKind} because a `clip` is whatever was on the clipboard — an
 * image clip belongs under Images, a text clip under Notes — so the filter groups by
 * what the thing *is to look at*, not by how it arrived.
 */
export type FormatFacet = "all" | "links" | "images" | "videos" | "notes";

/** Bytes this library owns, held in the asset store rather than fetched from a host. */
export interface MediaRef {
  /** Key into the asset store (`src/lib/assets.ts`). */
  assetKey: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Video only. */
  durationMs?: number;
  /** Video only: asset key of a still frame, so a card need not decode the video. */
  posterKey?: string;
  /** Original file name, when the item came from an upload. */
  fileName?: string;
}

/**
 * Where a library's rows came from, as a standing connection rather than one import.
 *
 * An import batch is an event — a file, read once, on a date. A source is the *place*
 * rows keep arriving from: a browser, an X archive, an Eagle library, the clipboard.
 * Modelling them separately is what lets the sidebar say "Chrome 469" and offer a
 * re-read, where a batch list could only ever say "bookmarks (3), 12 March".
 */
export type SourceKind =
  | "browser"
  | "x"
  | "eagle"
  | "clipboard"
  | "upload"
  | "manual";

export interface Source {
  id: string;
  kind: SourceKind;
  /** "Chrome", "Arc", "X · Bookmarks", "Eagle". */
  name: string;
  /** Chrome/Arc/Firefox/Safari, for the icon. Absent on non-browser sources. */
  browser?: string;
  createdAt: number;
  /** When rows were last read in from this source. */
  syncedAt?: number;
  /** Whether a re-read is offered. False for one-shot sources like a single upload. */
  resyncable: boolean;
}

/**
 * A perceptual-hash and palette summary, so "looks like" needs no model.
 *
 * `phash` is a 64-bit average hash as 16 hex characters; two images are compared by
 * Hamming distance over those bits. `hues` is a 12-bin hue histogram, normalised, which
 * both refines a visual match by colour and answers "search by colour" on its own.
 *
 * Both are computed in the browser from bytes already in the asset store, so nothing is
 * uploaded and no model is consulted — the same classical approach Muse uses beside its
 * embeddings, minus the embeddings.
 */
export interface VisualIndex {
  /** 16 hex chars = 64 bits of average hash. */
  phash?: string;
  /** 12 hue bins, each 0..1, summing to ~1 over chromatic pixels. */
  hues?: number[];
  /** Share of sampled pixels that carried usable chroma, 0..1. */
  chroma?: number;
  /** Mean lightness 0..1, so "dark ui" is answerable. */
  lightness?: number;
  /** When this index was computed, so a re-capture recomputes it. */
  at?: number;
}

/**
 * A self-contained copy of a page, readable with the network off.
 *
 * Not a screenshot: the server fetches the page and inlines its stylesheets, images and
 * fonts as data URIs into a single HTML file, so what opens is the real document — text
 * selectable, links intact — rather than a picture of it.
 */
export interface OfflineCopy {
  /** Key into the asset store holding the single-file HTML. */
  assetKey: string;
  capturedAt: number;
  bytes: number;
  /** How many subresources were inlined, for the detail panel's readout. */
  inlined?: number;
  /** Recorded when a capture failed, so it is not retried forever. */
  error?: string;
}

export interface Health {
  status: HealthStatus;
  httpCode?: number;
  finalUrl?: string;
  redirectCount?: number;
  checkedAt?: number;
  /** Wayback Machine snapshot, attached when a link goes dead. */
  archiveUrl?: string;
  error?: string;
}

export interface Preview {
  method: PreviewMethod;
  /** og:image / twitter:image discovered by the scraper. */
  imageUrl?: string;
  capturedAt?: number;
  /** Dominant colours sampled from the favicon or preview image, client-side. */
  colors?: string[];
  /** When a headless-browser screenshot was last stored for this URL. */
  shotAt?: number;
  /**
   * Which viewport that screenshot was taken at.
   *
   * A mobile and a desktop capture of the same page are different pictures stored under
   * different asset keys, so "has a screenshot" is only ever true *of a device*. Without
   * this field the flag was device-blind: switching the preview device left every card
   * requesting a capture that had never been rendered, `shotAt` insisted the work was
   * done, and the library stayed permanently grey.
   *
   * Absent on rows written before this was tracked. Those predate any code path that
   * could capture at another viewport by default, so they are read as `desktop`.
   */
  shotDevice?: DeviceName;
  /** Whether the site's headers permit embedding, as reported by the server. */
  frameable?: boolean;
}

export interface Bookmark {
  id: string;
  /**
   * What this row is.
   *
   * Absent on every row written before the library held anything but links, and read as
   * `"link"` wherever it is missing — see {@link itemKind}. Making it optional rather
   * than backfilling means a 5,000-row library upgrades without a rewrite pass.
   */
  kind?: ItemKind;
  /**
   * The address this item points at.
   *
   * Still required, and still the identity a duplicate is judged on — but for an upload
   * or a pasted image there is nothing to point at, so it holds the empty string. Every
   * consumer that opens, checks or screenshots a row must therefore ask
   * {@link hasPage} first.
   */
  url: string;
  title: string;
  domain: string;
  /** Chrome embeds favicons as base64 in the export — we keep them verbatim. */
  icon?: string;
  /** Meta description (from <DD> in the export, or scraped). */
  description: string;
  /** Extractive summary built from scraped text. Never generated. */
  summary?: string;
  category: string;
  tags: string[];
  folderId: string | null;
  boardIds: string[];
  addedAt: number;
  lastModifiedAt?: number;
  lastVisitedAt?: number;
  visitCount: number;
  health: Health;
  preview: Preview;
  /** True once the scraper has filled in metadata for this bookmark. */
  enriched?: boolean;
  /** Full scraped record, indexed for search and used for tagging. */
  meta?: StoredMetadata;
  /** Free-form user note, kept separate from the scraped description. */
  note?: string;
  /**
   * When the user last edited this bookmark by hand.
   *
   * Set by the edit dialog and read by the scraper: a page re-read must never quietly
   * overwrite a title or description someone deliberately wrote.
   */
  editedAt?: number;
  /**
   * When the person last changed anything about this row: a tag, a folder, a favourite,
   * the trash. Background reads never set it.
   *
   * The website and the extension each keep a copy of the library and swap changes. When
   * both changed the same row before they next spoke, this says whose copy holds the
   * person's latest decision, so a page read on one side cannot undo a tag added on the
   * other. `editedAt` is narrower (hand-written titles and descriptions) and stays as is.
   */
  changedAt?: number;
  favorite?: boolean;
  archived?: boolean;
  /**
   * Position of this entry in the file it was imported from.
   *
   * A browser export is not an arbitrary bag of links — it is the order the person
   * arranged, folder by folder, over years. Discarding it and re-sorting by date is a
   * quiet act of vandalism, so the ordinal is carried through import and exposed as the
   * "As imported" sort.
   */
  sourceOrder?: number;
  /** Which import batch introduced this bookmark. See {@link ImportBatch}. */
  importId?: string;
  /**
   * When this bookmark entered *this* library.
   *
   * Distinct from `addedAt`, which is the browser's original timestamp and is routinely
   * years old. "Recently added" means recently added here — without this field a fresh
   * import of a decade-old library shows nothing as recent.
   */
  importedAt?: number;

  /* ------------------------------------------------- beyond links -------- */

  /** Bytes this library owns: an upload, a clipped image, a downloaded X video. */
  media?: MediaRef;
  /**
   * The item's own words.
   *
   * A note's body, or a tweet's text. Kept apart from `description` (which the scraper
   * writes) and from `note` (which the user writes *about* the item) because for a
   * `note` or a text post this *is* the item, and overwriting it would be data loss.
   */
  text?: string;
  /** Byline: "@npm_i_shaders" for a post, a photographer for an image. */
  author?: string;
  /** Which standing {@link Source} this row arrived from. */
  sourceId?: string;
  /** Perceptual hash + colour histogram, for "looks like" and colour search. */
  visual?: VisualIndex;
  /** A self-contained, offline-readable copy of the page. */
  offline?: OfflineCopy;
  /**
   * When this row was moved to the trash.
   *
   * Distinct from `archived`, which is a place the user files things they want kept but
   * out of the way. Trash is pending deletion: excluded from every view and every
   * background pass, restorable, and emptied deliberately.
   */
  trashedAt?: number;

  /* ------------------------------------------------- provenance of tags -- */

  /**
   * Which entries in {@link tags} came from the page rather than from the user.
   *
   * Modelled as a parallel list rather than by changing `tags` to objects, because
   * `tags: string[]` is read in several dozen places and a structural change there buys
   * nothing the list cannot express. A name absent from here was typed by a person, which
   * is the right default: anything the app cannot prove it derived is treated as the
   * user's, so a machine sparkle is never put against something somebody wrote.
   *
   * Read through {@link tagOrigin} rather than directly.
   */
  derivedTags?: string[];

  /**
   * Alt text, as a first-class editable field.
   *
   * Distinct from `description` (the page's own words about itself) and from `note` (the
   * user's words *about* the item): this describes what the picture shows, and it is the
   * only field that has to be present for the image to be usable by someone who cannot
   * see it. Written by hand; never invented.
   */
  alt?: string;

  /** Language of a code snippet, for the syntax preview. Only set when `kind` is `code`. */
  language?: string;

  /** Passages the user marked on the page, kept with the bookmark rather than on the web. */
  highlights?: Highlight[];
}

/** One passage marked on a page, with an optional note about why. */
export interface Highlight {
  id: string;
  text: string;
  note?: string;
  at: number;
}

/**
 * A collection that populates itself by rule.
 *
 * The difference from a folder is the difference between filing and describing: a folder
 * holds what was put in it, a smart collection holds whatever currently matches. The rule
 * is a query in exactly the language the search box speaks — which is what keeps this from
 * being a second, parallel filter model that can drift out of step with the first.
 */
export interface SmartCollection {
  id: string;
  name: string;
  /** A query string, parsed by `lib/query.ts`. */
  query: string;
  color?: string;
  createdAt: number;
  /** Pinned to the top of the section. */
  pinned?: boolean;
}

/** Where a tag came from. Anything not recorded as derived is the user's own. */
export function tagOrigin(
  item: Pick<Bookmark, "derivedTags">,
  tag: string,
): "user" | "page" {
  return item.derivedTags?.includes(tag) ? "page" : "user";
}

/** Reads the kind of a row, defaulting rows written before the field existed. */
export function itemKind(item: Pick<Bookmark, "kind">): ItemKind {
  return item.kind ?? "link";
}

/** Whether this row has a real page behind it — to open, screenshot, read or check. */
export function hasPage(item: Pick<Bookmark, "kind" | "url">): boolean {
  return Boolean(item.url) && /^https?:\/\//i.test(item.url);
}

/** Which format facet a row answers to. A clip lands under its content, not its origin. */
export function formatOf(item: Pick<Bookmark, "kind" | "media">): Exclude<FormatFacet, "all"> {
  const kind = itemKind(item);
  if (kind === "video") return "videos";
  if (kind === "image") return "images";
  // A snippet is words on a page you wrote down, which is what the Notes facet collects.
  // It keeps its own `kind` so the card can render a syntax preview rather than prose.
  if (kind === "note" || kind === "code") return "notes";
  if (kind === "clip") {
    if (item.media?.mime.startsWith("video/")) return "videos";
    if (item.media?.mime.startsWith("image/")) return "images";
    return "notes";
  }
  return "links";
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  addedAt: number;
  lastModifiedAt?: number;
  /** Chrome marks the bookmarks bar with PERSONAL_TOOLBAR_FOLDER="true". */
  toolbar?: boolean;
  /** Position in the imported file, so the tree can be shown in the user's own order. */
  sourceOrder?: number;
  /** Which import batch created this folder. */
  importId?: string;
}

export interface Board {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

/**
 * One run of the importer.
 *
 * Bookmarks arrive in batches — a Chrome export today, a Firefox one next month, a JSON
 * backup after a reinstall — and until an import is a first-class object there is no way
 * to answer "where did these 900 links come from" or to reverse one wholesale. Modelled
 * after the import groups a contacts manager keeps: named, dated, countable, removable.
 */
export interface ImportBatch {
  id: string;
  /** User-facing name; defaults to the file name. */
  name: string;
  fileName: string;
  at: number;
  format: "html" | "json";
  mode: "merge" | "replace";
  bookmarkCount: number;
  folderCount: number;
  /** Duplicates that were kept rather than skipped, for the import's own summary. */
  duplicateCount: number;
}

/** One entry in the activity log, so destructive actions are traceable and undoable. */
export interface ActivityEntry {
  id: string;
  at: number;
  kind:
    | "import"
    | "delete"
    | "archive"
    | "restore"
    | "move"
    | "tag"
    | "health"
    | "capture"
    | "enrich"
    | "create"
    | "edit"
    | "export"
    | "clip"
    | "upload"
    | "offline"
    | "trash";
  summary: string;
  /** Number of bookmarks the action touched. */
  count: number;
  undoable: boolean;
}

/** The ways to look at a library. */
export type ViewMode = "gallery" | "moodboard" | "list";

export type SortMode =
  | "custom"
  | "recent"
  | "oldest"
  | "title"
  | "visits"
  | "domain"
  | "relevance";

/** User preferences, persisted locally. */
export interface Settings {
  defaultView: ViewMode;
  defaultSort: SortMode;
  /**
   * Capture a screenshot of every page, starting with whatever is on screen.
   *
   * The three `auto*` switches below are the background pipeline: each turns one pass on
   * or off, and with all three on a freshly imported library illustrates, indexes and
   * verifies itself without anybody pressing anything. They default on because the
   * alternative — a library that stays grey and unsearchable until the user discovers
   * three separate buttons — is not a defensible default for a tool whose entire value is
   * in what it knows about the pages.
   */
  autoCapture: boolean;
  /**
   * Read each page's own HTML: its description, headings and body text.
   *
   * This is what makes a bookmark titled "Files" findable by searching "figma", so it is
   * the pass that most changes what the app is capable of. It does make one HTTP request
   * per bookmark to the sites themselves, which is why it is a switch at all.
   */
  autoEnrich: boolean;
  /** Check that every link still resolves, and note where it now redirects to. */
  autoCheckLinks: boolean;
  /**
   * Ceiling on stored image bytes, in megabytes.
   *
   * The app keeps every screenshot, preview image and favicon in its own store rather
   * than in the browser's cache, which means it — and the person using it — is now
   * responsible for how much disk that takes. Least-recently-shown assets are evicted
   * past this figure.
   */
  assetBudgetMb: number;
  previewDevice: DeviceName;
  showScreenshots: boolean;
  confirmDeletes: boolean;
  reduceMotion: boolean;
  /** Restore the last view, sort and scope on the next launch. */
  rememberView: boolean;
  /** Keep duplicate URLs on import instead of discarding them silently. */
  keepDuplicatesOnImport: boolean;

  /* --------------------------------------------------- added with kinds -- */

  /**
   * Build the perceptual-hash and colour index for stored images.
   *
   * The pass that makes "looks like" and "search by colour" answerable. Runs entirely in
   * this browser over bytes the app already holds — no upload, no model — but it decodes
   * every image once, so it is a switch.
   */
  autoIndexVisuals: boolean;
  /** Fetch a self-contained offline copy of each page as it appears. */
  autoOfflineCopy: boolean;
  /** How close two images must look before they are called the same picture, 0..1. */
  lookalikeThreshold: number;

  /**
   * How long the filter waits after the last keystroke, in milliseconds.
   *
   * Zero disables it. The default is short enough to be imperceptible and long enough
   * that a burst of typing runs the whole selection pipeline once rather than per letter.
   */
  searchDebounceMs: number;

  /** Default strictness for "Looks like", so the control opens where it was left. */
  lookalikeStrength: "broad" | "balanced" | "strict";

  /**
   * Two-way sync with the browser's own bookmarks, on the website.
   *
   * Always on inside the extension (there the library *is* the browser's bookmarks). On the
   * website it needs the extension installed, and only counts once the person has chosen
   * (`browserSyncChosen`); until then sync follows the extension. See `wantsBrowserSync`.
   */
  browserSync: boolean;
  /**
   * Whether the person has ever switched browser sync on or off themselves.
   *
   * Until they have, sync follows the extension: connected means on. People install the
   * extension to get their bookmarks in, and having to find a second switch afterwards was
   * the most common reason new bookmarks never showed up.
   */
  browserSyncChosen: boolean;
  /**
   * Whether the extension may open small capture windows in the background.
   *
   * A browser extension can only photograph a page by opening it in a real window, and
   * people found those windows flickering in the corner distracting. Off by default: the
   * page's own preview image is used instead, and a screenshot is taken when asked for. The
   * local server's headless renderer is invisible, so it is not affected by this switch.
   */
  captureWithWindows: boolean;
  /**
   * Whether the website and the extension share one library.
   *
   * Browsers give a website and an extension separate storage, so without this each kept
   * its own library and only bookmarks synced through Chrome appeared in both. On: while
   * the extension is connected, changes on either side are copied to the other.
   */
  shareWithExtension: boolean;
  /** Whether the first-run welcome has been dismissed. */
  welcomed: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultView: "gallery",
  defaultSort: "recent",
  autoCapture: true,
  autoEnrich: true,
  autoCheckLinks: true,
  assetBudgetMb: 1024,
  previewDevice: "desktop",
  showScreenshots: true,
  confirmDeletes: true,
  reduceMotion: false,
  rememberView: true,
  keepDuplicatesOnImport: true,
  autoIndexVisuals: true,
  autoOfflineCopy: false,
  lookalikeThreshold: 0.86,
  searchDebounceMs: 120,
  lookalikeStrength: "balanced",
  browserSync: false,
  browserSyncChosen: false,
  captureWithWindows: false,
  shareWithExtension: true,
  welcomed: false,
};

/** Whether browser sync should run when the extension is reachable: on unless switched off. */
export function wantsBrowserSync(settings: Pick<Settings, "browserSync" | "browserSyncChosen">): boolean {
  return settings.browserSyncChosen ? settings.browserSync : true;
}

/** Result of scraping a page — server side, cheerio only. */
export interface PageMetadata {
  url: string;
  finalUrl?: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  icon?: string;
  keywords: string[];
  /** First few paragraphs of body text, used for extractive summaries + tags. */
  text?: string;
  /** Headings give strong topical signal for search without any model. */
  headings?: string[];
  author?: string;
  publishedAt?: string;
  /** og:type — article, website, product, video… */
  type?: string;
  lang?: string;
  /** Rough reading time in minutes, from word count. */
  readingMinutes?: number;
  /** Detected technologies (generator meta, framework fingerprints). */
  tech?: string[];
  /** RSS/Atom feed advertised by the page. */
  feedUrl?: string;
  /**
   * Outbound links the page carries, deduplicated by host.
   *
   * Collected so "Discover" can be answered from the library's own reading rather than
   * from a recommendation service. Capped hard — a link farm must not be able to write
   * thousands of rows into one bookmark.
   */
  links?: { url: string; text?: string }[];
  /** Fonts the page declares, for the design readout. */
  fonts?: string[];
  /** CSS gradients found in the page's own styles. */
  gradients?: string[];
  error?: string;
}

/**
 * Everything scraped from a page, kept on the bookmark so search, tagging and the
 * detail panel all read from one stored record rather than re-fetching.
 */
export interface StoredMetadata {
  siteName?: string;
  author?: string;
  publishedAt?: string;
  type?: string;
  lang?: string;
  readingMinutes?: number;
  headings?: string[];
  keywords?: string[];
  tech?: string[];
  feedUrl?: string;
  /** Body text kept for search; capped before storage. */
  text?: string;
  /** Outbound links, for Discover. Capped at storage time. */
  links?: { url: string; text?: string }[];
  /** Typefaces the page declares. */
  fonts?: string[];
  /** CSS gradients lifted from the page's styles. */
  gradients?: string[];
  fetchedAt?: number;
  /**
   * Why the read failed, when it did.
   *
   * A page that could not be fetched still has to be marked as attempted, or the
   * background pass would retry it forever. Recording *why* keeps that distinct from a
   * page that genuinely has nothing to say, so the UI never claims to have read
   * something it could not reach.
   */
  error?: string;
}

export interface HealthResult {
  url: string;
  status: HealthStatus;
  httpCode?: number;
  finalUrl?: string;
  redirectCount: number;
  elapsedMs: number;
  error?: string;
}

/** What `/api/snapshot` reports about a page it inlined into one file. */
export interface SnapshotResult {
  url: string;
  finalUrl?: string;
  bytes: number;
  /** Subresources folded into the document. */
  inlined: number;
  /** Subresources that could not be fetched and were left as absolute URLs. */
  skipped: number;
  error?: string;
}

/**
 * One outbound link seen on pages this library has already read.
 *
 * The honest, local answer to "what else should I look at": the sites the pages you
 * saved themselves point at, ranked by how many of your pages point there, with anything
 * already in the library removed. No recommendation service, no profile, no request —
 * it is computed from `meta.links`, which the scraper already collected.
 */
export interface DiscoverSuggestion {
  domain: string;
  url: string;
  title?: string;
  /** How many distinct pages in the library link here. */
  cited: number;
  /** Titles of a few citing pages, so the suggestion can explain itself. */
  because: string[];
}
