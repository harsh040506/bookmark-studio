/**
 * The bars above the results.
 *
 * Row one is the design system's toolbar: 44 px, the paper colour, a hairline below, ghost
 * 30 px buttons with tooltips, and exactly one raised action (Add). Secondary actions live
 * in the "More" menu so nothing is lost on a phone.
 *
 * Row two is the page heading: where you are, in the serif, with the result count, and the
 * controls that change how the results are shown — format, filters, sort, pictures, layout.
 *
 * ## Search is debounced elsewhere
 *
 * The input here is instant; the *query* it produces is debounced in the app shell, so
 * typing never waits on a selection pass and a selection pass never runs per character.
 */
import { useEffect, useRef, type ReactNode } from "react";

import type { FormatFacet, SortMode, ViewMode } from "@shared/types";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Close,
  Command as CommandIcon,
  Export,
  Filter,
  Grid,
  ImageIcon,
  ImageOff,
  Import,
  Keyboard,
  List,
  Menu,
  Monitor,
  Moon,
  More,
  Plus,
  Redo,
  Search,
  Settings,
  Sort,
  Sun,
  Undo,
} from "@/components/icons";
import { Checkbox, ToggleGroup, ToggleGroupItem } from "@/components/ui/controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Hint, KeyChips } from "@/components/ui/tooltip";
import type { ThemePreference } from "@/hooks/useTheme";
import type { QueryFilters } from "@/lib/query";
import { cn } from "@/lib/utils";

const SORTS: { value: SortMode; label: string }[] = [
  { value: "recent", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "relevance", label: "Best match" },
  { value: "title", label: "Title A–Z" },
  { value: "domain", label: "By site" },
  { value: "visits", label: "Most opened" },
  { value: "custom", label: "As imported" },
];

const FORMATS: { value: FormatFacet; label: string }[] = [
  { value: "all", label: "All" },
  { value: "links", label: "Links" },
  { value: "images", label: "Images" },
  { value: "videos", label: "Videos" },
  { value: "notes", label: "Notes" },
];

/** One folder above the place being shown. */
export interface Crumb {
  id: string;
  label: string;
}

/**
 * The folders above the current one, as a row of ways back up.
 *
 * Eight levels of names do not fit on a line, so the middle is folded away: the top of the
 * tree and the two nearest parents are the ones people navigate by.
 */
