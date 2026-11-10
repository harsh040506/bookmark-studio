/**
 * Choosing a folder from a tree that may hold thousands, several levels deep.
 *
 * A `<Select>` is the wrong control past about thirty options: it cannot be searched, and a
 * scroll through four hundred paths is not a choice anybody makes. Everything here is one
 * filtered list, ranked by how well the folder matches what was typed, driven entirely from
 * the keyboard if you like: type, arrow to a row, Enter.
 *
 * Three surfaces share it, so a folder is chosen the same way everywhere:
 *
 *   · {@link FolderPickerDialog} — "Move 12 to a folder", and moving a folder itself;
 *   · {@link FolderField} — the Folder field in the Add and Edit dialogs;
 *   · {@link FolderChooser} — the list both are built from.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { Folder } from "@shared/types";
import { Check, ChevronDown, Folder as FolderIcon, FolderInput, Plus, Search } from "@/components/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { folderEntries, rankFolders, type FolderEntry } from "@/lib/library";
import { cn } from "@/lib/utils";

/** Rows drawn at once. Past this the list says how many more there are and asks for more letters. */
const VISIBLE = 80;
/** The longest name a folder may be given. Browsers accept more; nothing can display it. */
export const FOLDER_NAME_MAX = 200;

type Entry = FolderEntry;

/** The rows to draw for what was typed, how many matched in all, and whether one is an exact match. */
function useFolderMatches(
  folders: Folder[],
  folderPaths: Map<string, string>,
  query: string,
  exclude?: ReadonlySet<string>,
): { shown: Entry[]; total: number; exact: boolean } {
  const entries = useMemo(() => folderEntries(folders, folderPaths, exclude), [folders, folderPaths, exclude]);
  return useMemo(() => {
    const { matches, exact } = rankFolders(entries, query);
    return { shown: matches.slice(0, VISIBLE), total: matches.length, exact };
  }, [entries, query]);
}

/** A folder's path with its own name set apart, so a long path still ends legibly. */
function PathLabel({ entry }: { entry: Entry }) {
  const parent = entry.path.endsWith(entry.folder.name)
    ? entry.path.slice(0, entry.path.length - entry.folder.name.length).replace(/ \/ $/, "")
    : "";
  return (
    <span className="file-name bs-folder-option">
      <span className="bs-folder-option-name">{entry.folder.name}</span>
      {parent ? <span className="bs-folder-option-path">{parent}</span> : null}
    </span>
  );
}

