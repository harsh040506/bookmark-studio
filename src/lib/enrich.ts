/**
 * What reading a page is allowed to change about a bookmark.
 *
 * Moved out of `useLibrary` so it can be tested as the rules it is, without React: a
 * title the person typed is never replaced, a tag they removed is never re-added, a real
 * screenshot is never downgraded to a page's own image. None of this uses a model: the
 * description is the page's own, the tags are recognised topics from its keywords and
 * headings, and the body text is kept so search finds a bookmark by words in the page.
 */
import type { Bookmark, PageMetadata } from "../../shared/types";
import { topicsIn } from "./classify";
import { extractSummary } from "./text";

export function applyPageMetadata(bookmark: Bookmark, metadata: PageMetadata, now = Date.now()): Bookmark {
  const keywords = Array.isArray(metadata.keywords) ? metadata.keywords.filter((k) => typeof k === "string") : [];
  // The page is untrusted: a list of anything but strings would throw further down.
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  metadata = { ...metadata, keywords, headings: strings(metadata.headings), tech: strings(metadata.tech) };
  // Anything the user wrote by hand outranks anything the page says about itself.
  // Without this, re-reading a page silently discards a corrected title.
  const handWritten = Boolean(bookmark.editedAt);

  const scraped =
    metadata.description?.trim() || (metadata.text ? extractSummary(metadata.text) : "") || "";
  const description =
    handWritten && bookmark.description ? bookmark.description : scraped || bookmark.description;
  const summary = metadata.text ? extractSummary(metadata.text, 320) : bookmark.summary;

  // Only recognisable topics, never loose words from the page: a heading like "Everything
  // you need" must not become the tags `everything` and `need`.
  const pageTopics = new Map<string, number>();
  for (const keyword of metadata.keywords) topicsIn(keyword, pageTopics, 2);
  topicsIn(metadata.title ?? "", pageTopics, 2);
  for (const heading of (metadata.headings ?? []).slice(0, 3)) topicsIn(heading, pageTopics, 1);
  const scrapedTags = [
    ...[...pageTopics.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag),
    ...(metadata.tech ?? []).map((entry) => entry.toLowerCase()),
  ].slice(0, 4);

  // Scraped tags are additive; a tag the user removed is not re-added, because their
  // edit is the more recent statement of intent.
  const nextTags = handWritten
    ? bookmark.tags
    : [...new Set([...bookmark.tags, ...scrapedTags])].slice(0, 12);

  /*
   * Which of those tags the *page* is responsible for.
   *
   * Recorded at the moment of writing, the only moment the distinction is knowable. A
   * tag the user had already typed stays theirs even if the page agrees: their
   * authorship is the older claim, and marking it would tell them their own judgement
   * was guessed.
   */
  const alreadyUsers = new Set(
    bookmark.tags
      .filter((tag) => !bookmark.derivedTags?.includes(tag))
      .map((tag) => tag.toLowerCase()),
  );
  const derived = [
    ...new Set([
      ...(bookmark.derivedTags ?? []),
      ...scrapedTags.filter((tag) => !alreadyUsers.has(tag.toLowerCase())),
    ]),
  ].filter((tag) => nextTags.includes(tag));

  return {
    ...bookmark,
    description,
    summary,
    title: bookmark.title || metadata.title || bookmark.domain,
    tags: nextTags,
    derivedTags: derived.length ? derived : undefined,
    enriched: true,
    meta: {
      siteName: metadata.siteName,
      author: metadata.author,
      publishedAt: metadata.publishedAt,
      type: metadata.type,
      lang: metadata.lang,
      readingMinutes: metadata.readingMinutes,
      headings: metadata.headings?.slice(0, 8),
      keywords: metadata.keywords,
      tech: metadata.tech,
      feedUrl: metadata.feedUrl,
      text: metadata.text?.slice(0, 1500),
      fetchedAt: now,
    },
    preview: {
      ...bookmark.preview,
      // A real screenshot outranks an og:image, so never downgrade.
      method:
        bookmark.preview.method === "screenshot"
          ? "screenshot"
          : metadata.image
            ? "snapshot"
            : bookmark.preview.method,
      imageUrl: metadata.image ?? bookmark.preview.imageUrl,
      capturedAt: now,
    },
  };
}
