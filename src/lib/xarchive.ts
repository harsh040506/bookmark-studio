/**
 * Reading an X (Twitter) data archive.
 *
 * ## Why an archive and not the API
 *
 * Connecting an account would mean an OAuth app, a stored token, a paid API tier and a
 * standing outbound connection carrying the user's identity — four things this app does
 * not have and one it refuses on principle. X will hand any account holder the same data
 * on request, as a file, under *Settings → Your account → Download an archive*.
 *
 * So this reads the file. It is slower to obtain and it is complete, offline, and costs
 * nobody an account.
 *
 * ## What the file actually looks like
 *
 * The archive is a folder of JavaScript, not JSON: every file opens with an assignment
 * like `window.YTD.bookmark.part0 = [ ... ]` so it can be loaded by the archive's own
 * offline viewer with a `<script>` tag. The payload after the `=` is valid JSON, which is
 * what makes this parseable without executing anything — the assignment prefix is
 * stripped and the remainder is parsed as data. Nothing here evaluates the file.
 *
 * Two shapes matter:
 *   · `bookmark.js` — the bookmarks themselves, as `{ tweet: { ... } }` wrappers.
 *   · `tweets.js` / `tweet.js` — the account's own posts, same inner shape.
 *
 * Both carry `entities` and `extended_entities`, which is where the media lives: an
 * image's `media_url_https`, a video's `video_info.variants` sorted by bitrate. Those
 * URLs are public and unauthenticated, which is what lets the media be fetched and stored
 * for offline use afterwards.
 */
import type { ItemKind } from "../../shared/types";

/** The subset of an archived tweet this reads. Everything else in the record is ignored. */
interface ArchivedTweet {
  id_str?: string;
  id?: string;
  full_text?: string;
  text?: string;
  created_at?: string;
  favorite_count?: string | number;
  retweet_count?: string | number;
  lang?: string;
  user?: { screen_name?: string; name?: string };
  entities?: {
    media?: ArchivedMedia[];
    urls?: { expanded_url?: string; url?: string; display_url?: string }[];
    hashtags?: { text?: string }[];
  };
  extended_entities?: { media?: ArchivedMedia[] };
}

interface ArchivedMedia {
  type?: string;
  media_url_https?: string;
  media_url?: string;
  expanded_url?: string;
  video_info?: {
    duration_millis?: number;
    variants?: { bitrate?: number; content_type?: string; url?: string }[];
  };
  original_info?: { width?: number; height?: number };
}

export interface ParsedPost {
  /** X's own id, so re-importing the same archive does not duplicate. */
  externalId: string;
  kind: ItemKind;
  url: string;
  title: string;
  text: string;
  author?: string;
  authorName?: string;
  createdAt: number;
  tags: string[];
  /** Remote media to fetch and store. Empty for a text-only post. */
  media: { url: string; mime: string; kind: "image" | "video"; durationMs?: number }[];
  /** A link the post pointed at, when it carried exactly one. */
  linkedUrl?: string;
  favorites: number;
}

export interface XArchiveResult {
  posts: ParsedPost[];
  /** Records that could not be read, counted so a partial import is never silent. */
  skipped: number;
  /** Which file shape this was, for the import summary. */
  kind: "bookmarks" | "tweets" | "unknown";
}

/**
 * Strips the archive's `window.YTD.x.partN = ` prefix and parses what remains.
 *
 * Written as a scan for the first `[` or `{` rather than a regex against the assignment,
 * because the prefix varies across archive vintages (`window.YTD.bookmark.part0`,
 * `window.YTD.tweets.part0`, and older files with no prefix at all). Finding the start of
 * the JSON is both simpler and correct for all of them.
 */
