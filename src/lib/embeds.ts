/**
 * Things a URL tells you without being fetched.
 *
 * ## Why this exists at all
 *
 * The preview chain is expensive: a screenshot is a real browser rendering a real page,
 * and it is the only tier that works for the ~85% of the web that refuses to be framed.
 * But a handful of hosts publish a canonical thumbnail at a *derivable address*, which
 * means for those the best possible preview is available instantly, offline, from the URL
 * alone — no render, no scrape, no queue.
 *
 * YouTube is overwhelmingly the case that matters: a saved video with no preview is a grey
 * rectangle, and it is a grey rectangle for a picture that has always been one HTTP request
 * away. Vimeo and the rest are here because the same three lines answer them.
 *
 * ## Why it is patterns and not an oEmbed call
 *
 * oEmbed would be more general and would cost a network round trip per bookmark to a
 * third party — which is precisely what this app refuses to do, since it would hand
 * someone else the list of videos in the library. Deriving the address locally keeps the
 * promise; the image itself is then fetched through this origin's own proxy like every
 * other remote asset.
 */

/** A video id and the host it belongs to. */
export interface VideoRef {
  provider: "youtube" | "vimeo";
  id: string;
}

/**
 * Reads a video id out of a URL.
 *
 * Every YouTube form is accepted because people paste all of them: the watch page, the
 * short `youtu.be` link, the embed path, a Shorts link and a live URL. Getting this wrong
 * is invisible — the card simply stays grey — so breadth is worth more here than
 * strictness.
 */
export function videoRef(url: string): VideoRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return id ? { provider: "youtube", id } : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    const query = parsed.searchParams.get("v");
    if (query) return { provider: "youtube", id: query };
    const match = parsed.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    if (match) return { provider: "youtube", id: match[1] };
    return null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const match = parsed.pathname.match(/(?:^|\/)(\d{6,})/);
    if (match) return { provider: "vimeo", id: match[1] };
  }
  return null;
}

/**
 * The thumbnail address for a video URL, or `null`.
 *
 * `hqdefault` rather than `maxresdefault`: the maximum-resolution image does not exist for
 * every video, and when it is missing YouTube answers with a 404 rather than a fallback —
 * so asking for it turns "no preview" into "a broken image" for exactly the older videos
 * least likely to have one. `hqdefault` is generated for everything.
 *
 * Vimeo does not expose a derivable thumbnail path, so it returns nothing rather than a
 * guess: an address that 404s is worse than no address, because the preview chain will
 * spend a request discovering that.
 */
export function thumbnailUrl(url: string): string | null {
  const ref = videoRef(url);
  if (ref?.provider === "youtube") {
    return `https://i.ytimg.com/vi/${encodeURIComponent(ref.id)}/hqdefault.jpg`;
  }
  return null;
}

/** Whether this URL is a video worth treating as one, regardless of what it was saved as. */
export function isVideoUrl(url: string): boolean {
  return videoRef(url) !== null;
}

/* ------------------------------------------------------------ code snippets */

/**
 * Languages the snippet card can label and colour.
 *
 * Detection is by pattern over the text, which is the only signal available when someone
 * pastes code with no context. It is deliberately shallow: guessing between TypeScript and
 * JavaScript reliably requires a parser, and the label is a convenience rather than a fact
 * anything depends on — so an uncertain answer is left blank rather than asserted.
 */
