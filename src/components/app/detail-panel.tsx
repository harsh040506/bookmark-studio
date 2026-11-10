/**
 * Everything known about one bookmark, in a sheet beside the grid.
 *
 * ## Why a sheet and not a page
 *
 * Opening a bookmark is an aside, not a departure: people open one, glance, and go back to
 * scanning. A route change would clear the search, lose the scroll position and put a
 * history entry between the reader and the list they were reading. The sheet keeps the
 * grid on screen and Escape puts it away.
 *
 * ## Editing is inline and immediate
 *
 * There is no separate edit dialog for the fields that live here. A note, a tag and alt
 * text are things people write *while looking at the thing*, and a modal between them and
 * the field is the reason those fields stay empty in most bookmark managers.
 */
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Calendar,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Globe,
  Hash,
  Heart,
  Highlighter,
  Languages,
  Link2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
  WifiOff,
  X,
} from "@/components/icons";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import type { Board, Bookmark, DeviceName, Folder } from "@shared/types";
import { hasPage, tagOrigin } from "@shared/types";
import { Badge, Kbd, Separator } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Hint } from "@/components/ui/tooltip";
import { formatBytes, formatDate } from "@/lib/utils";
import { formatRelative } from "@/lib/library";
import { Favicon, PreviewSurface } from "./media";

export interface DetailPanelProps {
  bookmark: Bookmark | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  device: DeviceName;
  folders: Folder[];
  boards: Board[];
  folderPaths: Map<string, string>;
  onOpen: (bookmark: Bookmark) => void;
  onToggleFavorite: (id: string) => void;
  onSetNote: (id: string, note: string) => void;
  onSetAlt: (id: string, alt: string) => void;
  onAddTag: (ids: string[], tag: string) => void;
  onRemoveTag: (ids: string[], tag: string) => void;
  onEdit: (bookmark: Bookmark) => void;
  onTrash: (ids: string[]) => void;
  onRefreshShot: (bookmark: Bookmark) => void;
  onSaveOffline: (bookmark: Bookmark) => void;
  onOpenOffline: (bookmark: Bookmark) => void;
  onRemoveHighlight: (id: string, highlightId: string) => void;
  onAddHighlight: (id: string, text: string) => void;
  onNavigateTag: (tag: string) => void;
  onNavigateFolder: (id: string) => void;
  onShowSimilar: (bookmark: Bookmark) => void;
  /** Step to the previous (-1) or next (1) result; absent at either end. */
  onStep?: (direction: -1 | 1) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  /** "12 of 89", for the footer. */
  position?: string;
}

function Field({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="bs-fact">
      <span className="bs-fact-icon">{icon}</span>
      <span className="bs-fact-label">{label}</span>
      <span className="bs-fact-value">{value}</span>
    </div>
  );
}

