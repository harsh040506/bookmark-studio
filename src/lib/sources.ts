/**
 * Where a library's rows keep coming from.
 *
 * ## Why this is not the import list
 *
 * An import batch answers "what arrived on 12 March, from which file". A source answers
 * "where does this library get its rows" — and those are different questions with
 * different lifetimes. Re-exporting Chrome every few months produces six batches and one
 * source; the sidebar wants to say *Chrome · 469*, offer one re-read, and let the batches
 * stay what they are, an audit trail underneath.
 *
 * The distinction is what makes the rail in the reference read the way it does: a short,
 * stable list of places, not a growing pile of files. Batches keep their own rail.
 *
 * ## What is honestly available here
 *
 * A browser export is a file the user hands over, so "Chrome" is a source that is
 * re-read by re-exporting. X is the same: the archive it hands you on request is a file,
 * and this reads that file. What this deliberately does *not* do is hold an access token
 * and poll an API on the user's behalf — that would mean an account, a key, and a
 * standing outbound connection, which is the arrangement the whole app exists to avoid.
 * "Refresh" therefore means "give me the current export", and the UI says so rather than
 * implying a sync that is not happening.
 */
import type { Bookmark, Source, SourceKind } from "../../shared/types";
import { newId } from "./utils";

/** Presentation for each kind of source: what to call it and how to draw it. */
export const SOURCE_KINDS: Record<
  SourceKind,
  { label: string; hint: string; resyncable: boolean }
> = {
  browser: {
    label: "Browser",
    hint: "Bookmarks exported from a browser",
    resyncable: true,
  },
  x: {
    label: "X",
    hint: "Bookmarks and posts from an X data archive",
    resyncable: true,
  },
  eagle: {
    label: "Eagle",
    hint: "An Eagle library folder",
    resyncable: true,
  },
  clipboard: {
    label: "Clips",
    hint: "Saved from the clipboard shelf",
    resyncable: false,
  },
  upload: {
    label: "Media",
    hint: "Files added from this device",
    resyncable: false,
  },
  manual: {
    label: "Saved links",
    hint: "Added by hand",
    resyncable: false,
  },
};

/**
 * Guesses which browser an export came from.
 *
 * The file itself does not say. What it does carry are habits: Firefox writes a `TAGS`
 * attribute and names its root "Bookmarks Menu"; Chrome and Edge write
 * `PERSONAL_TOOLBAR_FOLDER` and call it "Bookmarks bar"; Safari exports no favicons at
 * all. None of these is conclusive, which is why this returns a *label* the user can
 * rename rather than a fact the app asserts anywhere it matters.
 */
export function guessBrowser(html: string, fileName: string): string {
  const name = fileName.toLowerCase();
  if (name.includes("firefox")) return "Firefox";
  if (name.includes("safari")) return "Safari";
  if (name.includes("edge")) return "Edge";
  if (name.includes("arc")) return "Arc";
  if (name.includes("brave")) return "Brave";

  const head = html.slice(0, 20_000);
  if (/TAGS="/i.test(head) || /Bookmarks Menu/i.test(head)) return "Firefox";
  if (/PERSONAL_TOOLBAR_FOLDER/i.test(head)) return "Chrome";
  return "Browser";
}

export function createSource(
  kind: SourceKind,
  name: string,
  options: { browser?: string } = {},
): Source {
  return {
    id: newId("src"),
    kind,
    name,
    browser: options.browser,
    createdAt: Date.now(),
    syncedAt: Date.now(),
    resyncable: SOURCE_KINDS[kind].resyncable,
  };
}

/**
 * Finds an existing source a new import belongs to, so re-exporting does not stack.
 *
 * Matched on kind plus name, because that is the pair the user recognises: importing
 * Chrome twice should count to one "Chrome", while a Chrome and an Arc export are two
 * places even though both are browsers.
 */
export function matchSource(sources: Source[], kind: SourceKind, name: string): Source | null {
  const wanted = name.trim().toLowerCase();
  return (
    sources.find((source) => source.kind === kind && source.name.trim().toLowerCase() === wanted) ??
    null
  );
}

export interface SourceWithCount extends Source {
  /** Live rows currently attributed to this source. */
  count: number;
}

/**
 * Sources with their current contents counted, in a stable order.
 *
 * Counted live rather than stored for the same reason the import rail counts live: a
 * stored total goes stale the first time something is deleted, and a sidebar whose
 * numbers disagree with the view they open teaches people to distrust every other number
 * in the app.
 */
export function sourcesWithCounts(sources: Source[], bookmarks: Bookmark[]): SourceWithCount[] {
  const counts = new Map<string, number>();
  for (const bookmark of bookmarks) {
    if (bookmark.trashedAt || !bookmark.sourceId) continue;
    counts.set(bookmark.sourceId, (counts.get(bookmark.sourceId) ?? 0) + 1);
  }
  return sources
    .map((source) => ({ ...source, count: counts.get(source.id) ?? 0 }))
    // Biggest first: the rail is a way in, and the place with the most in it is the one
    // most often being reached for. Ties fall back to arrival so the order is total.
    .sort((a, b) => b.count - a.count || a.createdAt - b.createdAt);
}
