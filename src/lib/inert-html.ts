/**
 * Prepares a stranger's HTML for `DOMParser` on the extension page.
 *
 * A parsed document never runs its handlers, but Chrome checks each `onclick="…"`-style
 * attribute against the page's Content Security Policy while it parses, and logs an
 * "Executing inline event handler violates…" error for every one it finds. Reading a few
 * hundred pages filled the console with them. Renaming the attributes inside tags before
 * parsing keeps the console clean. Text between tags is left alone, so a page that talks
 * about `onclick=` still reads correctly.
 */
const TAG = /<[a-zA-Z][^<>]*>/g;
const HANDLER = /([\s/"'])on([a-z]+\s*=)/gi;

/** The prefix renamed handler attributes carry, so a sanitizer can drop them too. */
export const INERT_HANDLER_PREFIX = "data-inert-on";

export function inertHtml(html: string): string {
  return html.replace(TAG, (tag) => tag.replace(HANDLER, `$1${INERT_HANDLER_PREFIX}$2`));
}
