/**
 * The navigation rail.
 *
 * ## The rail has to stay small however large the library gets
 *
 * A 50,000-bookmark library has thousands of distinct tags, hundreds of folders and
 * hundreds of domains. A rail that renders all of them is a rail that costs more to draw
 * than the grid beside it, and — worse — one nobody can find anything in.
 *
 * Two rules keep it bounded:
 *
 *   · **Every open-ended section shows the top N by count and nothing else.** Tags,
 *     folders and boards are ranked by how much is in them, because that is what makes a
 *     rail a way *in* rather than an inventory.
 *   · **Anything past N is reached by searching, not by scrolling.** A section with more
 *     than its allowance grows a filter box, and the command palette can reach any of them
 *     by name from anywhere.
 *
 * The folder tree is the exception and needs no cap: only expanded branches are rendered,
 * so its cost is proportional to what the user has actually opened.
 */
import {
  Archive,
  Boxes,
  ChevronRight,
  Clock,
  Copy,
  Folder as FolderIcon,
  FolderInput,
  Hash,
  Heart,
  Layers,
  Library as LibraryIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Tag as TagIcon,
  Trash2,
  TriangleAlert,
  Unlink,
} from "@/components/icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { Board, Folder, ImportBatch, SmartCollection } from "@shared/types";
import type { FacetCounts } from "@/lib/engine";
import type { SourceWithCount } from "@/lib/sources";
import type { Route } from "@/lib/router";
import { folderAncestors, folderChildren, folderTotals } from "@/lib/library";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/ui/tooltip";
import { FaviconPlate } from "./media";
import { cn, shortcut } from "@/lib/utils";
import { Logo } from "./logo";

/** How many rows an open-ended section shows before it grows a filter box. */
const SECTION_LIMIT = 12;
/** And how many it will show at most, even while filtering. */
const SECTION_MAX = 60;

export interface SidebarProps {
  route: Route;
  navigate: (route: Route) => void;
  facets: FacetCounts;
  folders: Folder[];
  folderPaths: Map<string, string>;
  boards: Board[];
  smart: SmartCollection[];
  smartCounts: Map<string, number>;
  sources: SourceWithCount[];
  imports: (ImportBatch & { liveCount: number })[];
  hydrating: boolean;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (folder: Folder) => void;
  onMoveFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onCreateBoard: () => void;
  onRenameBoard: (board: Board) => void;
  onDeleteBoard: (board: Board) => void;
  onEditSmart: (collection: SmartCollection) => void;
  onDeleteSmart: (collection: SmartCollection) => void;
  onRenameSource: (source: SourceWithCount) => void;
  onForgetSource: (source: SourceWithCount) => void;
  onRenameImport: (batch: ImportBatch) => void;
  onDeleteImport: (batch: ImportBatch) => void;
  /** Pinned below the scrolling sections: connection status and the import button. */
  footer?: ReactNode;
}

/* ------------------------------------------------------------------- atoms */

/** The number at the end of a row: tabular, tertiary, and out of the way of the row menu. */
function Count({ value, yields }: { value: number; yields?: boolean }) {
  if (!value) return null;
  return (
    <span className={cn("bs-nav-count tabular", yields && "yields")}>
      {value > 9999 ? `${Math.round(value / 1000)}k` : value.toLocaleString()}
    </span>
  );
}

/**
 * How far a nested row is pushed in.
 *
 * A full step per level for the first four, then a smaller one, then none. The rail is a
 * fixed width, and a full step at every level left a folder eight levels down with no room
 * for its own name.
 */
function rowIndent(depth: number): number {
  const full = Math.min(depth, 4);
  const half = Math.min(Math.max(depth - 4, 0), 6);
  return full * 14 + half * 7;
}

