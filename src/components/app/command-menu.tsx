/**
 * The command palette: one box that reaches everything.
 *
 * ## Ranking happens in the engine, not in cmdk
 *
 * cmdk's own filter scores every mounted item on each keystroke. That is right for a menu
 * of twenty and a stall at a library of fifty thousand, so `shouldFilter` is off and the
 * palette renders an already-ranked, already-capped answer from the same selection engine
 * the grid uses. The consequence worth stating: what the palette finds and what the grid
 * finds can never disagree, because they are the same query.
 *
 * ## What it is allowed to show
 *
 * Bookmarks, places (folders, tags, collections, sources, scopes) and commands. Each group
 * is capped at a handful — a palette that lists forty tags is a palette nobody reads to the
 * bottom of, and the point of the cap is that the top few are the answer.
 */
import {
  ArrowRight,
  Archive,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Folder as FolderIcon,
  Hash,
  Heart,
  Inbox,
  LayoutGrid,
  Library,
  Link2,
  List,
  Moon,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  TriangleAlert,
  Wand2,
} from "@/components/icons";
import { useDeferredValue, useMemo, useState, type ReactNode } from "react";

import type { Board, Bookmark, Folder, SmartCollection } from "@shared/types";
import { select, type LibraryIndex } from "@/lib/engine";
import { expandQuery } from "@/lib/fuzzy";
import { folderEntries, rankFolders } from "@/lib/library";
import type { Vocabulary } from "@/lib/fuzzy";
import { parseQuery } from "@/lib/query";
import type { Route } from "@/lib/router";
import type { SourceWithCount } from "@/lib/sources";
import type { TfIdfIndex } from "@/lib/tfidf";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { KeyChips } from "@/components/ui/tooltip";
import { Favicon } from "./media";

/** Results per group. Past this the answer is "narrow it", not "scroll". */
const GROUP_LIMIT = 6;
const BOOKMARK_LIMIT = 8;

export interface PaletteCommand {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  group: "Actions" | "View" | "Library";
  run: () => void;
  /** Extra words this command should match on. */
  keywords?: string;
}

export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  index: LibraryIndex;
  textIndex: TfIdfIndex;
  vocabulary: Vocabulary;
  folders: Folder[];
  folderPaths: Map<string, string>;
  boards: Board[];
  smart: SmartCollection[];
  sources: SourceWithCount[];
  tags: Map<string, number>;
  navigate: (route: Route) => void;
  onOpenBookmark: (bookmark: Bookmark) => void;
  onOpenDetail: (bookmark: Bookmark) => void;
  commands: PaletteCommand[];
}

