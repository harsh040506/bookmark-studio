/**
 * One description of what you can do to a bookmark, rendered into two menus.
 *
 * ## Why the actions are data
 *
 * The same eleven actions are reachable from the card's ⋯ button, from a right-click, from
 * the detail panel and from the keyboard. Writing them out per surface is how a right-click
 * menu ends up missing "Save offline" for six months without anybody noticing, and how the
 * shortcut printed beside an item stops matching the shortcut that is actually bound.
 *
 * So the actions are a list of {@link ActionSpec}, and each surface renders that list with
 * its own primitives. Adding an action is one entry; it appears everywhere at once, with
 * the same label, the same icon and the same shortcut.
 *
 * ## Nested menus, and where they stop
 *
 * "Move to folder" and "Add to board" are genuinely hierarchical, so they are submenus. But
 * a library can have five hundred folders, and a submenu with five hundred rows is not a
 * menu — it is a list nobody can use. The submenu therefore offers the handful most
 * recently used plus "Choose folder…", which opens a searchable picker. That is the shape
 * that stays usable whether there are four folders or four thousand.
 */
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  ExternalLink,
  FolderInput,
  Heart,
  ImageDown,
  LayoutGrid,
  Link2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Tag,
  Trash2,
  WifiOff,
} from "@/components/icons";
import type { ReactNode } from "react";

import type { Board, Bookmark, Folder } from "@shared/types";
import { hasPage } from "@shared/types";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { KeyChips } from "@/components/ui/tooltip";
import { shortcut } from "@/lib/utils";

/** Everything a surface needs to be able to do to one or more rows. */
export interface ItemActions {
  open: (bookmark: Bookmark) => void;
  copyLink: (bookmark: Bookmark) => void;
  edit: (bookmark: Bookmark) => void;
  toggleFavorite: (ids: string[], next: boolean) => void;
  setArchived: (ids: string[], next: boolean) => void;
  trash: (ids: string[]) => void;
  restore: (ids: string[]) => void;
  deleteForever: (ids: string[]) => void;
  moveToFolder: (ids: string[], folderId: string | null) => void;
  chooseFolder: (ids: string[]) => void;
  setBoard: (ids: string[], boardId: string, member: boolean) => void;
  addTag: (ids: string[]) => void;
  refreshShot: (bookmark: Bookmark) => void;
  saveOffline: (bookmark: Bookmark) => void;
  openOffline: (bookmark: Bookmark) => void;
  showSimilar: (bookmark: Bookmark) => void;
}

export interface ActionContext {
  /** The rows the action applies to. One for a card menu, many for a selection. */
  targets: Bookmark[];
  actions: ItemActions;
  folders: Folder[];
  boards: Board[];
  folderPaths: Map<string, string>;
  /** True in the Trash view, where the whole menu is different. */
  inTrash?: boolean;
}

interface ActionSpec {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  destructive?: boolean;
  run: () => void;
}

interface SubmenuSpec {
  id: string;
  label: string;
  icon: ReactNode;
  /** Rendered inside the submenu. */
  items: { id: string; label: string; icon?: ReactNode; checked?: boolean; run: () => void }[];
}

type Entry = ActionSpec | SubmenuSpec | { id: string; separator: true } | { id: string; heading: string };

function isSubmenu(entry: Entry): entry is SubmenuSpec {
  return "items" in entry;
}
function isSeparator(entry: Entry): entry is { id: string; separator: true } {
  return "separator" in entry;
}
function isHeading(entry: Entry): entry is { id: string; heading: string } {
  return "heading" in entry;
}

/**
 * How many folders the submenu offers before deferring to the picker.
 *
 * Eight is about what fits without the menu needing its own scrollbar, which is the point
 * at which a submenu stops being faster than a search box.
 */
const INLINE_FOLDERS = 8;