export function FolderChooser({
  folders,
  folderPaths,
  value,
  exclude,
  noneLabel = "No folder",
  placeholder = "Find a folder",
  onPick,
  onCreate,
  createLabel = (name: string) => `Create “${name}”`,
}: {
  folders: Folder[];
  folderPaths: Map<string, string>;
  /** The folder currently chosen, marked with a tick. `undefined` marks nothing. */
  value?: string | null;
  /** Folders that cannot be chosen (a folder cannot be moved into itself). */
  exclude?: ReadonlySet<string>;
  noneLabel?: string;
  placeholder?: string;
  onPick: (folderId: string | null) => void;
  /** When given, typing a name that does not exist offers to create it. */
  onCreate?: (name: string) => void;
  createLabel?: (name: string) => string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const { shown, total, exact } = useFolderMatches(folders, folderPaths, query, exclude);
  const name = query.trim().slice(0, FOLDER_NAME_MAX);
  const canCreate = Boolean(onCreate && name && !exact);
  const showNone = !query.trim();

  // Every choosable row, in the order drawn, so the keyboard and the pointer agree.
  const options = useMemo(() => {
    const list: ({ kind: "none" } | { kind: "folder"; entry: Entry } | { kind: "create" })[] = [];
    if (showNone) list.push({ kind: "none" });
    for (const entry of shown) list.push({ kind: "folder", entry });
    if (canCreate) list.push({ kind: "create" });
    return list;
  }, [shown, showNone, canCreate]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (position: number) => {
    const option = options[position];
    if (!option) return;
    if (option.kind === "none") onPick(null);
    else if (option.kind === "folder") onPick(option.entry.folder.id);
    else onCreate?.(name);
  };

  const optionId = (position: number) => `${listId}-option-${position}`;

  return (
    <div className="bs-folder-chooser">
      <div className="file-search">
        <Search />
        <Input
          autoFocus
          value={query}
          maxLength={FOLDER_NAME_MAX}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={options.length ? optionId(active) : undefined}
          aria-label={placeholder}
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current) => Math.min(current + 1, options.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) => Math.max(current - 1, 0));
            } else if (event.key === "Home" && !query) {
              event.preventDefault();
              setActive(0);
            } else if (event.key === "End" && !query) {
              event.preventDefault();
              setActive(options.length - 1);
            } else if (event.key === "Enter") {
              // Always handled here: inside a form, Enter would otherwise submit the whole dialog.
              event.preventDefault();
              choose(active);
            }
          }}
        />
      </div>

      <div className="file-list" id={listId} role="listbox" ref={listRef} aria-label="Folders">
        {options.map((option, position) => {
          const isActive = position === active;
          const common = {
            id: optionId(position),
            role: "option" as const,
            "aria-selected": isActive,
            "data-active": isActive,
            tabIndex: -1,
            type: "button" as const,
            className: cn("file-row bs-file-row", isActive && "is-active"),
            onMouseMove: () => setActive(position),
            onClick: () => choose(position),
          };
          if (option.kind === "none") {
            return (
              <button key="none" {...common}>
                <span className="file-icon">
                  <FolderInput />
                </span>
                <span className="file-name">{noneLabel}</span>
                {value === null ? <Check size={15} className="bs-folder-option-check" /> : null}
              </button>
            );
          }
          if (option.kind === "create") {
            return (
              <button key="create" {...common}>
                <span className="file-icon">
                  <Plus />
                </span>
                <span className="file-name">{createLabel(name)}</span>
              </button>
            );
          }
          return (
            <button key={option.entry.folder.id} {...common} title={option.entry.path}>
              <span className="file-icon">
                <FolderIcon />
              </span>
              <PathLabel entry={option.entry} />
              {value === option.entry.folder.id ? <Check size={15} className="bs-folder-option-check" /> : null}
            </button>
          );
        })}
        {!options.length ? (
          <p className="file-empty">{query.trim() ? "No folder matches." : "No folders yet."}</p>
        ) : null}
        {total > shown.length ? (
          <p className="bs-folder-more" role="status">
            {(total - shown.length).toLocaleString()} more — keep typing to narrow them.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */

export function FolderPickerDialog({
  open,
  onOpenChange,
  folders,
  folderPaths,
  title,
  description,
  exclude,
  noneLabel,
  createLabel,
  onPick,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: Folder[];
  folderPaths: Map<string, string>;
  title: string;
  description?: string;
  exclude?: ReadonlySet<string>;
  noneLabel?: string;
  createLabel?: (name: string) => string;
  onPick: (folderId: string | null) => void;
  onCreate?: (name: string) => void;
}) {
  const choosable = folders.length - (exclude?.size ?? 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ??
              (choosable > 0
                ? `${choosable.toLocaleString()} folder${choosable === 1 ? "" : "s"}. Type to narrow them, then press Enter.`
                : "There are no folders yet. Type a name to make one.")}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts with an empty search. */}
        {open ? (
          <FolderChooser
            folders={folders}
            folderPaths={folderPaths}
            exclude={exclude}
            noneLabel={noneLabel}
            placeholder={onCreate ? "Find or create a folder" : "Find a folder"}
            createLabel={createLabel}
            onPick={(folderId) => {
              onPick(folderId);
              onOpenChange(false);
            }}
            onCreate={
              onCreate
                ? (name) => {
                    onCreate(name);
                    onOpenChange(false);
                  }
                : undefined
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------- field */

/**
 * The Folder field of a form: a button showing the chosen folder that opens the same
 * searchable list. Every folder is reachable, however many there are.
 */
export function FolderField({
  id,
  value,
  onChange,
  folders,
  folderPaths,
}: {
  id?: string;
  value: string | null;
  onChange: (folderId: string | null) => void;
  folders: Folder[];
  folderPaths: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  // A folder deleted since the row was filed has no path; say so instead of showing an id.
  const label = value === null ? "No folder" : (folderPaths.get(value) ?? "A folder that no longer exists");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button id={id} type="button" className="btn btn-ghost bs-select-trigger w-full" aria-haspopup="listbox" title={label}>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronDown size={12} className="tb-caret" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="bs-folder-popover">
        <FolderChooser
          folders={folders}
          folderPaths={folderPaths}
          value={value}
          onPick={(folderId) => {
            onChange(folderId);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