export function CommandMenu(props: CommandMenuProps) {
  const [query, setQuery] = useState("");
  /*
   * The typed value paints immediately; the *search* it drives is deferred.
   *
   * `useDeferredValue` rather than a timer, because React can then keep the input
   * responsive by rendering the expensive list at a lower priority — which is exactly the
   * shape of the problem here, and a timer cannot express it.
   */
  const deferred = useDeferredValue(query);
  const needle = deferred.trim().toLowerCase();

  const results = useMemo(() => {
    if (!needle) return [] as Bookmark[];
    const parsed = parseQuery(deferred);
    // Spelling correction against the library's own vocabulary, so "figam" still finds
    // Figma — reported by the grid, applied silently here where there is no room to say so.
    const expanded = expandQuery(parsed.terms, props.vocabulary);
    const { positions } = select(props.index, props.folders, props.textIndex, {
      query: { ...parsed, terms: expanded.terms },
      scope: "all",
      sort: "relevance",
    });
    const rows: Bookmark[] = [];
    for (let cursor = 0; cursor < Math.min(positions.length, BOOKMARK_LIMIT); cursor += 1) {
      rows.push(props.index.rows[positions[cursor]]);
    }
    return rows;
  }, [needle, deferred, props.index, props.folders, props.textIndex, props.vocabulary]);

  // Prepared once per change to the tree, and only while the palette is open.
  const folderList = useMemo(
    () => (props.open ? folderEntries(props.folders, props.folderPaths) : []),
    [props.open, props.folders, props.folderPaths],
  );

  const places = useMemo(() => {
    const entries: { id: string; label: string; icon: ReactNode; hint?: string; route: Route }[] = [];
    const match = (value: string) => !needle || value.toLowerCase().includes(needle);

    for (const scope of SCOPES) {
      if (match(scope.label)) {
        entries.push({
          id: `scope:${scope.scope}`,
          label: scope.label,
          icon: scope.icon,
          route: { kind: "scope", scope: scope.scope },
        });
      }
    }
    for (const collection of props.smart) {
      if (match(collection.name) && entries.length < 40) {
        entries.push({
          id: `smart:${collection.id}`,
          label: collection.name,
          hint: "Collection",
          icon: <Sparkles />,
          route: { kind: "smart", id: collection.id },
        });
      }
    }
    /*
      Folders by how well they match, not by where they happen to sit in the list: the folder
      called "Design" before the forty folders that live under it. Shown by name, with the
      path beside it, because eight levels of path leave no room for the name itself.
    */
    if (needle) {
      for (const entry of rankFolders(folderList, needle).matches.slice(0, GROUP_LIMIT)) {
        const parent = entry.path.endsWith(entry.folder.name)
          ? entry.path.slice(0, entry.path.length - entry.folder.name.length).replace(/ \/ $/, "")
          : "";
        entries.push({
          id: `folder:${entry.folder.id}`,
          label: entry.folder.name,
          hint: parent ? `in ${parent}` : "Folder",
          icon: <FolderIcon />,
          route: { kind: "folder", id: entry.folder.id },
        });
      }
    }
    for (const source of props.sources) {
      if (match(source.name) && entries.length < 70) {
        entries.push({
          id: `source:${source.id}`,
          label: source.name,
          hint: "Source",
          icon: <Inbox />,
          route: { kind: "source", id: source.id },
        });
      }
    }
    for (const [tag] of props.tags) {
      if (match(tag) && entries.length < 90) {
        entries.push({
          id: `tag:${tag}`,
          label: tag,
          hint: "Tag",
          icon: <Hash />,
          route: { kind: "tag", tag },
        });
      }
    }
    for (const board of props.boards) {
      if (match(board.name) && entries.length < 100) {
        entries.push({
          id: `board:${board.id}`,
          label: board.name,
          hint: "Board",
          icon: <LayoutGrid />,
          route: { kind: "board", id: board.id },
        });
      }
    }
    if (!needle) return entries.slice(0, GROUP_LIMIT);
    /*
      Best matches first across every kind of place. Taking the first six in the order the
      kinds are listed meant a tag or board with exactly the typed name could be pushed out
      by six folders that only contained it.
    */
    const rank = (label: string) => {
      const folded = label.toLowerCase();
      return folded === needle ? 0 : folded.startsWith(needle) ? 1 : 2;
    };
    return entries
      .map((entry, position) => ({ entry, position, rank: rank(entry.label) }))
      .sort((a, b) => a.rank - b.rank || a.position - b.position)
      .slice(0, GROUP_LIMIT + 2)
      .map((item) => item.entry);
  }, [needle, folderList, props.smart, props.sources, props.tags, props.boards]);

  const commands = useMemo(() => {
    if (!needle) return props.commands;
    return props.commands.filter(
      (command) =>
        command.label.toLowerCase().includes(needle) ||
        command.keywords?.toLowerCase().includes(needle),
    );
  }, [needle, props.commands]);

  const close = () => {
    props.onOpenChange(false);
    setQuery("");
  };

  const groups = ["Actions", "View", "Library"] as const;

  return (
    <CommandDialog
      open={props.open}
      onOpenChange={(next) => {
        props.onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search bookmarks, jump to a folder, run a command…"
      />
      <CommandList>
        {!results.length && !places.length && !commands.length ? (
          <CommandEmpty>Nothing matches “{query}”.</CommandEmpty>
        ) : null}

        {results.length ? (
          <CommandGroup heading="Bookmarks">
            {results.map((row) => (
              <CommandItem
                key={row.id}
                value={row.id}
                onSelect={() => {
                  close();
                  props.onOpenDetail(row);
                }}
              >
                <Favicon bookmark={row} size={16} />
                <span className="menu-label">
                  <span className="block truncate">{row.title}</span>
                  <span className="menu-desc truncate">
                    {row.domain}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label="Open in a new tab"
                  className="icon-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    close();
                    props.onOpenBookmark(row);
                  }}
                >
                  <ExternalLink size={15} />
                </button>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {places.length ? (
          <>
            {results.length ? <CommandSeparator /> : null}
            <CommandGroup heading="Go to">
              {places.map((place) => (
                <CommandItem
                  key={place.id}
                  value={place.id}
                  onSelect={() => {
                    close();
                    props.navigate(place.route);
                  }}
                >
                  {place.icon}
                  <span className="menu-label truncate">{place.label}</span>
                  {place.hint ? <CommandShortcut className="bs-palette-hint">{place.hint}</CommandShortcut> : null}
                  <ArrowRight size={14} className="text-text-3" />
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {groups.map((group) => {
          const inGroup = commands.filter((command) => command.group === group);
          if (!inGroup.length) return null;
          return (
            <CommandGroup key={group} heading={group}>
              {inGroup.map((command) => (
                <CommandItem
                  key={command.id}
                  value={command.id}
                  onSelect={() => {
                    close();
                    command.run();
                  }}
                >
                  {command.icon}
                  <span className="menu-label">{command.label}</span>
                  {command.shortcut ? <KeyChips keys={command.shortcut} className="menu-kbd" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}

const SCOPES: { scope: "all" | "recent" | "favorites" | "review" | "untagged" | "duplicates" | "archived" | "trash"; label: string; icon: ReactNode }[] = [
  { scope: "all", label: "All bookmarks", icon: <Library /> },
  { scope: "recent", label: "Recently added", icon: <Clock /> },
  { scope: "favorites", label: "Favourites", icon: <Heart /> },
  { scope: "review", label: "Needs review", icon: <TriangleAlert /> },
  { scope: "untagged", label: "Untagged", icon: <Hash /> },
  { scope: "duplicates", label: "Duplicates", icon: <Copy /> },
  { scope: "archived", label: "Archived", icon: <Archive /> },
  { scope: "trash", label: "Trash", icon: <Trash2 /> },
];

/** Icons the app shell reuses when building its command list. */
export const CommandIcons = {
  add: <Plus />,
  import: <Download />,
  export: <RefreshCw />,
  settings: <Settings />,
  grid: <LayoutGrid />,
  list: <List />,
  dark: <Moon />,
  light: <Sun />,
  dedupe: <Copy />,
  enrich: <Wand2 />,
  health: <Link2 />,
  capture: <RefreshCw />,
  trash: <Trash2 />,
  smart: <Sparkles />,
};