const LANGUAGE_HINTS: { language: string; pattern: RegExp }[] = [
  { language: "html", pattern: /^\s*<!doctype html|^\s*<html[\s>]/i },
  { language: "css", pattern: /^[^{}]*\{[^{}]*:[^{}]*;[^{}]*\}/ },
  { language: "json", pattern: /^\s*[{[][\s\S]*[}\]]\s*$/ },
  { language: "typescript", pattern: /\b(?:interface|type)\s+\w+\s*(?:=|\{)|:\s*(?:string|number|boolean)\b/ },
  { language: "javascript", pattern: /\b(?:const|let|function|=>|import\s.+\sfrom)\b/ },
  { language: "python", pattern: /^\s*(?:def|class)\s+\w+.*:\s*$|^\s*import\s+\w+\s*$/m },
  { language: "rust", pattern: /\bfn\s+\w+\s*\(|\blet\s+mut\b|\bimpl\s+\w+/ },
  { language: "go", pattern: /\bfunc\s+\w+\s*\(|\bpackage\s+main\b/ },
  { language: "sql", pattern: /\bselect\b[\s\S]*\bfrom\b/i },
  { language: "shell", pattern: /^\s*(?:\$|#!)\s?\/?\w|^\s*(?:npm|git|cd|sudo|docker)\s/m },
];

/**
 * Whether a block of text is code, and in what language.
 *
 * Used when something is pasted onto the clip shelf: a snippet saved as a note is a wall
 * of unwrapped prose in a card built for sentences, and it loses the one property that
 * makes code readable, which is its line structure.
 *
 * The bar for calling something code is deliberately high. A false positive turns a
 * paragraph somebody wrote into a monospaced block with a language label on it, which is a
 * more annoying mistake than failing to notice a snippet — so two independent signals are
 * required: the shape of the text, and a language pattern matching it.
 */
export function detectCode(text: string): { isCode: boolean; language?: string } {
  const trimmed = text.trim();
  if (trimmed.length < 24 || trimmed.length > 20_000) return { isCode: false };

  const lines = trimmed.split("\n");
  // Shape: code is line-oriented and punctuated in ways prose is not.
  const indented = lines.filter((line) => /^\s{2,}|\t/.test(line)).length;
  const punctuated = lines.filter((line) => /[{}();=<>]\s*$/.test(line.trim())).length;
  const structural = (indented + punctuated) / Math.max(1, lines.length);
  const symbolDensity =
    (trimmed.match(/[{}()[\];=<>|&/*+_-]/g)?.length ?? 0) / trimmed.length;

  const looksStructural = (lines.length > 2 && structural > 0.3) || symbolDensity > 0.06;
  if (!looksStructural) return { isCode: false };

  for (const { language, pattern } of LANGUAGE_HINTS) {
    if (pattern.test(trimmed)) return { isCode: true, language };
  }
  // Structural but unrecognised — still code, just unlabelled. Better than calling a
  // shell transcript prose because no pattern happened to match it.
  return { isCode: symbolDensity > 0.08, language: undefined };
}

/** Lines in a snippet, for the card's "42 lines" readout. */
export function lineCount(text: string): number {
  return text.replace(/\n+$/, "").split("\n").length;
}

/* ------------------------------------------------------------ sanitisation */

/**
 * Schemes that may appear in a stored URL.
 *
 * ## Why this is enforced on the way *in*
 *
 * An imported bookmarks file is untrusted input that the app renders as links and writes
 * back out on export. A `javascript:` URL in a Netscape bookmark file is a real technique —
 * "bookmarklets" are exactly that, and a malicious one imported from a shared file is a
 * script that runs with the app's origin the moment someone clicks the card.
 *
 * Blocking it at render time would be the obvious place and is the wrong one: the value
 * would still be in the database, still in every export the app writes, and still one
 * missed code path away from being live. Rejecting on import means the dangerous value
 * never exists in the library at all, which is the only version of this that stays true as
 * the app grows more places to click a link.
 *
 * `data:` is refused for the same reason — a `data:text/html` bookmark is a stored page
 * that executes on this origin.
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "ftp:", "mailto:", "file:"]);

export function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  // A scheme-relative or path-relative URL carries no scheme of its own and cannot be a
  // script; `new URL` needs a base to parse it, and http is the right assumption.
  try {
    const parsed = new URL(trimmed, "https://example.invalid");
    return SAFE_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Cleans imported text of things that are never content.
 *
 * ## What this deliberately does *not* do
 *
 * It does not strip `<script>`, or `javascript:`, or anything else that merely looks
 * dangerous in a string. That was the first version of this function and it was wrong in
 * the specific way security code is usually wrong: it defended a boundary that was already
 * held, and broke real data doing it.
 *
 * The boundary is held twice over. React renders these strings as text nodes, so markup in
 * a title is displayed, never parsed. And `escapeHtml` escapes them on the way into an HTML
 * export, so the file this app writes cannot carry an executable payload either. Both are
 * structural — they hold for every string, in every code path, including ones nobody has
 * written yet — which is exactly the property a filter of dangerous-looking substrings does
 * not have.
 *
 * What stripping them did achieve was destroying legitimate titles. "How <script> tags
 * work" is a real page somebody bookmarks, "javascript: the good parts" is a real book, and
 * an import that silently mangles both is a bug the user can see, for a threat that was
 * already answered. The round-trip test in `netscape.test.ts` catches this, and should.
 *
 * ## What is left, and why it is worth doing
 *
 * Control and format characters. They are never meaningful in a bookmark title, they
 * survive both guards above untouched — escaping a NUL still yields a NUL — and they cause
 * two visible problems: two different titles can render identically, so a list appears to
 * hold duplicates it does not, and a bidirectional override can reverse the displayed order
 * of a title to disguise what a link is called. Tab, newline and carriage return are kept,
 * because a multi-line description is ordinary.
 *
 * The scheme allow-list in `isSafeUrl` is where the actual defence lives.
 */
export function sanitizeText(value: string): string {
  return (
    value
      // The C0 and C1 control ranges, less tab, newline and carriage return; then the
      // zero-width and bidirectional format characters used to make two distinct strings
      // render identically.
      // eslint-disable-next-line no-control-regex
      .replace(
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
        "",
      )
      .trim()
  );
}