function Crumbs({ crumbs, onCrumb }: { crumbs: Crumb[]; onCrumb: (id: string | null) => void }) {
  const folded = crumbs.length > 4;
  const shown = folded ? [crumbs[0], ...crumbs.slice(-2)] : crumbs;
  const hidden = folded ? crumbs.slice(1, -2) : [];
  return (
    <nav aria-label="Folder path" className="contents">
      <ol className="bs-crumbs">
        <li>
          <button type="button" className="bs-crumb" onClick={() => onCrumb(null)}>
            All bookmarks
          </button>
        </li>
        {shown.map((crumb, position) => (
          <li key={crumb.id}>
            <ChevronRight size={12} aria-hidden />
            {folded && position === 1 ? (
              <>
                <span className="bs-crumb-gap" title={hidden.map((entry) => entry.label).join(" / ")}>
                  <span aria-hidden>…</span>
                  <span className="sr-only">
                    {hidden.length} more folder{hidden.length === 1 ? "" : "s"}
                  </span>
                </span>
                <ChevronRight size={12} aria-hidden />
              </>
            ) : null}
            <button type="button" className="bs-crumb" title={crumb.label} onClick={() => onCrumb(crumb.id)}>
              {crumb.label}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export interface TopbarProps {
  title: string;
  /** The whole path of a nested place, shown when the heading is hovered. */
  titleHint?: string;
  /** The folders above the current one, top first. Empty anywhere that is not nested. */
  crumbs?: Crumb[];
  /** Go to a folder from the path, or to everything with `null`. */
  onCrumb?: (id: string | null) => void;
  /** Shown beside the result count: background progress, connection state. */
  status?: ReactNode;
  total: number;
  hydrating?: boolean;
  /** The library is empty (the welcome screen is showing): no heading or view controls. */
  libraryEmpty?: boolean;
  search: string;
  onSearch: (value: string) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  sort: SortMode;
  onSort: (sort: SortMode) => void;
  format: FormatFacet;
  onFormat: (format: FormatFacet) => void;
  showImages: boolean;
  onShowImages: (value: boolean) => void;
  filters: QueryFilters;
  quickFilters: QuickFilterState;
  onQuickFilter: (patch: Partial<QuickFilterState>) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAdd: () => void;
  onImport: () => void;
  onExport: () => void;
  onSettings: () => void;
  onShortcuts: () => void;
  onOpenPalette: () => void;
  onToggleSidebar: () => void;
  theme: "light" | "dark";
  themePreference: ThemePreference;
  onThemePreference: (preference: ThemePreference) => void;
  corrections?: { from: string; to: string }[];
  chips: { label: string }[];
  onClearQuery: () => void;
}

/**
 * The filters that have a checkbox rather than a word in the query.
 *
 * They compile *into* the query string, so there is exactly one filter model: a checkbox and
 * `is:dead` typed by hand are the same thing by the time the engine sees them.
 */
export interface QuickFilterState {
  favorite: boolean;
  untagged: boolean;
  neverVisited: boolean;
  offline: boolean;
  duplicates: boolean;
  dead: boolean;
  unchecked: boolean;
}

export const EMPTY_QUICK_FILTERS: QuickFilterState = {
  favorite: false,
  untagged: false,
  neverVisited: false,
  offline: false,
  duplicates: false,
  dead: false,
  unchecked: false,
};

const QUICK_FILTER_LABELS: { key: keyof QuickFilterState; label: string; hint: string }[] = [
  { key: "favorite", label: "Favourites", hint: "Only starred bookmarks" },
  { key: "untagged", label: "Untagged", hint: "Nothing filed on these yet" },
  { key: "neverVisited", label: "Never opened", hint: "Saved but never clicked from here" },
  { key: "duplicates", label: "Duplicates", hint: "Shares a link with another row" },
  { key: "dead", label: "Broken links", hint: "Did not respond when last checked" },
  { key: "unchecked", label: "Unchecked", hint: "Never health-checked" },
  { key: "offline", label: "Saved offline", hint: "Has a self-contained offline copy" },
];

/** How many quick filters are on, for the count on the Filters button. */
export function activeQuickFilters(state: QuickFilterState): number {
  return Object.values(state).filter(Boolean).length;
}

export function AppTopbar(props: TopbarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;

  /* `/` focuses the search box, unless something is already taking typing. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (event.key === "Escape" && document.activeElement === inputRef.current) {
        if (latest.current.search) latest.current.onClearQuery();
        else inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filterCount = activeQuickFilters(props.quickFilters);
  const sortLabel = SORTS.find((entry) => entry.value === props.sort)?.label ?? "Sort";

  return (
    <div className="bs-topbar">
      {/* ------------------------------------------------------------ toolbar */}
      <header className="toolbar">
        <div className="tb-group">
          <Hint label="Show navigation">
            <button type="button" className="tb-btn bs-nav-toggle" onClick={props.onToggleSidebar} aria-label="Show navigation">
              <Menu />
            </button>
          </Hint>
        </div>

        <div className="bs-search">
          <div className="file-search">
            <Search />
            <input
              ref={inputRef}
              type="search"
              className="input"
              value={props.search}
              onChange={(event) => props.onSearch(event.target.value)}
              placeholder="Search titles, pages, tags…"
              aria-label="Search the library"
              autoComplete="off"
              spellCheck={false}
            />
            {props.search ? (
              <button type="button" className="icon-btn bs-search-clear" onClick={props.onClearQuery} aria-label="Clear search">
                <Close size={14} />
              </button>
            ) : (
              <span className="kbd bs-search-kbd" aria-hidden>
                <kbd>/</kbd>
              </span>
            )}
          </div>
        </div>

        <div className="tb-spacer" />

        <div className="tb-group">
          <Hint label="Undo" keys="mod+Z">
            <button type="button" className="tb-btn tb-extra" disabled={!props.canUndo} onClick={props.onUndo} aria-label="Undo">
              <Undo />
            </button>
          </Hint>
          <Hint label="Redo" keys="mod+shift+Z">
            <button type="button" className="tb-btn tb-extra" disabled={!props.canRedo} onClick={props.onRedo} aria-label="Redo">
              <Redo />
            </button>
          </Hint>
          <span className="tb-sep" />
          <Hint label="Search and commands" keys="mod+K">
            <button type="button" className="tb-btn tb-extra" onClick={props.onOpenPalette} aria-label="Search and commands">
              <CommandIcon />
            </button>
          </Hint>

          <DropdownMenu>
            <Hint label="Add a link, upload files or import bookmarks">
              <DropdownMenuTrigger asChild>
                <button type="button" className="tb-btn has-label has-caret tb-export" aria-label="Add">
                  <Plus />
                  <span>Add</span>
                  <span className="tb-caret">
                    <ChevronDown size={12} />
                  </span>
                </button>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="w-[250px]">
              <DropdownMenuItem onSelect={props.onAdd}>
                <Plus /> <span className="menu-label">Add a link…</span>
                <DropdownMenuShortcut>
                  <KeyChips keys="N" className="menu-kbd" />
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={props.onImport}>
                <Import /> <span className="menu-label">Import bookmarks…</span>
                <DropdownMenuShortcut>
                  <KeyChips keys="I" className="menu-kbd" />
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={props.onExport}>
                <Export /> <span className="menu-label">Export or back up…</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <Hint label="Theme">
              <DropdownMenuTrigger asChild>
                <button type="button" className="tb-btn" aria-label="Theme">
                  {props.theme === "dark" ? <Moon /> : <Sun />}
                </button>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="w-[190px]">
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={props.themePreference}
                onValueChange={(value) => props.onThemePreference(value as ThemePreference)}
              >
                <DropdownMenuRadioItem value="system">
                  <Monitor /> System
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light">
                  <Sun /> Light
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  <Moon /> Dark
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <Hint label="More">
              <DropdownMenuTrigger asChild>
                <button type="button" className="tb-btn" aria-label="More">
                  <More />
                </button>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="w-[240px]">
              <DropdownMenuItem onSelect={props.onOpenPalette}>
                <CommandIcon /> <span className="menu-label">Search and commands</span>
                <DropdownMenuShortcut>
                  <KeyChips keys="mod+K" className="menu-kbd" />
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!props.canUndo} onSelect={props.onUndo}>
                <Undo /> <span className="menu-label">Undo</span>
                <DropdownMenuShortcut>
                  <KeyChips keys="mod+Z" className="menu-kbd" />
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!props.canRedo} onSelect={props.onRedo}>
                <Redo /> <span className="menu-label">Redo</span>
                <DropdownMenuShortcut>
                  <KeyChips keys="mod+shift+Z" className="menu-kbd" />
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={props.onShortcuts}>
                <Keyboard /> <span className="menu-label">Keyboard shortcuts</span>
                <DropdownMenuShortcut>
                  <KeyChips keys="?" className="menu-kbd" />
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={props.onSettings}>
                <Settings /> <span className="menu-label">Settings…</span>
                <DropdownMenuShortcut>
                  <KeyChips keys="mod+," className="menu-kbd" />
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* -------------------------------------------------------- page heading */}
      <div className="bs-pagehead" hidden={props.libraryEmpty}>
        {props.crumbs?.length && props.onCrumb ? <Crumbs crumbs={props.crumbs} onCrumb={props.onCrumb} /> : null}
        <div className="bs-pagehead-title">
          <h1 key={props.title} title={props.titleHint ?? props.title}>
            {props.title}
          </h1>
          <span className="bs-pagehead-meta tabular" role="status" aria-live="polite">
            {props.total.toLocaleString()} {props.total === 1 ? "item" : "items"}
            {props.hydrating ? " · loading…" : ""}
            {props.status ? <> · {props.status}</> : null}
          </span>
        </div>

        <div className="bs-pagehead-controls">
          <ToggleGroup
            type="single"
            size="sm"
            value={props.format}
            onValueChange={(value) => value && props.onFormat(value as FormatFacet)}
            aria-label="Format"
          >
            {FORMATS.map((entry) => (
              <ToggleGroupItem key={entry.value} value={entry.value}>
                {entry.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className={cn("tb-btn has-label", filterCount > 0 && "is-on")}>
                <Filter />
                <span>Filters</span>
                {filterCount ? <span className="bs-count">{filterCount}</span> : null}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[270px] p-1.5">
              <div className="menu-header">Narrow the results</div>
              <div className="flex flex-col">
                {QUICK_FILTER_LABELS.map((entry) => (
                  <label key={entry.key} className="menu-item bs-filter-row">
                    <Checkbox
                      checked={props.quickFilters[entry.key]}
                      onCheckedChange={(checked) => props.onQuickFilter({ [entry.key]: checked === true })}
                    />
                    <span className="menu-label">
                      {entry.label}
                      <span className="menu-desc">{entry.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {filterCount ? (
                <>
                  <div className="menu-sep" />
                  <button type="button" className="menu-item" onClick={() => props.onQuickFilter(EMPTY_QUICK_FILTERS)}>
                    <span className="menu-icon">
                      <Close />
                    </span>
                    <span className="menu-label">Clear filters</span>
                  </button>
                </>
              ) : null}
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="tb-btn has-label has-caret">
                <Sort />
                <span>{sortLabel}</span>
                <span className="tb-caret">
                  <ChevronDown size={12} />
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[200px]">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={props.sort} onValueChange={(value) => props.onSort(value as SortMode)}>
                {SORTS.map((entry) => (
                  <DropdownMenuRadioItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="tb-spacer" />

          <Hint label={props.showImages ? "Hide pictures (faster)" : "Show pictures"}>
            <button
              type="button"
              className={cn("tb-btn", props.showImages && "is-on")}
              aria-label="Show pictures"
              aria-pressed={props.showImages}
              onClick={() => props.onShowImages(!props.showImages)}
            >
              {props.showImages ? <ImageIcon /> : <ImageOff />}
            </button>
          </Hint>

          <ToggleGroup
            type="single"
            size="sm"
            value={props.view}
            onValueChange={(value) => value && props.onView(value as ViewMode)}
            aria-label="Layout"
          >
            <Hint label="Grid" keys="1">
              <ToggleGroupItem value="gallery" aria-label="Grid">
                <Grid />
              </ToggleGroupItem>
            </Hint>
            <Hint label="Masonry" keys="2">
              <ToggleGroupItem value="moodboard" aria-label="Masonry">
                <ImageIcon />
              </ToggleGroupItem>
            </Hint>
            <Hint label="List" keys="3">
              <ToggleGroupItem value="list" aria-label="List">
                <List />
              </ToggleGroupItem>
            </Hint>
          </ToggleGroup>
        </div>
      </div>

      {/* ------------------------------------------------- what was understood */}
      {props.chips.length || props.corrections?.length ? (
        <div className="bs-understood">
          {props.corrections?.length ? (
            <span className="text-hint text-text-3">
              Showing results for{" "}
              <span className="text-text font-medium">{props.corrections.map((entry) => entry.to).join(" ")}</span>
              {" · "}
              <s>{props.corrections.map((entry) => entry.from).join(" ")}</s>
            </span>
          ) : null}
          {props.chips.map((chip) => (
            <span key={chip.label} className="bs-badge is-accent">
              <Check />
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
