/**
 * "Share as a page": a set of bookmarks as one self-contained HTML file.
 *
 * There is no account and no server that keeps anything, so there is no hosted share link.
 * Instead the share is a file — pictures inlined as data URIs — that opens in any browser on
 * any machine with no network, outlives this app, and cannot leak because there is no URL for
 * anyone to find. It says on its face that it is a snapshot taken on a date.
 *
 * The page is styled in the app's own design language (warm paper, serif headings, hairline
 * cards, light and dark from the reader's preference) but written out in full rather than
 * reusing the app's stylesheet: whoever opens it does not have this app, so it can depend on
 * nothing, and it falls back to the reader's system fonts.
 */
import type { Bookmark } from "../../shared/types";
import { getAssetBlob } from "./assets";
import { escapeHtml } from "./netscape";

async function toDataUri(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export interface ShareOptions {
  title: string;
  /** Where each row's picture lives, resolved by the caller (which knows the preview device). */
  assetKeyFor: (bookmark: Bookmark) => string | null;
  /** Include the pictures. Off produces a small, text-only page. */
  withImages: boolean;
  onProgress?: (done: number, total: number) => void;
}

/** Largest picture to inline. Above it the card falls back to text — the link is still there. */
const MAX_INLINE_BYTES = 900_000;

export async function buildSharePage(bookmarks: Bookmark[], options: ShareOptions): Promise<string> {
  const cards: string[] = [];

  for (let index = 0; index < bookmarks.length; index += 1) {
    const bookmark = bookmarks[index];
    let image: string | null = null;
    if (options.withImages) {
      const key = options.assetKeyFor(bookmark);
      if (key) {
        const blob = await getAssetBlob(key);
        if (blob && blob.size <= MAX_INLINE_BYTES) image = await toDataUri(blob);
      }
    }
    options.onProgress?.(index + 1, bookmarks.length);

    const href = bookmark.url ? escapeHtml(bookmark.url) : "";
    const title = escapeHtml(bookmark.title);
    const origin = escapeHtml(bookmark.domain || (bookmark.media ? "Uploaded" : ""));
    const note = bookmark.description ? escapeHtml(bookmark.description) : "";
    cards.push(
      [
        `<article class="card">`,
        image
          ? `<img src="${image}" alt="${escapeHtml(bookmark.alt ?? "")}" loading="lazy">`
          : `<div class="plate">${escapeHtml((bookmark.title || "?").slice(0, 1).toUpperCase())}</div>`,
        `<div class="meta">`,
        href
          ? `<a class="title" href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`
          : `<span class="title">${title}</span>`,
        origin ? `<span class="origin">${origin}</span>` : "",
        note ? `<p class="note">${note}</p>` : "",
        `</div>`,
        `</article>`,
      ].join(""),
    );
  }

  const exported = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Bookmark Studio">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: light dark; --paper: #faf9f5; --card: #ffffff; --ink: #1f1e1d; --ink-2: #52514e;
          --muted: #898781; --line: rgba(11,11,11,.1); --plate: #ecebe6; --link: #256abf; }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #0b0b0b; --card: #151515; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
            --line: rgba(255,255,255,.1); --plate: #20201f; --link: #3987e5; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); line-height: 1.5;
         font: 14px/1.5 "DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         -webkit-font-smoothing: antialiased; }
  header, main, footer { max-width: 76rem; margin: 0 auto; padding-left: 24px; padding-right: 24px; }
  header { padding-top: 48px; padding-bottom: 20px; }
  h1 { margin: 0; font: 400 32px/1.2 "Newsreader", ui-serif, Georgia, "Times New Roman", serif; letter-spacing: -.01em; }
  .count { margin: 6px 0 0; color: var(--muted); font-size: 12.5px; }
  main { display: grid; gap: 14px; padding-bottom: 56px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  .card { background: var(--card); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column;
          box-shadow: 0 0 0 1px var(--line), 0 1px 2px rgba(11,11,11,.06), 0 2px 8px rgba(11,11,11,.08); }
  .card img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; display: block; background: var(--plate); border-bottom: 1px solid var(--line); }
  .plate { width: 100%; aspect-ratio: 16 / 10; display: grid; place-items: center; background: var(--plate); color: var(--muted);
           font: 400 30px/1 ui-serif, Georgia, serif; border-bottom: 1px solid var(--line); }
  .meta { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .title { font-size: 13.5px; font-weight: 500; color: inherit; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a.title:hover { color: var(--link); }
  .origin { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { margin: 6px 0 0; font-size: 12.5px; color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  footer { padding-bottom: 40px; color: var(--muted); font-size: 12.5px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(options.title)}</h1>
  <p class="count">${bookmarks.length.toLocaleString()} item${bookmarks.length === 1 ? "" : "s"} · ${escapeHtml(exported)}</p>
</header>
<main>
${cards.join("\n")}
</main>
<footer>
  A snapshot taken on ${escapeHtml(exported)} with Bookmark Studio. It does not update, and nothing here was uploaded anywhere — the pictures are inside this file.
</footer>
</body>
</html>`;
}