export function stripArchiveAssignment(source: string): unknown {
  const trimmed = source.trimStart();
  const start = trimmed.search(/[[{]/);
  if (start < 0) throw new SyntaxError("No JSON payload found in the archive file");
  const payload = trimmed.slice(start).trim().replace(/;+\s*$/, "");
  return JSON.parse(payload);
}

function readTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Picks the highest-bitrate MP4 among a video's variants. */
function bestVariant(media: ArchivedMedia): { url: string; mime: string } | null {
  const variants = (media.video_info?.variants ?? [])
    .filter((variant) => variant.url && variant.content_type === "video/mp4")
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const best = variants[0];
  return best?.url ? { url: best.url, mime: "video/mp4" } : null;
}

function toPost(raw: ArchivedTweet, fallbackAt: number): ParsedPost | null {
  const id = raw.id_str ?? raw.id;
  if (!id) return null;

  const text = (raw.full_text ?? raw.text ?? "").trim();
  const handle = raw.user?.screen_name;
  // The archive omits the author on the account's own tweets, since it is implied.
  const url = handle
    ? `https://x.com/${handle}/status/${id}`
    : `https://x.com/i/status/${id}`;

  const mediaEntries = raw.extended_entities?.media ?? raw.entities?.media ?? [];
  const media: ParsedPost["media"] = [];
  for (const entry of mediaEntries) {
    if (entry.type === "video" || entry.type === "animated_gif") {
      const variant = bestVariant(entry);
      if (variant) {
        media.push({
          ...variant,
          kind: "video",
          durationMs: entry.video_info?.duration_millis,
        });
      }
      continue;
    }
    const image = entry.media_url_https ?? entry.media_url;
    if (image) {
      // `:orig` asks X's CDN for the full-resolution original rather than the timeline
      // crop, which is the difference between an archive worth keeping and a thumbnail.
      media.push({ url: `${image}?name=orig`, mime: "image/jpeg", kind: "image" });
    }
  }

  /**
   * The link a post points at.
   *
   * Only when there is exactly one: a post carrying several is *about* something else,
   * and picking one of them arbitrarily would mislabel the item. `t.co` wrappers are
   * skipped in favour of `expanded_url`, which the archive helpfully provides.
   */
  const outbound = (raw.entities?.urls ?? [])
    .map((entry) => entry.expanded_url ?? entry.url)
    .filter((value): value is string => Boolean(value) && !/^https?:\/\/t\.co\//i.test(value ?? ""));
  const linkedUrl = outbound.length === 1 ? outbound[0] : undefined;

  const kind: ItemKind = media.some((entry) => entry.kind === "video")
    ? "video"
    : media.length
      ? "image"
      : "note";

  // A post's title is its first line, because it has no title and the alternative — the
  // handle, or the id — is the same string on every row and sorts uselessly.
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  const title = firstLine.slice(0, 120) || (handle ? `Post by @${handle}` : "Post");

  return {
    externalId: id,
    kind,
    url,
    title,
    text,
    author: handle ? `@${handle}` : undefined,
    authorName: raw.user?.name,
    createdAt: readTimestamp(raw.created_at, fallbackAt),
    tags: (raw.entities?.hashtags ?? [])
      .map((tag) => tag.text?.toLowerCase())
      .filter((tag): tag is string => Boolean(tag))
      .slice(0, 6),
    media,
    linkedUrl,
    favorites: Number(raw.favorite_count ?? 0) || 0,
  };
}

/**
 * Reads one file out of an X archive.
 *
 * Accepts both the `bookmark.js` and `tweets.js` shapes, and both the wrapped
 * (`{ tweet: {...} }`) and bare record forms, because the wrapper key has changed across
 * archive vintages and an importer that only knows the current one silently reads zero
 * rows out of a file that is full of them.
 */
export function parseXArchive(source: string, fileName = ""): XArchiveResult {
  let payload: unknown;
  try {
    payload = stripArchiveAssignment(source);
  } catch {
    return { posts: [], skipped: 0, kind: "unknown" };
  }
  if (!Array.isArray(payload)) return { posts: [], skipped: 0, kind: "unknown" };

  const now = Date.now();
  const posts: ParsedPost[] = [];
  let skipped = 0;

  for (const entry of payload) {
    if (!entry || typeof entry !== "object") {
      skipped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    // Unwrap whichever envelope this vintage used.
    const inner = (record.tweet ?? record.bookmark ?? record.like ?? record) as ArchivedTweet;
    const post = toPost(inner, now);
    if (post) posts.push(post);
    else skipped += 1;
  }

  const name = fileName.toLowerCase();
  const kind: XArchiveResult["kind"] = name.includes("bookmark")
    ? "bookmarks"
    : name.includes("tweet")
      ? "tweets"
      : "unknown";

  return { posts, skipped, kind };
}

/** Whether a file looks like part of an X archive, for the import dialog's routing. */
export function looksLikeXArchive(fileName: string, head: string): boolean {
  if (/^(bookmark|tweets?|like)s?(-part\d+)?\.js$/i.test(fileName)) return true;
  return /window\.YTD\.(bookmark|tweets?|like)/i.test(head.slice(0, 400));
}

