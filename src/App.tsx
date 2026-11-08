/**
 * Bookmark Studio — a local-first index for very large bookmark libraries.
 *
 * Nothing here calls a language model. Categories come from rules, tags from term
 * statistics, "look-alike" from perceptual hashes, descriptions from the pages themselves,
 * previews from a headless browser you control.
 *
 * ## The shape of this component
 *
 * One screen, many places. The address bar owns *where you are* — a scope, a folder, a
 * tag, a collection, an import — and every filter is derived from that single source
 * (`lib/router.ts`). Search and selection are deliberately not locations: they are things
 * you are *doing*, not places you are, and both are dropped the moment you navigate.
 *
 * ## What makes it fast at a hundred thousand rows
 *
 * This component never touches an array of bookmarks. It holds a query, hands it to the
 * selection engine, and gets back an `Int32Array` of row positions; the grid windows that
 * and materialises only what it mounts. The consequence to preserve when editing: nothing
 * in this file may `map`, `filter` or `sort` the library. If a new view needs a subset, it
 * asks the engine for one.
 */
import {
  Copy,
  Download,
  Import as ImportIcon,
  Inbox,
  Keyboard,
  LayoutGrid,
  Link2,
  List,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  Trash2,
  TriangleAlert,
  Wand2,
} from "@/components/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { Bookmark, FormatFacet, SortMode, ViewMode } from "../shared/types";
import { hasPage } from "../shared/types";
import { AppSidebar } from "./components/app/app-sidebar";
import { ConnectionStatus } from "./components/app/connection-status";
import { ImportDialog } from "./components/app/import-dialog";
import { ShortcutsDialog } from "./components/app/shortcuts-dialog";
import { Welcome } from "./components/app/welcome";
import {
  AppTopbar,
  EMPTY_QUICK_FILTERS,
  type QuickFilterState,
} from "./components/app/app-topbar";
import { CommandMenu, type PaletteCommand } from "./components/app/command-menu";
import { DetailPanel } from "./components/app/detail-panel";
import {
  AddBookmarkDialog,
  EditBookmarkDialog,
  FolderPickerDialog,
  SmartCollectionDialog,
  TextPromptDialog,
} from "./components/app/dialogs";
import { LibraryView, useInitialPrefetch } from "./components/app/library-view";
import { SelectionBar } from "./components/app/selection-bar";
import { JobBar, SettingsDialog, type SettingsTab } from "./components/app/settings-dialog";
import type { ItemActions } from "./components/app/item-actions";
import { ConfirmHost, confirm } from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { Empty } from "./components/ui/empty";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { useLibrary } from "./hooks/useLibrary";
import { useAppSafeguards } from "./hooks/useAppSafeguards";
import { useRuntime } from "./hooks/useRuntime";
import { useTheme } from "./hooks/useTheme";
import { materialise, select, type Scope } from "./lib/engine";
import { expandQuery } from "./lib/fuzzy";
import { parseQuery } from "./lib/query";
import { routeKey, useRouter } from "./lib/router";
import { createSmartCollection, smartCounts } from "./lib/smart";
import { cn, shortcut } from "./lib/utils";
import { MATCH_STRENGTH } from "./lib/visual";
import { SOURCE_BY_ID, detectInput, detectSources } from "./lib/import";
import { sampleBookmarksFile } from "./lib/sample";
import { canonicalUrl } from "./lib/text";
import { pastedLink } from "./lib/url-input";
import { buildSharePage } from "./lib/share";
import { pictureFor } from "./components/app/media";
import { downloadFile } from "./lib/utils";

/** Board dots, from the system's categorical family (accent first). */
const BOARD_COLORS = ["#2a78d6", "#d03b3b", "#2f8f5b", "#b8791f", "#7c5cd6", "#2e8f82", "#c2477f"];

const SCOPE_TITLES: Record<Scope, string> = {
  all: "All bookmarks",
  recent: "Recently added",
  review: "Needs review",
  favorites: "Favourites",
  duplicates: "Duplicates",
  untagged: "Untagged",
  archived: "Archived",
  cleanup: "Cleanup",
  trash: "Trash",
};

/**
 * Compiles the checkbox filters into query text.
 *
 * They become the *same* string a person could have typed, so there is one filter model
 * rather than two that have to be kept in step. Appended rather than merged into the
 * parsed object, because the parser is the only thing that should know what `is:dead`
 * means.
 */
function quickFilterQuery(state: QuickFilterState): string {
  const parts: string[] = [];
  if (state.favorite) parts.push("is:favorite");
  if (state.untagged) parts.push("is:untagged");
  if (state.neverVisited) parts.push("is:unvisited");
  if (state.duplicates) parts.push("is:duplicate");
  if (state.dead) parts.push("is:dead");
  if (state.unchecked) parts.push("is:unchecked");
  if (state.offline) parts.push("has:offline");
  return parts.join(" ");
}