export function DetailPanel(props: DetailPanelProps) {
  const { bookmark } = props;
  const [note, setNote] = useState("");
  const [alt, setAlt] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [highlightDraft, setHighlightDraft] = useState("");
  const [copied, setCopied] = useState(false);

  /*
   * Local drafts are reseeded when the subject changes, not on every render.
   *
   * Keying on the id rather than on the object: a background pass writes a screenshot
   * timestamp onto the row every few seconds, and reseeding on object identity would wipe
   * a half-typed note each time one landed.
   */
  useEffect(() => {
    setNote(bookmark?.note ?? "");
    setAlt(bookmark?.alt ?? "");
    setTagDraft("");
    setHighlightDraft("");
  }, [bookmark?.id]);

  /*
   * A note is saved when its field loses focus, and a field that is removed from the page
   * does not always lose focus first: pressing Esc with the cursor still in it, or stepping
   * to the next bookmark from the keyboard, closed the panel and dropped what was typed.
   * So whatever is unsaved is also saved when the panel moves on or closes.
   */
  const drafts = useRef({ note, alt, setNote: props.onSetNote, setAlt: props.onSetAlt });
  drafts.current = { note, alt, setNote: props.onSetNote, setAlt: props.onSetAlt };
  /** The bookmark as it was last drawn: the one the drafts in hand were typed about. */
  const drawn = useRef(bookmark);
  useEffect(() => {
    const id = bookmark?.id;
    if (!id) return;
    return () => {
      // Runs before the drafts are reseeded for the next bookmark, so they are still this one's.
      const row = drawn.current;
      if (!row || row.id !== id) return;
      const latest = drafts.current;
      if ((row.note ?? "") !== latest.note.trim()) latest.setNote(id, latest.note);
      if ((row.alt ?? "") !== latest.alt.trim()) latest.setAlt(id, latest.alt);
    };
  }, [bookmark?.id]);
  useEffect(() => {
    if (bookmark) drawn.current = bookmark;
  });
  const noteId = useId();
  const altId = useId();

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!bookmark) {
    return (
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetContent aria-describedby={undefined}>
          <div className="file-empty">Nothing selected.</div>
        </SheetContent>
      </Sheet>
    );
  }

  const row = bookmark;
  const openable = hasPage(row);
  const folder = row.folderId ? props.folderPaths.get(row.folderId) : null;
  const health = row.health;

  const commitNote = () => {
    if ((row.note ?? "") === note.trim()) return;
    props.onSetNote(row.id, note);
  };
  const commitAlt = () => {
    if ((row.alt ?? "") === alt.trim()) return;
    props.onSetAlt(row.id, alt);
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent aria-label={row.title} aria-describedby={undefined}>
        {/* --------------------------------------------------------- header */}
        <div className="bs-detail-head">
          <Favicon bookmark={row} size={20} className="mt-1" />
          <div className="min-w-0 flex-1">
            <h2 className="bs-detail-title">{row.title}</h2>
            {openable ? (
              <a
                href={row.url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(event) => {
                  event.preventDefault();
                  props.onOpen(row);
                }}
                className="bs-detail-url"
              >
                <span className="truncate">{row.url}</span>
                <ArrowUpRight size={13} className="shrink-0" />
              </a>
            ) : null}
          </div>
        </div>

        <div className="bs-detail-scroll">
          {/* ------------------------------------------------------ preview */}
          <div className="bs-detail-section pb-0">
            <PreviewSurface bookmark={row} device={props.device} className="aspect-[16/10] w-full" />
          </div>

          {/* ------------------------------------------------------ actions */}
          <div className="bs-detail-actions">
            {openable ? (
              <Button size="sm" onClick={() => props.onOpen(row)}>
                <ExternalLink /> Open
              </Button>
            ) : null}
            {openable ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(row.url).then(
                    () => setCopied(true),
                    () => toast.error("Could not copy the link"),
                  );
                }}
              >
                {copied ? <Check /> : <Link2 />}
                {copied ? "Copied" : "Copy link"}
              </Button>
            ) : null}
            <Hint label={row.favorite ? "Remove from favourites" : "Add to favourites"} keys="F">
              <Button
                size="icon-sm"
                variant="outline"
                onClick={() => props.onToggleFavorite(row.id)}
                aria-label="Toggle favourite"
              >
                <Heart className={row.favorite ? "bs-fav" : ""} />
              </Button>
            </Hint>
            {openable ? (
              <Hint label="Capture a fresh screenshot">
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={() => props.onRefreshShot(row)}
                  aria-label="Refresh preview"
                >
                  <RefreshCw />
                </Button>
              </Hint>
            ) : null}
            {openable ? (
              <Hint label={row.offline?.assetKey ? "Open the offline copy" : "Save an offline copy"}>
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={() =>
                    row.offline?.assetKey ? props.onOpenOffline(row) : props.onSaveOffline(row)
                  }
                  aria-label="Offline copy"
                >
                  <WifiOff />
                </Button>
              </Hint>
            ) : null}
            {row.visual?.phash ? (
              <Hint label="Find look-alikes">
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={() => props.onShowSimilar(row)}
                  aria-label="Find look-alikes"
                >
                  <Copy />
                </Button>
              </Hint>
            ) : null}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => props.onEdit(row)}>
              Edit…
            </Button>
            <Hint label="Move to trash" keys="⌫">
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-danger-text"
                onClick={() => props.onTrash([row.id])}
                aria-label="Move to trash"
              >
                <Trash2 />
              </Button>
            </Hint>
          </div>

          <Separator />

          {/* ---------------------------------------------------- the words */}
          {row.description || row.summary || row.text ? (
            <div className="bs-detail-section bs-detail-words">
              {row.text ? <p className="bs-detail-body whitespace-pre-wrap">{row.text}</p> : null}
              {row.description ? <p className="bs-detail-body">{row.description}</p> : null}
              {row.summary && row.summary !== row.description ? (
                <details className="bs-details">
                  <summary>
                    <FileText size={14} /> Extract from the page
                  </summary>
                  <p className="bs-detail-body">{row.summary}</p>
                </details>
              ) : null}
            </div>
          ) : null}

          {/* --------------------------------------------------------- tags */}
          <div className="bs-detail-section">
            <p className="bs-detail-label">Tags</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {row.tags.map((tag) => (
                <span key={tag} className={tagOrigin(row, tag) === "page" ? "bs-tag is-derived" : "bs-tag"}>
                  <button type="button" onClick={() => props.onNavigateTag(tag)} className="bs-tag-name">
                    {tagOrigin(row, tag) === "page" ? (
                      <Hint label="Found in the page’s own words">
                        <Sparkles size={12} />
                      </Hint>
                    ) : (
                      <Hash size={12} />
                    )}
                    {tag}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => props.onRemoveTag([row.id], tag)}
                    className="bs-tag-remove"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = tagDraft.trim();
                  if (!value) return;
                  props.onAddTag([row.id], value);
                  setTagDraft("");
                }}
                className="inline-flex"
              >
                <Input
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  placeholder="Add tag…"
                  aria-label="Add a tag"
                  maxLength={60}
                  className="bs-tag-input"
                />
              </form>
            </div>
          </div>

          <Separator />

          {/* --------------------------------------------------------- note */}
          <div className="bs-detail-section">
            <label className="bs-detail-label" htmlFor={noteId}>
              Your note
            </label>
            <Textarea
              id={noteId}
              maxLength={5000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onBlur={commitNote}
              placeholder="Why you saved this…"
              rows={3}
            />
            {row.media || row.kind === "image" ? (
              <>
                <label className="bs-detail-label mt-2" htmlFor={altId}>
                  Alt text
                </label>
                <Input
                  id={altId}
                  maxLength={500}
                  value={alt}
                  onChange={(event) => setAlt(event.target.value)}
                  onBlur={commitAlt}
                  placeholder="Describe what the picture shows"
                />
              </>
            ) : null}
          </div>

          {/* --------------------------------------------------- highlights */}
          <div className="bs-detail-section pt-0">
            <p className="bs-detail-label">Highlights</p>
            {row.highlights?.length ? (
              <ul className="flex flex-col gap-1.5">
                {row.highlights.map((highlight) => (
                  <li key={highlight.id} className="bs-highlight">
                    <Highlighter size={14} className="mt-0.5 shrink-0 text-text-3" />
                    <p className="flex-1">
                      <mark>{highlight.text}</mark>
                    </p>
                    <button
                      type="button"
                      className="icon-btn bs-highlight-remove"
                      aria-label="Remove highlight"
                      onClick={() => props.onRemoveHighlight(row.id, highlight.id)}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = highlightDraft.trim();
                if (!value) return;
                props.onAddHighlight(row.id, value);
                setHighlightDraft("");
              }}
              className="flex gap-1.5"
            >
              <Input
                value={highlightDraft}
                onChange={(event) => setHighlightDraft(event.target.value)}
                placeholder="Paste a passage worth keeping"
                aria-label="Add a highlight"
              />
              <Button size="icon" variant="outline" type="submit" aria-label="Add highlight">
                <Plus />
              </Button>
            </form>
          </div>

          <Separator />

          {/* --------------------------------------------------------- facts */}
          <div className="bs-detail-section bs-facts">
            <Field icon={<Globe />} label="Site" value={row.meta?.siteName ?? row.domain} />
            <Field
              icon={<Calendar />}
              label="Saved"
              value={`${formatDate(row.addedAt)}${row.importedAt && row.importedAt !== row.addedAt ? ` · imported ${formatRelative(row.importedAt)}` : ""}`}
            />
            <Field
              icon={<Eye />}
              label="Opened"
              value={
                row.visitCount
                  ? `${row.visitCount}×${row.lastVisitedAt ? ` · last ${formatRelative(row.lastVisitedAt)}` : ""}`
                  : "Never from here"
              }
            />
            {folder ? (
              <Field
                icon={<Hash />}
                label="Folder"
                value={
                  <button
                    type="button"
                    className="bs-link text-left"
                    onClick={() => row.folderId && props.onNavigateFolder(row.folderId)}
                  >
                    {folder}
                  </button>
                }
              />
            ) : null}
            <Field
              icon={<TriangleAlert />}
              label="Link health"
              value={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant={
                      health.status === "live"
                        ? "success"
                        : health.status === "dead"
                          ? "destructive"
                          : health.status === "unchecked"
                            ? "outline"
                            : "warning"
                    }
                  >
                    {health.status}
                  </Badge>
                  {health.httpCode ? <span className="text-text-3 tabular">{health.httpCode}</span> : null}
                  {health.checkedAt ? (
                    <span className="text-text-3 text-xs">
                      checked {formatRelative(health.checkedAt)}
                    </span>
                  ) : null}
                  {health.archiveUrl ? (
                    <a
                      href={health.archiveUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="bs-link text-xs"
                    >
                      Archived copy
                    </a>
                  ) : null}
                </span>
              }
            />
            {health.finalUrl && health.finalUrl !== row.url ? (
              <Field icon={<ArrowUpRight />} label="Redirects to" value={health.finalUrl} />
            ) : null}
            <Field icon={<FileText />} label="Author" value={row.meta?.author ?? row.author} />
            <Field
              icon={<Clock />}
              label="Reading"
              value={row.meta?.readingMinutes ? `about ${row.meta.readingMinutes} min` : null}
            />
            <Field icon={<Languages />} label="Language" value={row.meta?.lang} />
            <Field
              icon={<WifiOff />}
              label="Offline"
              value={
                row.offline?.assetKey
                  ? `${formatBytes(row.offline.bytes)} · saved ${formatRelative(row.offline.capturedAt)}`
                  : row.offline?.error
                    ? `Could not be saved — ${row.offline.error}`
                    : null
              }
            />
            {row.meta?.error ? (
              <Field icon={<TriangleAlert />} label="Read error" value={row.meta.error} />
            ) : null}
          </div>

          {row.meta?.headings?.length ? (
            <div className="bs-detail-section pt-0">
              <p className="bs-detail-label">On this page</p>
              <ul className="bs-outline">
                {row.meta.headings.slice(0, 6).map((heading, position) => (
                  <li key={`${heading}-${position}`} className="truncate">
                    {heading}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="bs-detail-foot">
          <Kbd>Esc</Kbd> to close
          {props.position ? <span className="tabular">· {props.position}</span> : null}
          <span className="ml-auto flex items-center gap-1">
            <Hint label="Previous" keys="←" side="top">
              <button type="button" className="icon-btn" disabled={!props.hasPrev} onClick={() => props.onStep?.(-1)} aria-label="Previous bookmark">
                <ArrowLeft size={15} />
              </button>
            </Hint>
            <Hint label="Next" keys="→" side="top">
              <button type="button" className="icon-btn" disabled={!props.hasNext} onClick={() => props.onStep?.(1)} aria-label="Next bookmark">
                <ArrowRight size={15} />
              </button>
            </Hint>
          </span>
        </div>
      </SheetContent>
    </Sheet>
  );
}