export function buildActions(context: ActionContext): Entry[] {
  const { targets, actions, folders, boards, folderPaths, inTrash } = context;
  if (!targets.length) return [];

  const ids = targets.map((row) => row.id);
  const single = targets.length === 1 ? targets[0] : null;
  const many = targets.length > 1;
  const suffix = many ? ` (${targets.length})` : "";

  if (inTrash) {
    return [
      {
        id: "restore",
        label: `Put back${suffix}`,
        icon: <RotateCcw />,
        run: () => actions.restore(ids),
      },
      { id: "sep", separator: true },
      {
        id: "delete",
        label: `Delete forever${suffix}`,
        icon: <Trash2 />,
        destructive: true,
        run: () => actions.deleteForever(ids),
      },
    ];
  }

  const allFavorite = targets.every((row) => row.favorite);
  const allArchived = targets.every((row) => row.archived);
  const openable = single && hasPage(single);

  /*
   * Folders offered inline, deepest-path-last.
   *
   * Sorted by path so siblings sit together, and truncated — the picker below handles the
   * rest. `null` is offered explicitly because "no folder" is a destination, not the
   * absence of one, and there is otherwise no way to get a row back out of a folder.
   */
  const inlineFolders = folders
    .slice()
    .sort((a, b) => (folderPaths.get(a.id) ?? "").localeCompare(folderPaths.get(b.id) ?? ""))
    .slice(0, INLINE_FOLDERS);

  const entries: Entry[] = [];

  if (openable) {
    entries.push({
      id: "open",
      label: "Open",
      icon: <ExternalLink />,
      shortcut: shortcut("enter"),
      run: () => actions.open(single),
    });
    entries.push({
      id: "copy",
      label: "Copy link",
      icon: <Link2 />,
      shortcut: shortcut("mod+C"),
      run: () => actions.copyLink(single),
    });
  }
  if (single) {
    entries.push({
      id: "edit",
      label: "Edit…",
      icon: <Pencil />,
      shortcut: "E",
      run: () => actions.edit(single),
    });
  }

  if (entries.length) entries.push({ id: "sep-1", separator: true });

  entries.push({
    id: "favorite",
    label: allFavorite ? `Remove from favourites${suffix}` : `Add to favourites${suffix}`,
    icon: allFavorite ? <Heart className="bs-fav" /> : <Heart />,
    shortcut: "F",
    run: () => actions.toggleFavorite(ids, !allFavorite),
  });

  entries.push({
    id: "tag",
    label: `Add tag…${suffix}`,
    icon: <Tag />,
    shortcut: "T",
    run: () => actions.addTag(ids),
  });

  entries.push({
    id: "move",
    label: "Move to folder",
    icon: <FolderInput />,
    items: [
      ...inlineFolders.map((folder) => ({
        id: folder.id,
        label: folderPaths.get(folder.id) ?? folder.name,
        checked: targets.every((row) => row.folderId === folder.id),
        run: () => actions.moveToFolder(ids, folder.id),
      })),
      {
        id: "none",
        label: "No folder",
        checked: targets.every((row) => row.folderId === null),
        run: () => actions.moveToFolder(ids, null),
      },
      {
        id: "choose",
        label: folders.length > INLINE_FOLDERS ? `Choose folder… (${folders.length})` : "Choose folder…",
        run: () => actions.chooseFolder(ids),
      },
    ],
  });

  if (boards.length) {
    entries.push({
      id: "boards",
      label: "Add to board",
      icon: <LayoutGrid />,
      items: boards.map((board) => {
        const member = targets.every((row) => row.boardIds.includes(board.id));
        return {
          id: board.id,
          label: board.name,
          checked: member,
          icon: (
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: board.color }}
              aria-hidden
            />
          ),
          run: () => actions.setBoard(ids, board.id, !member),
        };
      }),
    });
  }

  entries.push({ id: "sep-2", separator: true });

  if (single && hasPage(single)) {
    entries.push({
      id: "shot",
      label: "Refresh preview",
      icon: <RefreshCw />,
      run: () => actions.refreshShot(single),
    });
    entries.push(
      single.offline?.assetKey
        ? {
            id: "open-offline",
            label: "Open offline copy",
            icon: <WifiOff />,
            run: () => actions.openOffline(single),
          }
        : {
            id: "save-offline",
            label: "Save offline copy",
            icon: <ImageDown />,
            run: () => actions.saveOffline(single),
          },
    );
  }
  if (single?.visual?.phash) {
    entries.push({
      id: "similar",
      label: "Find look-alikes",
      icon: <Copy />,
      run: () => actions.showSimilar(single),
    });
  }

  entries.push({ id: "sep-3", separator: true });
  entries.push({
    id: "archive",
    label: allArchived ? `Unarchive${suffix}` : `Archive${suffix}`,
    icon: allArchived ? <ArchiveRestore /> : <Archive />,
    shortcut: "A",
    run: () => actions.setArchived(ids, !allArchived),
  });
  entries.push({
    id: "trash",
    label: `Move to trash${suffix}`,
    icon: <Trash2 />,
    shortcut: "⌫",
    destructive: true,
    run: () => actions.trash(ids),
  });

  return entries;
}

