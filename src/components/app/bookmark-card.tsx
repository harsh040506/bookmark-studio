/**
 * A bookmark, as a card and as a row.
 *
 * ## Both shapes live here on purpose
 *
 * The grid and the list are the same object at two densities, and when they were two
 * components they drifted: the list forgot the health badge, the card forgot the folder,
 * and the two disagreed about what a right-click offered. They share their menu, their
 * selection behaviour, their hover states and their keyboard contract, and only differ in
 * layout.
 *
 * ## Why these are memoised, and what that requires of the caller
 *
 * A grid mounts eighty of these and a scroll gesture re-renders the container sixty times a
 * second. Without `memo` every card re-renders on every frame; with it, none do — but only
 * if the props are referentially stable. That is why handlers arrive as one `actions`
 * object built once by the parent, and why selection is passed as a boolean rather than as
 * the selection set: passing the set would change identity on every click and defeat the
 * memo for every card at once.
 */
import { ExternalLink, Folder as FolderIcon, Heart, MoreHorizontal } from "@/components/icons";
import { memo, type MouseEvent } from "react";

import type { Board, Bookmark, DeviceName, Folder } from "@shared/types";
import { hasPage } from "@shared/types";
import { Badge } from "@/components/ui/primitives";
import { Checkbox } from "@/components/ui/controls";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn, formatDate } from "@/lib/utils";
import { Favicon, Thumbnail } from "./media";
import { ItemContextContent, ItemDropdownContent, type ItemActions } from "./item-actions";

export interface CardChrome {
  actions: ItemActions;
  folders: Folder[];
  boards: Board[];
  folderPaths: Map<string, string>;
  device: DeviceName;
  showImages: boolean;
  inTrash?: boolean;
  /** The rows a bulk action should apply to when this card is part of a selection. */
  selectionTargets: (bookmark: Bookmark) => Bookmark[];
  onOpenDetail: (bookmark: Bookmark) => void;
  onToggleSelect: (id: string, event: MouseEvent) => void;
}

interface ItemProps {
  bookmark: Bookmark;
  selected: boolean;
  /** True when anything at all is selected, so checkboxes stay visible. */
  selecting: boolean;
  chrome: CardChrome;
}

/** Health, but only when it is worth a word. A live link says nothing. */
function HealthChip({ bookmark }: { bookmark: Bookmark }) {
  const status = bookmark.health.status;
  if (status === "live" || status === "unchecked") return null;
  return (
    <Badge variant={status === "dead" ? "destructive" : "warning"} className="shrink-0">
      {status === "dead" ? "Dead" : status === "redirected" ? "Moved" : "Blocked"}
    </Badge>
  );
}

/* ------------------------------------------------------------------- card */