export default function App() {
  const library = useLibrary();
  const { theme, preference: themePreference, setPreference: setThemePreference, toggleTheme } = useTheme();
  const runtime = useRuntime();
  useAppSafeguards({ itemCount: library.facets.total });
  const { route, navigate } = useRouter();

  /* ------------------------------------------------------------ view state */

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [quickFilters, setQuickFilters] = useState<QuickFilterState>(EMPTY_QUICK_FILTERS);
  const [view, setView] = useState<ViewMode>("gallery");
  const [sort, setSort] = useState<SortMode>("recent");
  const [format, setFormat] = useState<FormatFacet>("all");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  /* dialogs */
  const [showAdd, setShowAdd] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [folderPickerFor, setFolderPickerFor] = useState<string[] | null>(null);
  const [tagPromptFor, setTagPromptFor] = useState<string[] | null>(null);
  const [smartDialog, setSmartDialog] = useState<{ collection: typeof library.smart[number] | null } | null>(
    null,
  );
  const [prompt, setPrompt] = useState<{
    title: string;
    label: string;
    value: string;
    confirmLabel?: string;
    onSubmit: (value: string) => void;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);

  /* ---------------------------------------------------------- preferences */

  const {
    settings,
    updateSettings,
    index,
    facets,
    textIndex,
    vocabulary,
    folders,
    folderPaths,
    boards,
    smart,
    sources,
    imports,
  } = library;

  /*
   * The saved defaults are applied once, after settings have actually loaded.
   *
   * Guarded by a ref rather than by a dependency list: `settings` arrives asynchronously
   * and then changes on every toggle, and re-applying the defaults on each of those would
   * make the view controls unusable.
   */
  const appliedDefaults = useRef(false);
  useEffect(() => {
    if (appliedDefaults.current || library.loading) return;
    appliedDefaults.current = true;
    if (settings.rememberView) {
      setView(settings.defaultView);
      setSort(settings.defaultSort);
    }
  }, [library.loading, settings.rememberView, settings.defaultView, settings.defaultSort]);

  /** The motion switch, applied to the document so CSS animations obey it too. */
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "reduce-motion",
        settings.reduceMotion || media.matches,
      );
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.reduceMotion]);

  /**
   * Search is debounced into the query, never into the input.
   *
   * Typing must never wait on a selection pass, and a selection pass must never run per
   * character. Zero disables the timer entirely, which is a legitimate choice on a small
   * library.
   */
  useEffect(() => {
    const delay = settings.searchDebounceMs;
    if (!delay) {
      setDebouncedSearch(search);
      return;
    }
    const timer = setTimeout(() => setDebouncedSearch(search), delay);
    return () => clearTimeout(timer);
  }, [search, settings.searchDebounceMs]);

  /* ------------------------------------------------------------- the query */

  const parsed = useMemo(() => {
    const text = [debouncedSearch, quickFilterQuery(quickFilters)].filter(Boolean).join(" ");
    const query = parseQuery(text);
    if (!query.terms.length) return query;
    // Spelling correction against the library's own vocabulary, reported to the user
    // rather than applied silently — finding nothing and not being told why is worse than
    // finding nothing.
    const expanded = expandQuery(query.terms, vocabulary);
    return { ...query, terms: expanded.terms, corrections: expanded.corrections };
  }, [debouncedSearch, quickFilters, vocabulary]);

  const activeSmart = route.kind === "smart" ? smart.find((entry) => entry.id === route.id) : null;
  const smartRule = useMemo(
    () => (activeSmart ? parseQuery(activeSmart.query) : null),
    [activeSmart],
  );

  const lookalikeOf = useMemo(() => {
    if (route.kind !== "lookalike") return null;
    const position = index.byId.get(route.id);
    return position === undefined ? null : index.rows[position];
  }, [route, index]);

  /**
   * The result of the current view, as row positions.
   *
   * This is the one expensive call per keystroke and it is a linear pass over typed
   * arrays. Everything downstream — the count, the grid, "select all", export — reads this
   * array rather than re-deriving anything.
   */
  const { positions } = useMemo(
    () =>
      select(index, folders, textIndex, {
        query: parsed,
        rule: smartRule,
        scope: route.kind === "scope" ? route.scope : "all",
        folderId: route.kind === "folder" ? route.id : null,
        tag: route.kind === "tag" ? route.tag : null,
        category: route.kind === "category" ? route.name : null,
        boardId: route.kind === "board" ? route.id : null,
        importId: route.kind === "import" ? route.id : null,
        sourceId: route.kind === "source" ? route.id : null,
        format,
        sort: parsed.terms.length && sort === "recent" ? "relevance" : sort,
        lookalikeOf,
        lookalikeStrength: settings.lookalikeStrength,
      }),
    [index, folders, textIndex, parsed, smartRule, route, format, sort, lookalikeOf, settings.lookalikeStrength],
  );

  const smartTotals = useMemo(
    () => smartCounts(smart, { index, folders, textIndex }),
    [smart, index, folders, textIndex],
  );

  useInitialPrefetch(index, positions, settings.previewDevice, settings.showScreenshots);

  const inTrash = route.kind === "scope" && route.scope === "trash";

  /* ------------------------------------------------------------- selection */

  /**
   * Navigating clears the selection and the search.
   *
   * Both are things you were doing *here*; carrying them into a different folder produces
   * a view whose contents contradict what the sidebar says is selected.
   */
  const key = routeKey(route);
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    if (selection.size) setSelection(new Set());
    if (search) {
      setSearch("");
      setDebouncedSearch("");
    }
  }

  const lastClicked = useRef<string | null>(null);
  const toggleSelect = useCallback(
    (id: string, event: { shiftKey: boolean }) => {
      setSelection((current) => {
        const next = new Set(current);
        /*
         * Shift extends from the last click, in *view order*.
         *
         * View order rather than insertion order, because the range somebody means is the
         * one they can see. Resolved through the position array, so it costs a scan of the
         * result rather than of the library.
         */
        if (event.shiftKey && lastClicked.current && lastClicked.current !== id) {
          const from = positions.indexOf(index.byId.get(lastClicked.current) ?? -1);
          const to = positions.indexOf(index.byId.get(id) ?? -1);
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from];
            for (let cursor = start; cursor <= end; cursor += 1) {
              next.add(index.rows[positions[cursor]].id);
            }
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        lastClicked.current = id;
        return next;
      });
    },
    [positions, index],
  );

  const selectedRows = useMemo(() => {
    if (!selection.size) return [];
    const rows: Bookmark[] = [];
    for (const id of selection) {
      const position = index.byId.get(id);
      if (position !== undefined) rows.push(index.rows[position]);
    }
    return rows;
  }, [selection, index]);

  const selectAll = useCallback(() => {
    const next = new Set<string>();
    // Capped: "select all" over 80,000 rows is a gesture whose next action is almost always
    // destructive, and a Set of that size makes every card re-render on each mutation.
    const limit = Math.min(positions.length, 5000);
    for (let cursor = 0; cursor < limit; cursor += 1) next.add(index.rows[positions[cursor]].id);
    setSelection(next);
    if (positions.length > limit) {
      toast(`Selected the first ${limit.toLocaleString()}`, {
        description: "Narrow the view further to act on the rest.",
      });
    }
  }, [positions, index]);

  /** Where the open bookmark sits in the current results (-1 when it is not in them). */
  const detailIndex = useMemo(
    () => (detailId ? positions.indexOf(index.byId.get(detailId) ?? -1) : -1),
    [detailId, positions, index],
  );

  const detail = useMemo(() => {
    if (!detailId) return null;
    const position = index.byId.get(detailId);
    return position === undefined ? null : index.rows[position];
  }, [detailId, index]);

  /* --------------------------------------------------------------- actions */

  const openBookmark = useCallback(
    (bookmark: Bookmark) => {
      if (!hasPage(bookmark)) {
        setDetailId(bookmark.id);
        return;
      }
      window.open(bookmark.url, "_blank", "noopener,noreferrer");
      library.recordVisit(bookmark.id);
    },
    [library],
  );

  const confirmDestructive = useCallback(
    async (title: string, description: string, confirmLabel: string) => {
      if (!settings.confirmDeletes) return true;
      return confirm({ title, description, confirmLabel, destructive: true });
    },
    [settings.confirmDeletes],
  );

  const actions = useMemo<ItemActions>(
    () => ({
      open: openBookmark,
      copyLink: (bookmark) => {
        void navigator.clipboard.writeText(bookmark.url).then(
          () => toast.success("Link copied"),
          () => toast.error("Could not copy the link"),
        );
      },
      edit: (bookmark) => setEditing(bookmark),
      toggleFavorite: (ids, next) => library.setFavorites(ids, next),
      setArchived: (ids, next) => library.setArchived(ids, next),
      trash: async (ids) => {
        const ok = await confirmDestructive(
          `Move ${ids.length.toLocaleString()} to the trash?`,
          "They stay recoverable until the trash is emptied.",
          "Move to trash",
        );
        if (!ok) return;
        library.trashBookmarks(ids);
        setSelection(new Set());
        if (detailId && ids.includes(detailId)) setDetailId(null);
      },
      restore: (ids) => {
        library.restoreFromTrash(ids);
        setSelection(new Set());
      },
      deleteForever: async (ids) => {
        const ok = await confirmDestructive(
          `Delete ${ids.length.toLocaleString()} permanently?`,
          "This cannot be undone, and any stored images go with them.",
          "Delete forever",
        );
        if (!ok) return;
        library.removeBookmarks(ids);
        setSelection(new Set());
      },
      moveToFolder: (ids, folderId) => library.moveToFolder(ids, folderId),
      chooseFolder: (ids) => setFolderPickerFor(ids),
      setBoard: (ids, boardId, member) => library.setBoardMembership(ids, boardId, member),
      addTag: (ids) => setTagPromptFor(ids),
      refreshShot: (bookmark) => void library.refreshShot(bookmark),
      saveOffline: (bookmark) => void library.saveOfflineCopy(bookmark),
      openOffline: (bookmark) => void library.openOfflineCopy(bookmark),
      showSimilar: (bookmark) => navigate({ kind: "lookalike", id: bookmark.id }),
    }),
    [openBookmark, library, confirmDestructive, detailId, navigate],
  );

  /** The title of a live bookmark with this address, for the Add dialog's duplicate check. */
  const findExisting = useCallback(
    (url: string) => {
      const key = canonicalUrl(url);
      for (const row of index.rows) {
        if (!row.trashedAt && row.url && canonicalUrl(row.url) === key) return row.title || row.url;
      }
      return null;
    },
    [index],
  );

  /* --------------------------------------------------------------- imports */

  const openImport = useCallback((file: File | null) => {
    setImportFile(file);
    setImportOpen(true);
  }, []);

  const sampleBatch = library.imports.find((batch) => batch.name === "Sample library" && batch.liveCount > 0);

  /** The sample library goes through the real import pipeline, as its own removable batch. */
  const loadSample = useCallback(async () => {
    const source = SOURCE_BY_ID.get("html") ?? SOURCE_BY_ID.get("chrome");
    if (!source) return;
    const already = library.imports.find((batch) => batch.name === "Sample library" && batch.liveCount > 0);
    if (already) {
      toast("The sample library is already loaded", {
        description: "Remove it from Imports in the sidebar first if you want a fresh copy.",
        action: { label: "Show it", onClick: () => navigate({ kind: "import", id: already.id }) },
      });
      return;
    }
    setLoadingSample(true);
    try {
      await library.importFile({
        file: sampleBookmarksFile(),
        // Its own standing source, so the sidebar says "Sample library" rather than "Bookmarks HTML".
        source: { ...source, id: "sample", name: "Sample library" },
        mode: "merge",
        keepDuplicates: true,
        label: "Sample library",
      });
      navigate({ kind: "scope", scope: "all" });
    } finally {
      setLoadingSample(false);
    }
  }, [library, navigate]);

  /** One self-contained HTML page of a set of bookmarks, pictures inlined. */
  const sharePage = useCallback(
    async (rows: Bookmark[], pageTitle: string) => {
      const list = rows.filter((row) => !row.trashedAt).slice(0, 2000);
      if (!list.length) {
        toast("Nothing to share in this view");
        return;
      }
      const id = toast.loading(`Building a page of ${list.length.toLocaleString()}…`);
      try {
        const html = await buildSharePage(list, {
          title: pageTitle,
          withImages: settings.showScreenshots,
          assetKeyFor: (row) => pictureFor(row, settings.previewDevice).key,
        });
        const slug = pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bookmarks";
        downloadFile(html, `${slug}.html`, "text/html");
        toast.success("Page saved", { id, description: "One file, pictures included. It opens in any browser, offline." });
      } catch {
        toast.error("Could not build the page", { id });
      }
    },
    [settings.showScreenshots, settings.previewDevice],
  );

  /* ------------------------------------------------------------- shortcuts */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      const mod = event.metaKey || event.ctrlKey;

      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowPalette(true);
        return;
      }
      if (mod && event.key === ",") {
        event.preventDefault();
        setShowSettings(true);
        return;
      }
      if (mod && event.key.toLowerCase() === "z") {
        if (typing) return;
        event.preventDefault();
        if (event.shiftKey) library.redo();
        else library.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === "a" && !typing) {
        event.preventDefault();
        selectAll();
        return;
      }
      if (typing || mod) return;

      if (event.key === "Escape") {
        if (selection.size) {
          setSelection(new Set());
          return;
        }
        if (detailId) setDetailId(null);
        return;
      }

      // Step through the results while the detail panel is open: ←/→ or J/K, like a reader.
      if (detailId && ["ArrowLeft", "ArrowRight", "j", "k", "J", "K"].includes(event.key)) {
        const here = positions.indexOf(index.byId.get(detailId) ?? -1);
        if (here !== -1) {
          const step = event.key === "ArrowRight" || event.key.toLowerCase() === "j" ? 1 : -1;
          const next = here + step;
          if (next >= 0 && next < positions.length) {
            event.preventDefault();
            setDetailId(index.rows[positions[next]].id);
          }
        }
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        setShowShortcuts(true);
        return;
      }

      const targets = selection.size ? [...selection] : detailId ? [detailId] : [];
      if (!targets.length) {
        // View shortcuts work with nothing selected, which is when they are useful.
        if (event.key === "1") setView("gallery");
        if (event.key === "2") setView("moodboard");
        if (event.key === "3") setView("list");
        if (event.key.toLowerCase() === "n") {
          event.preventDefault();
          setShowAdd(true);
        }
        if (event.key.toLowerCase() === "i") {
          event.preventDefault();
          openImport(null);
        }
        return;
      }

      switch (event.key.toLowerCase()) {
        case "f":
          event.preventDefault();
          library.setFavorites(targets, !selectedRows.every((row) => row.favorite));
          break;
        case "a":
          event.preventDefault();
          library.setArchived(targets, !selectedRows.every((row) => row.archived));
          break;
        case "t":
          event.preventDefault();
          setTagPromptFor(targets);
          break;
        case "m":
          event.preventDefault();
          setFolderPickerFor(targets);
          break;
        case "e":
          if (detail) {
            event.preventDefault();
            setEditing(detail);
          }
          break;
        case "backspace":
        case "delete":
          event.preventDefault();
          void actions.trash(targets);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [library, selection, detailId, detail, selectedRows, selectAll, actions, openImport, positions, index]);

  /* ------------------------------------------------------------- pasting */

  /**
   * Paste anywhere (outside a text field) to save: a link opens Add with it filled in, a
   * picture or video is saved directly. Text fields keep their normal paste.
   */
  const [pastedUrl, setPastedUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (document.querySelector("[role=dialog]")) return;
      const files = [...(event.clipboardData?.files ?? [])].filter(
        (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
      );
      if (files.length) {
        event.preventDefault();
        void library.uploadFiles(files);
        return;
      }
      const link = pastedLink(event.clipboardData?.getData("text/plain") ?? "");
      if (link) {
        event.preventDefault();
        setPastedUrl(link);
        setShowAdd(true);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [library]);

  /* ------------------------------------------------------- drag and drop -- */

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget) return;
      setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      setDragging(false);

      // Pictures and video are added directly; anything else is offered to the importer,
      // which detects the source (a browser export, Pocket CSV, a backup…) and previews it.
      const media = files.filter(
        (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
      );
      const others = files.filter((file) => !media.includes(file));
      if (media.length) void library.uploadFiles(media);
      if (others.length) {
        const [first] = others;
        const known = detectSources(detectInput(first.name, "", first.size)).length > 0 || /\.(html?|json|csv|txt|enex|plist|zip)$/i.test(first.name);
        if (known) openImport(first);
        else toast.error("That file type is not one this app can read", { description: first.name });
        if (others.length > 1) toast("One file at a time", { description: `Opened “${first.name}” — drop the others after.` });
      }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [library]);

  /* ----------------------------------------------------------- the heading */

  const title = useMemo(() => {
    switch (route.kind) {
      case "scope":
        return SCOPE_TITLES[route.scope];
      case "folder":
        return folderPaths.get(route.id) ?? "Folder";
      case "tag":
        return `#${route.tag}`;
      case "category":
        return route.name;
      case "board":
        return boards.find((board) => board.id === route.id)?.name ?? "Board";
      case "import":
        return imports.find((batch) => batch.id === route.id)?.name ?? "Import";
      case "source":
        return sources.find((entry) => entry.id === route.id)?.name ?? "Source";
      case "smart":
        return activeSmart?.name ?? "Collection";
      case "lookalike":
        return lookalikeOf ? `Looks like “${lookalikeOf.title}”` : "Look-alikes";
    }
  }, [route, folderPaths, boards, imports, sources, activeSmart, lookalikeOf]);

  useEffect(() => {
    document.title = `${title} · Bookmark Studio`;
  }, [title]);

  /* -------------------------------------------------------- palette commands */

  const commands = useMemo<PaletteCommand[]>(() => {
    const viewRows = () => materialise(index, positions);
    return [
      {
        id: "add",
        label: "Add a link",
        icon: <Plus />,
        group: "Actions",
        shortcut: "N",
        run: () => setShowAdd(true),
      },
      {
        id: "import",
        label: "Import bookmarks…",
        icon: <ImportIcon />,
        group: "Actions",
        shortcut: "I",
        run: () => openImport(null),
      },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        icon: <Keyboard />,
        group: "View",
        shortcut: "?",
        run: () => setShowShortcuts(true),
      },
      {
        id: "export-html",
        label: "Export as bookmarks HTML",
        icon: <Download />,
        group: "Actions",
        run: () => library.exportLibrary(undefined, "html"),
      },
      {
        id: "export-json",
        label: "Export a full backup (JSON)",
        icon: <Download />,
        group: "Actions",
        run: () => library.exportLibrary(undefined, "json"),
      },
      {
        id: "export-view",
        label: `Export these ${positions.length.toLocaleString()} as HTML`,
        icon: <Download />,
        group: "Actions",
        run: () => library.exportLibrary(viewRows(), "html"),
      },
      {
        id: "share-view",
        label: `Share these ${positions.length.toLocaleString()} as a page`,
        icon: <Download />,
        group: "Actions",
        run: () => void sharePage(viewRows(), title),
      },
      {
        id: "save-search",
        label: "Save this search as a collection",
        icon: <Sparkles />,
        group: "Actions",
        run: () => setSmartDialog({ collection: null }),
      },
      {
        id: "dedupe",
        label: "Merge duplicate links",
        icon: <Copy />,
        group: "Library",
        run: () => library.dedupeLibrary(),
      },
      {
        id: "merge-lookalikes",
        label: "Merge duplicate pictures",
        icon: <Copy />,
        group: "Library",
        run: () => library.mergeLookalikes(),
      },
      {
        id: "read-pages",
        label: "Read the pages in this view",
        icon: <Wand2 />,
        group: "Library",
        run: () => void library.runEnrichment(viewRows()),
      },
      {
        id: "check-links",
        label: "Check the links in this view",
        icon: <Link2 />,
        group: "Library",
        run: () => void library.runHealthCheck(viewRows()),
      },
      {
        id: "capture",
        label: "Capture previews for this view",
        icon: <RefreshCw />,
        group: "Library",
        run: () => void library.runCapture(viewRows()),
      },
      {
        id: "index-pictures",
        label: "Index the pictures in this view",
        icon: <Sparkles />,
        group: "Library",
        run: () => void library.runVisualIndex(viewRows()),
      },
      {
        id: "view-grid",
        label: "Switch to grid",
        icon: <LayoutGrid />,
        group: "View",
        shortcut: "1",
        run: () => setView("gallery"),
      },
      {
        id: "view-masonry",
        label: "Switch to masonry",
        icon: <LayoutGrid />,
        group: "View",
        shortcut: "2",
        run: () => setView("moodboard"),
      },
      {
        id: "view-list",
        label: "Switch to list",
        icon: <List />,
        group: "View",
        shortcut: "3",
        run: () => setView("list"),
      },
      {
        id: "toggle-images",
        label: settings.showScreenshots ? "Hide pictures (faster)" : "Show pictures",
        icon: <LayoutGrid />,
        group: "View",
        run: () => updateSettings({ showScreenshots: !settings.showScreenshots }),
      },
      {
        id: "theme",
        label: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
        icon: theme === "dark" ? <Sun /> : <Moon />,
        group: "View",
        run: toggleTheme,
      },
      {
        id: "settings",
        label: "Open settings",
        icon: <SettingsIcon />,
        group: "View",
        shortcut: shortcut("mod+,"),
        run: () => setShowSettings(true),
      },
    ];
  }, [index, positions, library, settings.showScreenshots, updateSettings, theme, toggleTheme, openImport, sharePage, title]);

  /*
    Whether to lay the page out for an empty library while it is still loading.

    The page header is hidden for an empty library (the welcome screen stands in for it). If
    loading showed the header and the library then turned out to be empty, the welcome screen
    would jump up the height of the header in front of every first-time visitor. One bit,
    remembered from the last visit, picks the right layout from the first frame.
  */
  const [expectEmpty] = useState(() => {
    try {
      return localStorage.getItem("bs:has-library") !== "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (library.loading) return;
    try {
      if (facets.total) localStorage.setItem("bs:has-library", "1");
      else localStorage.removeItem("bs:has-library");
    } catch {
      // Only a layout hint; nothing depends on it being stored.
    }
  }, [library.loading, facets.total]);
  const libraryEmpty = library.loading ? expectEmpty : !facets.total;

  /* ----------------------------------------------------------- empty state */

  const emptyState = useMemo(() => {
    if (!facets.total) {
      return (
        <Welcome
          runtime={runtime}
          browserSync={settings.browserSync}
          loadingSample={loadingSample}
          onImport={() => openImport(null)}
          onSample={() => void loadSample()}
          onAdd={() => setShowAdd(true)}
          onEnableSync={() => void library.setBrowserSync(true)}
          onConnections={() => {
            setSettingsTab("connections");
            setShowSettings(true);
          }}
        />
      );
    }
    if (search || parsed.chips.length) {
      return (
        <Empty
          icon={<Search />}
          title={`Nothing matches “${search || "that filter"}”`}
          description="Try fewer words, or clear the filters. Operators like tag:, site:, is:dead and has:offline all work here."
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSearch("");
                setDebouncedSearch("");
                setQuickFilters(EMPTY_QUICK_FILTERS);
                setFormat("all");
              }}
            >
              Clear search and filters
            </Button>
          }
        />
      );
    }
    if (inTrash) {
      return (
        <Empty icon={<Trash2 />} title="The trash is empty" description="Deleted items land here first." />
      );
    }
    if (route.kind === "scope" && route.scope === "duplicates") {
      return (
        <Empty
          icon={<Copy />}
          title="No duplicates"
          description="Nothing in the library shares a URL with anything else."
        />
      );
    }
    if (route.kind === "scope" && route.scope === "review") {
      return (
        <Empty
          icon={<TriangleAlert />}
          title="Every link responded"
          description="Nothing is dead, blocked or redirected as of the last check."
        />
      );
    }
    if (route.kind === "lookalike") {
      return (
        <Empty
          icon={<Copy />}
          title="Nothing looks like this"
          description={`No other picture matches at the “${MATCH_STRENGTH[settings.lookalikeStrength].label}” threshold. Index more pictures from Settings → Background.`}
        />
      );
    }
    return (
      <Empty
        icon={<Inbox />}
        title="Nothing here yet"
        description="This place has no bookmarks in it. Move some in from the grid, or add one."
        actions={
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
            <Plus /> Add a link
          </Button>
        }
      />
    );
  }, [facets.total, search, parsed.chips.length, inTrash, route, settings.lookalikeStrength, settings.browserSync, runtime, loadingSample, openImport, loadSample, library]);

  /* ----------------------------------------------------------------- render */

  /**
   * How much the background pipeline still has to do, as one number.
   *
   * `pending` is per-pass — screenshots, page reads, link checks, picture indexing,
   * offline copies — and the toolbar wants the total. Summed here rather than in the
   * pipeline because the split is genuinely useful elsewhere (a pass can be off).
   */
  const pipelineBusy = library.pipeline.running;
  const pipelinePending = useMemo(
    () => Object.values(library.pipeline.pending).reduce((sum, count) => sum + count, 0),
    [library.pipeline.pending],
  );

  const openConnections = () => {
    setSettingsTab("connections");
    setShowSettings(true);
  };

  return (
    <TooltipProvider>
      <a
        href="#library-results"
        className="bs-skip"
        onClick={(event) => {
          // Move focus without touching the hash, which holds the current place.
          event.preventDefault();
          document.getElementById("library-results")?.focus();
        }}
      >
        Skip to bookmarks
      </a>
      <div className="bs-shell">
        {/* --------------------------------------------------------- rail */}
        <aside className={cn("bs-sidebar", navOpen && "is-open")}>
          <AppSidebar
            route={route}
            navigate={(next) => {
              navigate(next);
              setNavOpen(false);
            }}
            facets={facets}
            folders={folders}
            folderPaths={folderPaths}
            boards={boards}
            smart={smart}
            smartCounts={smartTotals}
            sources={sources}
            imports={imports}
            hydrating={library.hydrating}
            footer={
              <ConnectionStatus
                runtime={runtime}
                busy={pipelineBusy ? pipelinePending : 0}
                onOpen={openConnections}
                onImport={() => openImport(null)}
              />
            }
            onCreateFolder={(parentId) =>
              setPrompt({
                title: "New folder",
                label: "Name",
                value: "",
                confirmLabel: "Create",
                onSubmit: (value) => library.createFolder(value, parentId),
              })
            }
            onRenameFolder={(folder) =>
              setPrompt({
                title: "Rename folder",
                label: "Name",
                value: folder.name,
                onSubmit: (value) => library.renameFolder(folder.id, value),
              })
            }
            onDeleteFolder={async (folder) => {
              const ok = await confirmDestructive(
                `Delete “${folder.name}”?`,
                "Bookmarks inside it move up a level; subfolders are removed.",
                "Delete folder",
              );
              if (ok) library.deleteFolder(folder.id);
            }}
            onCreateBoard={() =>
              setPrompt({
                title: "New board",
                label: "Name",
                value: "",
                confirmLabel: "Create",
                onSubmit: (value) =>
                  library.createBoard(value, BOARD_COLORS[boards.length % BOARD_COLORS.length]),
              })
            }
            onRenameBoard={(board) =>
              setPrompt({
                title: "Rename board",
                label: "Name",
                value: board.name,
                onSubmit: (value) => library.renameBoard(board.id, value),
              })
            }
            onDeleteBoard={async (board) => {
              const ok = await confirmDestructive(
                `Delete the board “${board.name}”?`,
                "The bookmarks on it are kept; only the board goes.",
                "Delete board",
              );
              if (ok) library.removeBoard(board.id);
            }}
            onEditSmart={(collection) => setSmartDialog({ collection })}
            onDeleteSmart={async (collection) => {
              const ok = await confirmDestructive(
                `Delete “${collection.name}”?`,
                "The bookmarks it matched are untouched — a collection is only a saved search.",
                "Delete collection",
              );
              if (ok) library.deleteSmart(collection.id);
            }}
            onRenameSource={(source) =>
              setPrompt({
                title: "Rename source",
                label: "Name",
                value: source.name,
                onSubmit: (value) => library.renameSource(source.id, value),
              })
            }
            onForgetSource={async (source) => {
              const ok = await confirmDestructive(
                `Forget “${source.name}”?`,
                `The ${source.count.toLocaleString()} items it brought in are kept — they simply stop being attributed to it.`,
                "Forget source",
              );
              if (ok) library.forgetSource(source.id);
            }}
            onRenameImport={(batch) =>
              setPrompt({
                title: "Rename import",
                label: "Name",
                value: batch.name,
                onSubmit: (value) => library.renameImport(batch.id, value),
              })
            }
            onDeleteImport={async (batch) => {
              const ok = await confirmDestructive(
                `Remove the “${batch.name}” import?`,
                "Every bookmark it brought in is deleted. You can undo this.",
                "Remove import",
              );
              if (ok) await library.deleteImport(batch.id);
            }}
          />
        </aside>
        <div className={cn("bs-drawer-scrim", navOpen && "is-open")} onClick={() => setNavOpen(false)} aria-hidden />

        {/* --------------------------------------------------------- main */}
        <main className="bs-main">
          <AppTopbar
            title={title}
            total={positions.length}
            hydrating={library.hydrating}
            libraryEmpty={libraryEmpty}
            status={
              pipelineBusy && pipelinePending ? (
                <span className="inline-flex items-center gap-1">filling in {pipelinePending.toLocaleString()}</span>
              ) : undefined
            }
            search={search}
            onSearch={setSearch}
            view={view}
            onView={setView}
            sort={sort}
            onSort={setSort}
            format={format}
            onFormat={setFormat}
            showImages={settings.showScreenshots}
            onShowImages={(value) => updateSettings({ showScreenshots: value })}
            filters={parsed.filters}
            quickFilters={quickFilters}
            onQuickFilter={(patch) => setQuickFilters((current) => ({ ...current, ...patch }))}
            canUndo={library.canUndo}
            canRedo={library.canRedo}
            onUndo={library.undo}
            onRedo={library.redo}
            onAdd={() => setShowAdd(true)}
            onImport={() => openImport(null)}
            onExport={() => {
              setSettingsTab("data");
              setShowSettings(true);
            }}
            onSettings={() => setShowSettings(true)}
            onShortcuts={() => setShowShortcuts(true)}
            onOpenPalette={() => setShowPalette(true)}
            onToggleSidebar={() => setNavOpen((value) => !value)}
            theme={theme}
            themePreference={themePreference}
            onThemePreference={setThemePreference}
            corrections={parsed.corrections}
            chips={parsed.chips}
            onClearQuery={() => {
              setSearch("");
              setDebouncedSearch("");
            }}
          />

          <div className="bs-content" id="library-results" tabIndex={-1}>
            <LibraryView
              index={index}
              positions={positions}
              view={view}
              device={settings.previewDevice}
              showImages={settings.showScreenshots}
              loading={library.loading}
              selection={selection}
              onToggleSelect={toggleSelect}
              onOpenDetail={(bookmark) => setDetailId(bookmark.id)}
              actions={actions}
              folders={folders}
              boards={boards}
              folderPaths={folderPaths}
              inTrash={inTrash}
              scrollKey={`${key}|${view}|${sort}|${format}|${debouncedSearch}`}
              empty={emptyState}
              header={
                inTrash && facets.trashed ? (
                  <div className="bs-banner is-danger">
                    <Trash2 />
                    <p className="flex-1">
                      {facets.trashed.toLocaleString()} item{facets.trashed === 1 ? "" : "s"} waiting to be deleted.
                    </p>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Empty the trash?",
                          description: `${facets.trashed.toLocaleString()} items and their stored images will be deleted permanently. This cannot be undone.`,
                          confirmLabel: "Empty trash",
                          destructive: true,
                        });
                        if (ok) await library.emptyTrash();
                      }}
                    >
                      Empty trash
                    </Button>
                  </div>
                ) : undefined
              }
            />
          </div>
        </main>
      </div>

      {/* ----------------------------------------------------------- layers */}

      <SelectionBar
        targets={selectedRows}
        total={positions.length}
        actions={actions}
        folders={folders}
        boards={boards}
        folderPaths={folderPaths}
        inTrash={inTrash}
        onSelectAll={selectAll}
        onClear={() => setSelection(new Set())}
        reduceMotion={settings.reduceMotion}
      />

      <DetailPanel
        bookmark={detail}
        open={Boolean(detail)}
        onOpenChange={(open) => !open && setDetailId(null)}
        device={settings.previewDevice}
        folders={folders}
        boards={boards}
        folderPaths={folderPaths}
        onOpen={openBookmark}
        onToggleFavorite={library.toggleFavorite}
        onSetNote={library.setNote}
        onSetAlt={library.setAltText}
        onAddTag={(ids, tag) => library.addTags(ids, [tag])}
        onRemoveTag={(ids, tag) => library.removeTag(ids, tag)}
        onEdit={setEditing}
        onTrash={(ids) => void actions.trash(ids)}
        onRefreshShot={(bookmark) => void library.refreshShot(bookmark)}
        onSaveOffline={(bookmark) => void library.saveOfflineCopy(bookmark)}
        onOpenOffline={(bookmark) => void library.openOfflineCopy(bookmark)}
        onAddHighlight={library.addHighlight}
        onRemoveHighlight={library.removeHighlight}
        onNavigateTag={(tag) => {
          setDetailId(null);
          navigate({ kind: "tag", tag });
        }}
        onNavigateFolder={(id) => {
          setDetailId(null);
          navigate({ kind: "folder", id });
        }}
        onShowSimilar={(bookmark) => {
          setDetailId(null);
          navigate({ kind: "lookalike", id: bookmark.id });
        }}
        position={detailIndex >= 0 ? `${(detailIndex + 1).toLocaleString()} of ${positions.length.toLocaleString()}` : undefined}
        hasPrev={detailIndex > 0}
        hasNext={detailIndex >= 0 && detailIndex < positions.length - 1}
        onStep={(direction) => {
          const next = detailIndex + direction;
          if (detailIndex >= 0 && next >= 0 && next < positions.length) setDetailId(index.rows[positions[next]].id);
        }}
      />

      <CommandMenu
        open={showPalette}
        onOpenChange={setShowPalette}
        index={index}
        textIndex={textIndex}
        vocabulary={vocabulary}
        folders={folders}
        folderPaths={folderPaths}
        boards={boards}
        smart={smart}
        sources={sources}
        tags={facets.tags}
        navigate={navigate}
        onOpenBookmark={openBookmark}
        onOpenDetail={(bookmark) => setDetailId(bookmark.id)}
        commands={commands}
      />

      <ImportDialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) setImportFile(null);
        }}
        initialFile={importFile}
        keepDuplicatesDefault={settings.keepDuplicatesOnImport}
        onBackup={() => library.exportLibrary(undefined, "json")}
        onRemoveSample={sampleBatch ? () => library.deleteImport(sampleBatch.id) : undefined}
        onPreview={library.previewImport}
        onImport={library.importFile}
      />

      <AddBookmarkDialog
        open={showAdd}
        onOpenChange={(open) => {
          setShowAdd(open);
          if (!open) setPastedUrl(undefined);
        }}
        folders={folders}
        folderPaths={folderPaths}
        defaultFolderId={route.kind === "folder" ? route.id : null}
        initialUrl={pastedUrl}
        findExisting={findExisting}
        onSubmit={(input) => library.addBookmark(input)}
      />

      <EditBookmarkDialog
        bookmark={editing}
        onOpenChange={(open) => !open && setEditing(null)}
        folders={folders}
        folderPaths={folderPaths}
        onSubmit={library.updateBookmark}
      />

      <FolderPickerDialog
        open={Boolean(folderPickerFor)}
        onOpenChange={(open) => !open && setFolderPickerFor(null)}
        folders={folders}
        folderPaths={folderPaths}
        count={folderPickerFor?.length ?? 0}
        onPick={(folderId) => {
          if (folderPickerFor) library.moveToFolder(folderPickerFor, folderId);
          setFolderPickerFor(null);
        }}
        onCreate={async (name) => {
          const folder = await library.createFolder(name, null);
          if (folderPickerFor) library.moveToFolder(folderPickerFor, folder.id);
          setFolderPickerFor(null);
        }}
      />

      <TextPromptDialog
        open={Boolean(tagPromptFor)}
        onOpenChange={(open) => !open && setTagPromptFor(null)}
        title={`Tag ${tagPromptFor?.length.toLocaleString() ?? 0} bookmark${tagPromptFor?.length === 1 ? "" : "s"}`}
        description="Separate several tags with commas."
        label="Tags"
        placeholder="design, reference"
        confirmLabel="Add tags"
        onSubmit={(value) => {
          if (tagPromptFor) library.addTags(tagPromptFor, value.split(","));
          setTagPromptFor(null);
        }}
      />

      <TextPromptDialog
        open={Boolean(prompt)}
        onOpenChange={(open) => !open && setPrompt(null)}
        title={prompt?.title ?? ""}
        label={prompt?.label ?? ""}
        initialValue={prompt?.value ?? ""}
        confirmLabel={prompt?.confirmLabel}
        onSubmit={(value) => {
          prompt?.onSubmit(value);
          setPrompt(null);
        }}
      />

      <SmartCollectionDialog
        open={Boolean(smartDialog)}
        onOpenChange={(open) => !open && setSmartDialog(null)}
        collection={smartDialog?.collection ?? null}
        initialQuery={[debouncedSearch, quickFilterQuery(quickFilters)].filter(Boolean).join(" ")}
        onSubmit={({ name, query, color }) => {
          if (smartDialog?.collection) {
            library.updateSmart(smartDialog.collection.id, { name, query, color });
          } else {
            const collection = createSmartCollection(name, query, color);
            library.createSmart(collection);
            navigate({ kind: "smart", id: collection.id });
          }
          setSmartDialog(null);
        }}
      />

      <SettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        tab={settingsTab}
        onTab={setSettingsTab}
        settings={settings}
        onChange={updateSettings}
        activity={library.activity}
        runtime={runtime}
        themePreference={themePreference}
        onThemePreference={setThemePreference}
        onBrowserSync={(enabled) => void library.setBrowserSync(enabled)}
        onImport={() => {
          setShowSettings(false);
          openImport(null);
        }}
        onLoadSample={() => {
          setShowSettings(false);
          void loadSample();
        }}
        onExport={(format) => library.exportLibrary(undefined, format)}
        onSharePage={() => void sharePage(materialise(index, positions), title)}
        onClearActivity={() => void library.clearActivityLog()}
        onReset={() => void library.resetLibrary()}
        onRunCapture={() => void library.runCapture(materialise(index, positions))}
        onRunEnrich={() => void library.runEnrichment(materialise(index, positions))}
        onRunHealth={() => void library.runHealthCheck(materialise(index, positions))}
        onRunVisual={() => void library.runVisualIndex()}
        onMergeLookalikes={() => library.mergeLookalikes()}
        onDedupe={() => library.dedupeLibrary()}
      />

      <ShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />

      {library.job.running ? (
        <JobBar
          label={library.job.label}
          done={library.job.done}
          total={library.job.total}
          failed={library.job.failed}
          onStop={library.job.cancellable === false ? undefined : library.stopJob}
        />
      ) : null}

      {dragging ? (
        <div className="bs-dropzone" aria-hidden>
          <div className="bs-dropzone-card">
            <Download />
            <p className="bs-dropzone-title">Drop to add</p>
            <p className="bs-dropzone-text">Bookmark exports, backups and CSVs open the importer. Pictures and video are added directly.</p>
          </div>
        </div>
      ) : null}

      <ConfirmHost />
      <Toaster theme={theme} />
    </TooltipProvider>
  );
}