/* ------------------------------------------------------------- renderers */

export function ItemDropdownContent(props: ActionContext & { align?: "start" | "end" }) {
  const entries = buildActions(props);
  return (
    <DropdownMenuContent align={props.align ?? "end"} className="w-[248px]">
      {props.targets.length > 1 ? (
        <DropdownMenuLabel>{props.targets.length} selected</DropdownMenuLabel>
      ) : null}
      {entries.map((entry) => {
        if (isSeparator(entry)) return <DropdownMenuSeparator key={entry.id} />;
        if (isHeading(entry)) return <DropdownMenuLabel key={entry.id}>{entry.heading}</DropdownMenuLabel>;
        if (isSubmenu(entry)) {
          return (
            <DropdownMenuSub key={entry.id}>
              <DropdownMenuSubTrigger>
                {entry.icon}
                <span className="menu-label">{entry.label}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-64">
                {entry.items.map((item) => (
                  <DropdownMenuItem key={item.id} onSelect={item.run}>
                    {item.icon}
                    <span className="menu-label">{item.label}</span>
                    {item.checked ? <span className="menu-check"><Check size={16} /></span> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }
        return (
          <DropdownMenuItem
            key={entry.id}
            onSelect={entry.run}
            variant={entry.destructive ? "destructive" : "default"}
          >
            {entry.icon}
            <span className="menu-label">{entry.label}</span>
            {entry.shortcut ? <KeyChips keys={entry.shortcut} className="menu-kbd" /> : null}
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuContent>
  );
}

export function ItemContextContent(props: ActionContext) {
  const entries = buildActions(props);
  return (
    <ContextMenuContent className="w-[248px]">
      {props.targets.length > 1 ? (
        <ContextMenuLabel>{props.targets.length} selected</ContextMenuLabel>
      ) : null}
      {entries.map((entry) => {
        if (isSeparator(entry)) return <ContextMenuSeparator key={entry.id} />;
        if (isHeading(entry)) return <ContextMenuLabel key={entry.id}>{entry.heading}</ContextMenuLabel>;
        if (isSubmenu(entry)) {
          return (
            <ContextMenuSub key={entry.id}>
              <ContextMenuSubTrigger>
                {entry.icon}
                <span className="menu-label">{entry.label}</span>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-72 w-64">
                {entry.items.map((item) => (
                  <ContextMenuItem key={item.id} onSelect={item.run}>
                    {item.icon}
                    <span className="menu-label">{item.label}</span>
                    {item.checked ? <span className="menu-check"><Check size={16} /></span> : null}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          );
        }
        return (
          <ContextMenuItem
            key={entry.id}
            onSelect={entry.run}
            variant={entry.destructive ? "destructive" : "default"}
          >
            {entry.icon}
            <span className="menu-label">{entry.label}</span>
            {entry.shortcut ? <KeyChips keys={entry.shortcut} className="menu-kbd" /> : null}
          </ContextMenuItem>
        );
      })}
    </ContextMenuContent>
  );
}