function CardBase({ bookmark, selected, selecting, chrome }: ItemProps) {
  const { actions, device, showImages } = chrome;
  const openable = hasPage(bookmark);

  const openDetail = () => chrome.onOpenDetail(bookmark);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          // A short, explicit name instead of every line of the card read aloud, with the
          // selection state in it (aria-selected is not valid on a button).
          aria-label={[bookmark.title, bookmark.domain, selected ? "selected" : ""].filter(Boolean).join(", ")}
          data-selected={selected || undefined}
          onClick={(event) => {
            // Modifier-clicks are selection gestures, not navigation — the same contract
            // as a file manager, which is where people's expectations come from.
            if (event.metaKey || event.ctrlKey || event.shiftKey) {
              event.preventDefault();
              chrome.onToggleSelect(bookmark.id, event);
              return;
            }
            openDetail();
          }}
          /*
           * A double-click opens the page.
           *
           * One click opens what the app knows about the bookmark; two open the bookmark
           * itself — the same split a file manager makes between selecting a file and
           * launching it, and the one people already have a reflex for.
           */
          onDoubleClick={(event) => {
            if (!openable) return;
            event.preventDefault();
            actions.open(bookmark);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey && openable) actions.open(bookmark);
              else openDetail();
            }
            if (event.key === " ") {
              event.preventDefault();
              chrome.onToggleSelect(bookmark.id, event as unknown as MouseEvent);
            }
          }}
          className={cn("group bs-item-card", selected && "is-selected")}
        >
          {showImages ? (
            <div className="bs-item-media">
              <Thumbnail bookmark={bookmark} device={device} rounded="" />
            </div>
          ) : null}

          {/*
            The footer, which is deliberately two lines and never three.
             
            A card in a grid is an identifier, not a summary: what the reader needs is
            "which page is this" — a mark, a title, and where it came from. The
            description used to sit here as a third block and it did two bad things at
            once: it pushed the picture out of the card's own frame, and because
            descriptions vary wildly in length it made every card a slightly different
            shape. It is still shown when pictures are off, where the card has nothing
            else to go on, and it is always in the detail panel and the list.
          */}
          <div className="bs-item-body">
            <div className="flex items-start gap-2.5">
              <Favicon bookmark={bookmark} size={16} className="bs-item-favicon" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="bs-item-title clamp-2">{bookmark.title}</p>
                <div className="bs-item-meta">
                  <span className="truncate">
                    {bookmark.domain || formatDate(bookmark.addedAt)}
                  </span>
                  {bookmark.tags.length ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="truncate">{bookmark.tags.slice(0, 2).join(", ")}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <span className="flex shrink-0 items-center gap-1">
                <HealthChip bookmark={bookmark} />
                {bookmark.favorite ? (
                  <Heart size={14} className="bs-fav" aria-label="Favourite" />
                ) : null}
              </span>
            </div>

            {!showImages && bookmark.description ? (
              <p className="bs-item-desc clamp-2">{bookmark.description}</p>
            ) : null}
          </div>

          {/* ------------------------------------------------ hover controls */}

          <div className={cn("bs-item-select", (selecting || selected) && "is-visible")}>
            <span
              className="bs-item-chip"
              onClick={(event) => {
                event.stopPropagation();
                chrome.onToggleSelect(bookmark.id, event);
              }}
            >
              <Checkbox
                checked={selected}
                aria-label={`Select ${bookmark.title}`}
                onCheckedChange={() => {}}
                tabIndex={-1}
              />
            </span>
          </div>

          <div className="bs-item-tools" onClick={(event) => event.stopPropagation()}>
            {openable ? (
              <button type="button" className="bs-item-tool" aria-label="Open in a new tab" title="Open in a new tab" onClick={() => actions.open(bookmark)}>
                <ExternalLink size={15} />
              </button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="bs-item-tool" aria-label={`Actions for ${bookmark.title}`}>
                  <MoreHorizontal size={15} />
                </button>
              </DropdownMenuTrigger>
              <ItemDropdownContent
                targets={chrome.selectionTargets(bookmark)}
                actions={actions}
                folders={chrome.folders}
                boards={chrome.boards}
                folderPaths={chrome.folderPaths}
                inTrash={chrome.inTrash}
              />
            </DropdownMenu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ItemContextContent
        targets={chrome.selectionTargets(bookmark)}
        actions={actions}
        folders={chrome.folders}
        boards={chrome.boards}
        folderPaths={chrome.folderPaths}
        inTrash={chrome.inTrash}
      />
    </ContextMenu>
  );
}

export const BookmarkCard = memo(CardBase);

/* -------------------------------------------------------------------- row */

function RowBase({ bookmark, selected, selecting, chrome }: ItemProps) {
  const { actions, device, showImages } = chrome;
  const folder = bookmark.folderId ? chrome.folderPaths.get(bookmark.folderId) : "";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          // A short, explicit name instead of every line of the card read aloud, with the
          // selection state in it (aria-selected is not valid on a button).
          aria-label={[bookmark.title, bookmark.domain, selected ? "selected" : ""].filter(Boolean).join(", ")}
          data-selected={selected || undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) {
              event.preventDefault();
              chrome.onToggleSelect(bookmark.id, event);
              return;
            }
            chrome.onOpenDetail(bookmark);
          }}
          onDoubleClick={(event) => {
            if (!hasPage(bookmark)) return;
            event.preventDefault();
            actions.open(bookmark);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey && hasPage(bookmark)) actions.open(bookmark);
              else chrome.onOpenDetail(bookmark);
            }
          }}
          className={cn("group bs-item-row", selected && "is-selected")}
        >
          <span
            className={cn("bs-row-check", (selecting || selected) && "is-visible")}
            onClick={(event) => {
              event.stopPropagation();
              chrome.onToggleSelect(bookmark.id, event);
            }}
          >
            <Checkbox
              checked={selected}
              aria-label={`Select ${bookmark.title}`}
              onCheckedChange={() => {}}
              tabIndex={-1}
            />
          </span>

          {showImages ? (
            <div className="bs-row-thumb">
              <Thumbnail bookmark={bookmark} device={device} rounded="" />
            </div>
          ) : (
            <Favicon bookmark={bookmark} size={16} />
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <span className="bs-row-title">{bookmark.title}</span>
            <span className="bs-row-meta">
              {bookmark.domain || formatDate(bookmark.addedAt)}
              {bookmark.description ? ` · ${bookmark.description}` : ""}
            </span>
          </div>

          {/* Always rendered, so the column lines up whether or not a row is filed. The
              leaf folder is shown; the full path is in the tooltip. */}
          <span className="bs-row-folder" title={folder || undefined}>
            {folder ? (
              <>
                <FolderIcon size={13} aria-hidden="true" />
                <span className="bs-row-folder-name">{folder.split(" / ").pop()}</span>
              </>
            ) : null}
          </span>

          <span className="hidden w-24 shrink-0 justify-end gap-1 md:flex">
            <HealthChip bookmark={bookmark} />
          </span>

          <span className="bs-row-date tabular">
            {formatDate(bookmark.addedAt)}
          </span>

          <span
            className="flex shrink-0 items-center gap-0.5"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className={cn("icon-btn bs-row-tool", bookmark.favorite && "is-fav")}
              aria-label={bookmark.favorite ? "Remove from favourites" : "Add to favourites"}
              onClick={() => actions.toggleFavorite([bookmark.id], !bookmark.favorite)}
            >
              <Heart size={15} />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="icon-btn bs-row-tool" aria-label={`Actions for ${bookmark.title}`}>
                  <MoreHorizontal size={15} />
                </button>
              </DropdownMenuTrigger>
              <ItemDropdownContent
                targets={chrome.selectionTargets(bookmark)}
                actions={actions}
                folders={chrome.folders}
                boards={chrome.boards}
                folderPaths={chrome.folderPaths}
                inTrash={chrome.inTrash}
              />
            </DropdownMenu>
          </span>
        </div>
      </ContextMenuTrigger>
      <ItemContextContent
        targets={chrome.selectionTargets(bookmark)}
        actions={actions}
        folders={chrome.folders}
        boards={chrome.boards}
        folderPaths={chrome.folderPaths}
        inTrash={chrome.inTrash}
      />
    </ContextMenu>
  );
}

export const BookmarkRow = memo(RowBase);

/* ---------------------------------------------------------------- loading */

/** The card's own placeholder, so a loading grid has the geometry of the real one. No shimmer. */
export function CardSkeleton({ showImages = true }: { showImages?: boolean }) {
  return (
    <div className="bs-item-card is-placeholder" aria-hidden>
      {showImages ? <div className="bs-item-media" /> : null}
      <div className="bs-item-body">
        <div className="bs-ph h-3 w-4/5" />
        <div className="bs-ph h-3 w-3/5" />
      </div>
    </div>
  );
}

export function RowSkeleton() {
  return (
    <div className="bs-item-row is-placeholder" aria-hidden>
      <div className="bs-ph size-4" />
      <div className="bs-ph h-9 w-14" />
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="bs-ph h-3 w-1/3" />
        <div className="bs-ph h-2.5 w-1/2" />
      </div>
    </div>
  );
}
