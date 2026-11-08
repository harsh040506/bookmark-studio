/**
 * The small modals: add, edit, rename, pick a folder, save a search.
 *
 * Each is a controlled component that owns only its draft. Nothing here reaches into the
 * library — they take an `onSubmit` and hand back a value, which is what lets the same
 * prompt serve "rename folder", "rename board", "name this import" and "add a tag" instead
 * of four near-identical dialogs.
 */
import { Check, FolderInput, Search, Sparkles } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Bookmark, Folder, SmartCollection } from "@shared/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SMART_COLORS, suggestName } from "@/lib/smart";
import { normalizeUserUrl } from "@/lib/url-input";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------- text prompt */

export function TextPromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  initialValue = "",
  confirmLabel = "Save",
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            onSubmit(trimmed);
            onOpenChange(false);
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="prompt-value">{label}</Label>
            <Input
              id="prompt-value"
              autoFocus
              value={value}
              placeholder={placeholder}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------- add */

export function AddBookmarkDialog({
  open,
  onOpenChange,
  folders,
  folderPaths,
  defaultFolderId,
  initialUrl,
  findExisting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: Folder[];
  folderPaths: Map<string, string>;
  defaultFolderId: string | null;
  /** A link to start with — set when one was pasted onto the page. */
  initialUrl?: string;
  /** Returns the existing bookmark's title when this address is already saved. */
  findExisting?: (url: string) => string | null;
  onSubmit: (input: { url: string; title: string; folderId: string | null; note?: string }) => void;
}) {
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [folderId, setFolderId] = useState<string | null>(defaultFolderId);

  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl ?? "");
    setTouched(Boolean(initialUrl));
    setTitle("");
    setNote("");
    setFolderId(defaultFolderId);
  }, [open, defaultFolderId, initialUrl]);

  const check = normalizeUserUrl(url);
  const existing = check.ok && findExisting ? findExisting(check.url) : null;
  const valid = check.ok && !existing;
  const error = !touched || !url.trim() ? "" : !check.ok ? check.error : existing ? `Already saved as “${existing}”.` : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (!valid || !check.ok) return;
            onSubmit({ url: check.url, title: title.trim(), folderId, note: note.trim() || undefined });
            onOpenChange(false);
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Add a link</DialogTitle>
            <DialogDescription>
              The page is read in the background — title, description and preview fill in on their
              own.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-url">Address</Label>
            <Input
              id="add-url"
              autoFocus
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="https://example.com/article"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby="add-url-error"
            />
            <p id="add-url-error" className="field-error" role="alert">
              {error}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-title">Title</Label>
            <Input
              id="add-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Optional — taken from the page if left blank"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-folder">Folder</Label>
            <Select
              value={folderId ?? "none"}
              onValueChange={(value) => setFolderId(value === "none" ? null : value)}
            >
              <SelectTrigger id="add-folder" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No folder</SelectItem>
                {folders.slice(0, 200).map((folder) => (
                  <SelectItem key={folder.id} value={folder.id}>
                    {folderPaths.get(folder.id) ?? folder.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-note">Note</Label>
            <Textarea
              id="add-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why you are saving this"
              className="min-h-14"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Save bookmark
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ edit */

export function EditBookmarkDialog({
  bookmark,
  onOpenChange,
  folders,
  folderPaths,
  onSubmit,
}: {
  bookmark: Bookmark | null;
  onOpenChange: (open: boolean) => void;
  folders: Folder[];
  folderPaths: Map<string, string>;
  onSubmit: (id: string, patch: Partial<Bookmark>) => void;
}) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (!bookmark) return;
    setTitle(bookmark.title);
    setUrl(bookmark.url);
    setDescription(bookmark.description);
    setTags(bookmark.tags.join(", "));
    setFolderId(bookmark.folderId);
  }, [bookmark]);

  const urlCheck = bookmark?.url && url.trim() ? normalizeUserUrl(url) : null;
  const editUrlError = urlCheck && !urlCheck.ok ? urlCheck.error : "";

  return (
    <Dialog open={Boolean(bookmark)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!bookmark) return;
            if (editUrlError) return;
            const nextUrl = bookmark.url && url.trim() ? normalizeUserUrl(url) : null;
            onSubmit(bookmark.id, {
              title: title.trim() || bookmark.title,
              url: nextUrl && nextUrl.ok ? nextUrl.url : bookmark.url,
              description: description.trim(),
              tags: tags
                .split(",")
                .map((tag) => tag.trim().toLowerCase())
                .filter(Boolean)
                .slice(0, 24),
              folderId,
            });
            onOpenChange(false);
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Edit bookmark</DialogTitle>
            <DialogDescription>
              Anything you change here is kept — a later page read will not overwrite it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-title">Title</Label>
            <Input id="edit-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          {bookmark?.url ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-url">Address</Label>
              <Input
                id="edit-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                spellCheck={false}
                aria-invalid={Boolean(editUrlError)}
                aria-describedby="edit-url-error"
              />
              <p id="edit-url-error" className="field-error" role="alert">
                {editUrlError}
              </p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-16"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-tags">Tags</Label>
            <Input
              id="edit-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="comma, separated"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-folder">Folder</Label>
            <Select
              value={folderId ?? "none"}
              onValueChange={(value) => setFolderId(value === "none" ? null : value)}
            >
              <SelectTrigger id="edit-folder" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No folder</SelectItem>
                {folders.slice(0, 200).map((folder) => (
                  <SelectItem key={folder.id} value={folder.id}>
                    {folderPaths.get(folder.id) ?? folder.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------- folder picker */

/**
 * Choosing a folder from a list that may hold thousands.
 *
 * A `<Select>` is the wrong control past about thirty options — it cannot be searched, and
 * a scroll through four hundred paths is not a choice anybody makes. This is a filtered
 * list, ranked by how well the path matches, capped at what fits.
 */
export function FolderPickerDialog({
  open,
  onOpenChange,
  folders,
  folderPaths,
  count,
  onPick,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: Folder[];
  folderPaths: Map<string, string>;
  count: number;
  onPick: (folderId: string | null) => void;
  onCreate: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const entries = folders.map((folder) => ({
      folder,
      path: folderPaths.get(folder.id) ?? folder.name,
    }));
    const filtered = needle
      ? entries.filter((entry) => entry.path.toLowerCase().includes(needle))
      : entries;
    return filtered.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 80);
  }, [folders, folderPaths, query]);

  const exact = matches.some((entry) => entry.path.toLowerCase() === query.trim().toLowerCase());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Move {count.toLocaleString()} to a folder</DialogTitle>
          <DialogDescription>
            {folders.length.toLocaleString()} folders — start typing to narrow them.
          </DialogDescription>
        </DialogHeader>

        <div className="file-search">
          <Search />
          <Input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find or create a folder"
          />
        </div>

        <div className="file-list">
          <button
            type="button"
            onClick={() => {
              onPick(null);
              onOpenChange(false);
            }}
            className="file-row bs-file-row"
          >
            <span className="file-icon">
              <FolderInput />
            </span>
            <span className="file-name">No folder</span>
          </button>
          {matches.map((entry) => (
            <button
              key={entry.folder.id}
              type="button"
              onClick={() => {
                onPick(entry.folder.id);
                onOpenChange(false);
              }}
              className="file-row bs-file-row"
            >
              <span className="file-icon">
                <FolderInput />
              </span>
              <span className="file-name">{entry.path}</span>
            </button>
          ))}
          {!matches.length && !query.trim() ? (
            <p className="file-empty">No folders yet.</p>
          ) : null}
        </div>

        {query.trim() && !exact ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onCreate(query.trim());
              onOpenChange(false);
            }}
          >
            <Check /> Create “{query.trim()}” and move here
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------- smart collection */

export function SmartCollectionDialog({
  open,
  onOpenChange,
  collection,
  initialQuery,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collection: SmartCollection | null;
  initialQuery: string;
  onSubmit: (values: { name: string; query: string; color: string }) => void;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [color, setColor] = useState(SMART_COLORS[0]);

  useEffect(() => {
    if (!open) return;
    setName(collection?.name ?? "");
    setQuery(collection?.query ?? initialQuery);
    setColor(collection?.color ?? SMART_COLORS[0]);
  }, [open, collection, initialQuery]);

  const proposed = useMemo(() => suggestName(query), [query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!query.trim()) return;
            onSubmit({ name: name.trim() || proposed, query: query.trim(), color });
            onOpenChange(false);
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>{collection ? "Edit collection" : "Save this search"}</DialogTitle>
            <DialogDescription>
              A collection is a stored query. It shows whatever matches now, not what matched when
              you saved it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="smart-query">Rule</Label>
            <Input
              id="smart-query"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="tag:design is:dead last month"
              className="mono"
            />
            <p className="field-hint">
              Anything the search box understands: <code>tag:</code>, <code>site:</code>,{" "}
              <code>is:dead</code>, <code>has:offline</code>, plain words, or a date phrase.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="smart-name">Name</Label>
            <Input
              id="smart-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={proposed}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Colour</Label>
            <div className="flex gap-1.5">
              {SMART_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={`Colour ${swatch}`}
                  onClick={() => setColor(swatch)}
                  className={cn("bs-swatch", color === swatch && "is-on")}
                  style={{ background: swatch }}
                />
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!query.trim()}>
              <Sparkles /> {collection ? "Save changes" : "Create collection"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
