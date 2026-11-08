/**
 * The shape every importer produces, and the vocabulary the registry is written in.
 *
 * ## Why there is an intermediate type at all
 *
 * Twenty-eight sources, nine file formats, one library. Without a common intermediate,
 * "import" means twenty-eight code paths that each independently decide how to canonicalise
 * a URL, what to do with a missing timestamp, whether a folder path is a string or a list,
 * and how a duplicate is recognised — and twenty-eight chances for one of them to be subtly
 * different from the rest. `RawItem` is the narrow waist: a parser's only job is to produce
 * these, and everything downstream (normalising, classifying, de-duplicating, folder
 * reconstruction, provenance) is written exactly once against them.
 *
 * A `RawItem` is deliberately *not* a `Bookmark`. It carries only what a file can actually
 * say — no ids, no category, no health, no preview — so a parser cannot invent library
 * state, and a normaliser is the single place where library state gets minted.
 */
import type { ItemKind, SourceKind } from "../../../shared/types";

/** One entry as a source file described it, before this library has decided anything. */
export interface RawItem {
  /** The address. Empty is allowed only for kinds that have no page (a note). */
  url: string;
  title?: string;
  /** The source's own summary of the page. */
  description?: string;
  /** A note the *user* wrote about the item, where the source distinguishes the two. */
  note?: string;
  tags?: string[];
  /**
   * Folder path as segments, outermost first.
   *
   * A list rather than a delimited string because folder names legitimately contain
   * slashes ("AI / ML", "Design / Type"), and splitting a joined path back apart is the
   * kind of lossy round-trip that silently invents folders nobody made.
   */
  folderPath?: string[];
  addedAt?: number;
  lastModifiedAt?: number;
  /** Base64 data URI or an https favicon URL, when the file carried one. */
  icon?: string;
  favorite?: boolean;
  archived?: boolean;
  author?: string;
  /** The item's own words — a note body, a post. */
  text?: string;
  kind?: ItemKind;
  /**
   * Position in the file, in reading order.
   *
   * The user's own arrangement, and the only ordering in a bookmarks file that no
   * timestamp can reconstruct. Every parser must supply it.
   */
  order: number;
}

/** What one parser made of one file. */
export interface ParsedFile {
  items: RawItem[];
  /** Entries dropped because the address was unusable (javascript:, place:, empty). */
  skipped: number;
  /** Non-fatal problems worth telling the user about, deduplicated and capped. */
  warnings: string[];
}

export const EMPTY_PARSE: ParsedFile = { items: [], skipped: 0, warnings: [] };

/** The parsers the registry can name. One format, one implementation. */
export type ParserId =
  | "netscape"
  | "chromium-json"
  | "firefox-json"
  | "safari-plist"
  | "enex"
  | "csv"
  | "json"
  | "x-archive"
  | "text-urls"
  | "backup";

/** How a source's files are recognised, and what to tell the user about getting one. */
export interface SourceDefinition {
  id: string;
  /** What the user calls it: "Chrome", "Raindrop.io". */
  name: string;
  group: "Browsers" | "Read later" | "Bookmarking" | "Notes & archives" | "Files";
  /** Which standing {@link SourceKind} rows from here are attributed to. */
  kind: SourceKind;
  /** One sentence on where the export lives, shown in the import dialog. */
  hint: string;
  /** File extensions this source can produce, for the picker's `accept`. */
  accept: string[];
  /** Parsers to try, best first. */
  parsers: ParserId[];
  /**
   * Column presets for CSV sources.
   *
   * A CSV has no self-describing structure beyond its header row, and every service
   * spells the same four columns differently. Naming the aliases here rather than in the
   * CSV parser keeps the parser generic and the per-service knowledge in the one file
   * that is *about* per-service knowledge.
   */
  csv?: CsvPreset;
  /**
   * How strongly a file looks like it came from here, 0..1.
   *
   * A hint, never a gate: detection picks the default and the user can override it, so a
   * wrong guess costs a click rather than an import.
   */
  detect?: (input: DetectInput) => number;
}

export interface CsvPreset {
  url: string[];
  title?: string[];
  description?: string[];
  note?: string[];
  tags?: string[];
  folder?: string[];
  addedAt?: string[];
  favorite?: string[];
  archived?: string[];
  /** Separator inside a tags cell, when it is not a comma. */
  tagSeparator?: RegExp;
}

export interface DetectInput {
  fileName: string;
  /** Lower-cased file name, precomputed because every detector wants it. */
  lowerName: string;
  /** Extension without the dot, lower-cased. */
  extension: string;
  /** The first stretch of the file as text, lower-cased. Capped — see `readHead`. */
  head: string;
  /** The same stretch with original case, for structure-sensitive checks. */
  rawHead: string;
  size: number;
}

/** What the import dialog shows before anything is written. */
export interface ImportPreview {
  sourceId: string;
  sourceName: string;
  parser: ParserId;
  /** Usable entries the file yielded. */
  total: number;
  /** Of those, how many are already in the library under the same canonical URL. */
  duplicates: number;
  /** Of those, how many repeat *within the file itself*. */
  internalDuplicates: number;
  folders: number;
  skipped: number;
  warnings: string[];
  /** A handful of entries, so the user can see the parse worked before committing. */
  sample: { title: string; url: string; folder: string }[];
  /** Oldest and newest timestamps the file carried, when it carried any. */
  span?: { from: number; to: number };
}

/** Progress from the worker while a large file is being read. */
export interface ImportProgress {
  phase: "reading" | "parsing" | "normalising" | "deduplicating" | "done";
  done: number;
  total: number;
}