/** A sidebar row, drawn like a `.menu-item`: 32 px, ghost hover, selected on the 10 % fill. */
function Row({
  icon,
  label,
  count,
  active,
  onClick,
  indent = 0,
  accent,
  trailing,
  onContextMenu,
  expanded,
  onToggle,
  title,
}: {
  icon?: ReactNode;
  label: ReactNode;
  count?: number;
  active?: boolean;
  onClick: () => void;
  indent?: number;
  accent?: string;
  trailing?: ReactNode;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Set for a folder with subfolders: whether they are showing, and how to toggle them. */
  expanded?: boolean;
  onToggle?: () => void;
  /** Shown on hover: the whole path of a folder whose name is cut short or repeated. */
  title?: string;
}) {
  return (
    <div className={cn("bs-nav-row", active && "is-on")}>
      <button
        type="button"
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={title}
        style={{ paddingLeft: 8 + rowIndent(indent) }}
        className="bs-nav-button"
        aria-current={active ? "page" : undefined}
        aria-expanded={onToggle ? Boolean(expanded) : undefined}
        // A folder with subfolders opens and closes from the keyboard the way a tree does.
        onKeyDown={
          onToggle
            ? (event) => {
                if ((event.key === "ArrowRight" && !expanded) || (event.key === "ArrowLeft" && expanded)) {
                  event.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
      >
        {accent ? (
          <span className="bs-nav-dot" style={{ background: accent }} aria-hidden />
        ) : icon ? (
          <span className="bs-nav-icon">{icon}</span>
        ) : null}
        <span className="bs-nav-label">{label}</span>
        <Count value={count ?? 0} yields={Boolean(trailing)} />
      </button>
      {trailing ? <span className="bs-nav-trailing">{trailing}</span> : null}
    </div>
  );
}

function Section({
  title,
  children,
  action,
  defaultOpen = true,
  count,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bs-nav-section">
      <div className="bs-nav-heading">
        <button type="button" onClick={() => setOpen((value) => !value)} className="bs-nav-heading-button" aria-expanded={open}>
          <span className={cn("bs-nav-chevron", open && "is-open")}>
            <ChevronRight size={12} />
          </span>
          {title}
          {count ? <span className="bs-nav-heading-count tabular">{count.toLocaleString()}</span> : null}
        </button>
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {open ? <div className="bs-nav-rows">{children}</div> : null}
    </div>
  );
}

/** A filter box that only appears once a section is bigger than a glance. */
function SectionFilter({
  value,
  onChange,
  placeholder,
  visible,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  visible: boolean;
}) {
  if (!visible) return null;
  return (
    <div className="file-search bs-nav-filter">
      <Search size={14} />
      <input type="search" className="input" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  );
}

function RowMenu({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="icon-btn bs-nav-more" aria-label="More">
          <MoreHorizontal size={15} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="bs-nav-empty">{children}</p>;
}

/** A small ghost "+" beside a section heading. */
function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Hint label={label}>
      <button type="button" className="icon-btn bs-nav-add" onClick={onClick} aria-label={label}>
        <Plus size={14} />
      </button>
    </Hint>
  );
}

/* ------------------------------------------------------------------ folders */

function FolderTree({
  folders,
  folderPaths,
  counts,
  route,
  navigate,
  onCreateFolder,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
}: {
  folders: Folder[];
  folderPaths: Map<string, string>;
  counts: Map<string, number>;
  route: Route;
  navigate: (route: Route) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (folder: Folder) => void;
  onMoveFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const children = useMemo(() => folderChildren(folders), [folders]);

  /**
   * Totals that include everything nested underneath.
   *
   * A folder showing "0" while its subfolders hold four hundred rows is the single most
   * confusing thing a tree can do. Computed once per counts map in one walk rather than by
   * summing a subtree per row, which would be quadratic on a deep tree.
   */
  const totals = useMemo(() => folderTotals(folders, counts), [folders, counts]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return null;
    return folders
      .filter((folder) => folder.name.toLowerCase().includes(needle))
      .sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0))
      .slice(0, SECTION_MAX);
  }, [filter, folders, totals]);

  const activeId = route.kind === "folder" ? route.id : null;
  const treeLoaded = folders.length > 0;

  /*
    Open the tree down to wherever the person is. A folder reached from search, the command
    palette, a bookmark's detail panel or a reload used to leave the tree closed, so in a
    library nested several levels deep nothing showed where they were. Only when the place
    changes: folders they have since closed stay closed.
  */
  useEffect(() => {
    if (!activeId) return;
    const ancestors = folderAncestors(folders, activeId);
    if (!ancestors.length) return;
    setExpanded((current) => {
      if (ancestors.every((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of ancestors) next.add(id);
      return next;
    });
    // After a reload the place is known before the folders are, hence `treeLoaded`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the place, not every folder edit
  }, [activeId, treeLoaded]);

  const menuFor = (folder: Folder) => (
    <RowMenu>
      <DropdownMenuItem onSelect={() => onCreateFolder(folder.id)}>
        <Plus /> New subfolder
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onRenameFolder(folder)}>
        <Pencil /> Rename
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onMoveFolder(folder)}>
        <FolderInput /> Move to…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={() => onDeleteFolder(folder)}>
        <Trash2 /> Delete folder
      </DropdownMenuItem>
    </RowMenu>
  );

  if (filtered) {
    return (
      <>
        <SectionFilter value={filter} onChange={setFilter} placeholder="Find a folder" visible />
        {filtered.length ? (
          filtered.map((folder) => (
            <Row
              key={folder.id}
              icon={<FolderIcon />}
              label={folder.name}
              // Several folders can share a name at different depths; the path tells them apart.
              title={folderPaths.get(folder.id)}
              count={totals.get(folder.id) ?? 0}
              active={activeId === folder.id}
              onClick={() => navigate({ kind: "folder", id: folder.id })}
              trailing={menuFor(folder)}
            />
          ))
        ) : (
          <Empty>No folder matches.</Empty>
        )}
      </>
    );
  }

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const render = (parentId: string | null, depth: number): ReactNode[] => {
    // Already in display order: `folderChildren` sorts each list once per version of the tree.
    const list = children.get(parentId) ?? [];
    return list.flatMap((folder) => {
      const kids = children.get(folder.id) ?? [];
      const isOpen = expanded.has(folder.id);
      const rows: ReactNode[] = [
        <Row
          key={folder.id}
          indent={depth}
          icon={
            kids.length ? (
              // A pointer shortcut only. Keyboard and screen-reader users open the folder
              // with the arrow keys on the row itself, which carries aria-expanded; a
              // second control nested inside the row's button would be unreachable for them.
              <span
                aria-hidden="true"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(folder.id);
                }}
                className={cn("bs-nav-chevron bs-nav-twist", isOpen && "is-open")}
              >
                <ChevronRight size={12} />
              </span>
            ) : (
              <FolderIcon />
            )
          }
          label={folder.name}
          title={depth > 0 ? folderPaths.get(folder.id) : undefined}
          count={totals.get(folder.id) ?? 0}
          active={activeId === folder.id}
          onClick={() => navigate({ kind: "folder", id: folder.id })}
          trailing={menuFor(folder)}
          expanded={kids.length ? isOpen : undefined}
          onToggle={kids.length ? () => toggle(folder.id) : undefined}
        />,
      ];
      if (isOpen && kids.length) rows.push(...render(folder.id, depth + 1));
      return rows;
    });
  };

  const roots = children.get(null) ?? [];
  return (
    <>
      <SectionFilter
        value={filter}
        onChange={setFilter}
        placeholder="Find a folder"
        visible={folders.length > SECTION_LIMIT}
      />
      {roots.length ? (
        render(null, 0)
      ) : (
        <Empty>Folders arrive with an import, or make one with +.</Empty>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ sidebar */

export function AppSidebar(props: SidebarProps) {
  const { route, navigate, facets } = props;
  const [tagFilter, setTagFilter] = useState("");

  const isScope = (scope: string) => route.kind === "scope" && route.scope === scope;

  /**
   * Tags, ranked by how much carries them.
   *
   * The alphabet is the wrong order for a rail: it puts "aaa-test" above "design", and the
   * question a rail answers is "where is most of my stuff", not "what letters exist".
   */
  const tags = useMemo(() => {
    const needle = tagFilter.trim().toLowerCase();
    const entries = [...facets.tags.entries()];
    const matching = needle ? entries.filter(([tag]) => tag.includes(needle)) : entries;
    return matching
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, needle ? SECTION_MAX : SECTION_LIMIT);
  }, [facets.tags, tagFilter]);

  return (
    <nav aria-label="Library" className="bs-nav">
      <div className="bs-nav-brand">
        <Logo size={22} />
        <span className="bs-nav-brand-name">Bookmark Studio</span>
      </div>
      <div className="bs-nav-scroll">
      <Section title="Library">
        <Row
          icon={<LibraryIcon />}
          label="All bookmarks"
          count={facets.live}
          active={isScope("all")}
          onClick={() => navigate({ kind: "scope", scope: "all" })}
        />
        <Row
          icon={<Clock />}
          label="Recently added"
          count={facets.recent}
          active={isScope("recent")}
          onClick={() => navigate({ kind: "scope", scope: "recent" })}
        />
        <Row
          icon={<Heart />}
          label="Favourites"
          count={facets.favorites}
          active={isScope("favorites")}
          onClick={() => navigate({ kind: "scope", scope: "favorites" })}
        />
        <Row
          icon={<TriangleAlert />}
          label="Needs review"
          count={facets.needsReview}
          active={isScope("review")}
          onClick={() => navigate({ kind: "scope", scope: "review" })}
        />
        <Row
          icon={<TagIcon />}
          label="Untagged"
          count={facets.untagged}
          active={isScope("untagged")}
          onClick={() => navigate({ kind: "scope", scope: "untagged" })}
        />
        <Row
          icon={<Copy />}
          label="Duplicates"
          count={facets.duplicates}
          active={isScope("duplicates")}
          onClick={() => navigate({ kind: "scope", scope: "duplicates" })}
        />
        <Row
          icon={<Archive />}
          label="Archived"
          count={facets.archived}
          active={isScope("archived")}
          onClick={() => navigate({ kind: "scope", scope: "archived" })}
        />
        <Row
          icon={<Trash2 />}
          label="Trash"
          count={facets.trashed}
          active={isScope("trash")}
          onClick={() => navigate({ kind: "scope", scope: "trash" })}
        />
      </Section>

      {props.smart.length ? (
        <Section title="Collections" count={props.smart.length}>
          {props.smart.map((collection) => (
            <Row
              key={collection.id}
              accent={collection.color}
              label={collection.name}
              count={props.smartCounts.get(collection.id) ?? 0}
              active={route.kind === "smart" && route.id === collection.id}
              onClick={() => navigate({ kind: "smart", id: collection.id })}
              trailing={
                <RowMenu>
                  <DropdownMenuItem onSelect={() => props.onEditSmart(collection)}>
                    <Pencil /> Edit rule
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => props.onDeleteSmart(collection)}
                  >
                    <Trash2 /> Delete collection
                  </DropdownMenuItem>
                </RowMenu>
              }
            />
          ))}
        </Section>
      ) : null}

      {props.sources.length ? (
        <Section title="Sources" count={props.sources.length}>
          {props.sources.map((source) => (
            <Row
              key={source.id}
              icon={<FaviconPlate label={source.name} size={16} />}
              label={source.name}
              count={source.count}
              active={route.kind === "source" && route.id === source.id}
              onClick={() => navigate({ kind: "source", id: source.id })}
              trailing={
                <RowMenu>
                  <DropdownMenuItem onSelect={() => props.onRenameSource(source)}>
                    <Pencil /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => props.onForgetSource(source)}>
                    <Unlink /> Forget source
                  </DropdownMenuItem>
                </RowMenu>
              }
            />
          ))}
        </Section>
      ) : null}

      <Section
        title="Folders"
        count={props.folders.length}
        action={<AddButton label="New folder" onClick={() => props.onCreateFolder(null)} />}
      >
        <FolderTree
          folders={props.folders}
          folderPaths={props.folderPaths}
          counts={facets.folders}
          route={route}
          navigate={navigate}
          onCreateFolder={props.onCreateFolder}
          onRenameFolder={props.onRenameFolder}
          onMoveFolder={props.onMoveFolder}
          onDeleteFolder={props.onDeleteFolder}
        />
      </Section>

      <Section
        title="Boards"
        count={props.boards.length}
        defaultOpen={props.boards.length > 0}
        action={<AddButton label="New board" onClick={props.onCreateBoard} />}
      >
        {props.boards.length ? (
          props.boards.map((board) => (
            <Row
              key={board.id}
              accent={board.color}
              label={board.name}
              count={facets.boards.get(board.id) ?? 0}
              active={route.kind === "board" && route.id === board.id}
              onClick={() => navigate({ kind: "board", id: board.id })}
              trailing={
                <RowMenu>
                  <DropdownMenuItem onSelect={() => props.onRenameBoard(board)}>
                    <Pencil /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => props.onDeleteBoard(board)}>
                    <Trash2 /> Delete board
                  </DropdownMenuItem>
                </RowMenu>
              }
            />
          ))
        ) : (
          <Empty>Boards group bookmarks across folders.</Empty>
        )}
      </Section>

      <Section title="Tags" count={facets.tags.size} defaultOpen={facets.tags.size > 0}>
        <SectionFilter
          value={tagFilter}
          onChange={setTagFilter}
          placeholder="Find a tag"
          visible={facets.tags.size > SECTION_LIMIT}
        />
        {tags.length ? (
          tags.map(([tag, count]) => (
            <Row
              key={tag}
              icon={<Hash />}
              label={tag}
              count={count}
              active={route.kind === "tag" && route.tag === tag}
              onClick={() => navigate({ kind: "tag", tag })}
            />
          ))
        ) : (
          <Empty>{facets.tags.size ? "No tag matches." : "Tags appear as you add them, or as pages are read."}</Empty>
        )}
        {!tagFilter && facets.tags.size > SECTION_LIMIT ? (
          <Empty>
            {(facets.tags.size - tags.length).toLocaleString()} more — search above, or press {shortcut("mod+K")}.
          </Empty>
        ) : null}
      </Section>

      {props.imports.length ? (
        <Section title="Imports" count={props.imports.length} defaultOpen={false}>
          {props.imports.map((batch) => (
            <Row
              key={batch.id}
              icon={<Layers />}
              label={batch.name}
              count={batch.liveCount}
              active={route.kind === "import" && route.id === batch.id}
              onClick={() => navigate({ kind: "import", id: batch.id })}
              trailing={
                <RowMenu>
                  <DropdownMenuItem onSelect={() => props.onRenameImport(batch)}>
                    <Pencil /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => props.onDeleteImport(batch)}
                  >
                    <Trash2 /> Remove this import
                  </DropdownMenuItem>
                </RowMenu>
              }
            />
          ))}
        </Section>
      ) : null}

      {facets.categories.size ? (
        <Section title="Topics" count={facets.categories.size} defaultOpen={false}>
          {[...facets.categories.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, SECTION_LIMIT)
            .map(([name, count]) => (
              <Row
                key={name}
                icon={<Boxes />}
                label={name}
                count={count}
                active={route.kind === "category" && route.name === name}
                onClick={() => navigate({ kind: "category", name })}
              />
            ))}
        </Section>
      ) : null}

      {props.hydrating ? <Empty>Counts are still settling…</Empty> : null}
      </div>
      {props.footer ? <div className="bs-nav-footer">{props.footer}</div> : null}
    </nav>
  );
}
