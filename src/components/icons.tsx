/**
 * Icons — Hugeicons Free, "stroke rounded", and nothing else.
 *
 * The design system draws every glyph at 16 px with a 1.5 px stroke in `currentColor`, so an
 * icon always takes the colour of the control around it. Hugeicons ships its glyphs as
 * `[tag, attributes]` tuples rather than components; `<Icon>` turns one into inline SVG.
 *
 * Names here are *semantic* — what the icon means in this app ("Trash", "OpenLink") — and
 * only the glyphs named below are bundled (the bundler drops the rest of the package). To
 * add an icon, import it here and give it a name. Never mix in another icon family.
 */
import {
  Add01Icon,
  Alert02Icon,
  Archive02Icon,
  ArchiveRestoreIcon,
  ArrowDown01Icon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  ArrowUpRight01Icon,
  Bookmark02Icon,
  Calendar03Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  ChromeIcon,
  CircleIcon,
  Clock01Icon,
  CommandIcon,
  ComputerIcon,
  Copy01Icon,
  Database01Icon,
  Delete02Icon,
  Download04Icon,
  FavouriteIcon,
  File01Icon,
  FileImportIcon,
  FileUploadIcon,
  FilterHorizontalIcon,
  FlashIcon,
  Folder01Icon,
  FolderTransferIcon,
  GithubIcon,
  GlobeIcon,
  GridViewIcon,
  HardDriveIcon,
  HashtagIcon,
  HighlighterIcon,
  Image01Icon,
  ImageDownload02Icon,
  ImageNotFound01Icon,
  InboxIcon,
  InformationCircleIcon,
  KeyboardIcon,
  LanguageSkillIcon,
  Layers01Icon,
  LibraryIcon,
  Link01Icon,
  ListViewIcon,
  Loading03Icon,
  MagicWand01Icon,
  Menu01Icon,
  MinusSignIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  PackageIcon,
  PaintBoardIcon,
  PencilEdit02Icon,
  PlayIcon,
  Plug01Icon,
  PuzzleIcon,
  Redo02Icon,
  RefreshIcon,
  RotateLeft01Icon,
  RotateRight01Icon,
  Search01Icon,
  ServerStack01Icon,
  Settings02Icon,
  Shield01Icon,
  SidebarLeftIcon,
  SmartPhone01Icon,
  SortingDownIcon,
  SparklesIcon,
  Sun03Icon,
  Tablet01Icon,
  Tag01Icon,
  Tick02Icon,
  TickDouble02Icon,
  Undo02Icon,
  Unlink02Icon,
  Upload04Icon,
  Video01Icon,
  ViewIcon,
  WifiDisconnected02Icon,
} from "@hugeicons/core-free-icons";
import { createElement, memo, type SVGProps } from "react";

type IconData = readonly (readonly [string, Record<string, string | number>])[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  /** Width and height in px. Default 16 (14–15 in dense popovers, 12 for carets). */
  size?: number;
  /** Default 1.5. Checkmarks inside checkboxes use 2.4. */
  strokeWidth?: number;
}

/** Hugeicons attribute names are camelCase already, which is what React wants. */
function renderIcon(data: IconData, { size = 16, strokeWidth = 1.5, className, ...rest }: IconProps, name: string) {
  return createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      "aria-hidden": true,
      focusable: false,
      "data-icon": name,
      className: className ? `hi ${className}` : "hi",
      ...rest,
    },
    data.map(([tag, attrs], index) => {
      const { key: _key, ...props } = attrs as Record<string, string | number>;
      void _key;
      if ("strokeWidth" in props) props.strokeWidth = strokeWidth;
      return createElement(tag, { key: index, ...props });
    }),
  );
}

function make(name: string, data: unknown) {
  const Component = memo((props: IconProps) => renderIcon(data as IconData, props, name));
  Component.displayName = `Icon(${name})`;
  return Component;
}

export type IconComponent = ReturnType<typeof make>;

/* ------------------------------------------------------------ the icon set */

export const Add = make("Add", Add01Icon);
export const Plus = Add;
export const Minus = make("Minus", MinusSignIcon);
export const Warning = make("Warning", Alert02Icon);
export const Archive = make("Archive", Archive02Icon);
export const Unarchive = make("Unarchive", ArchiveRestoreIcon);
export const ChevronDown = make("ChevronDown", ArrowDown01Icon);
export const ChevronUp = make("ChevronUp", ArrowUp01Icon);
export const ChevronRight = make("ChevronRight", ArrowRight01Icon);
export const ArrowLeft = make("ArrowLeft", ArrowLeft02Icon);
export const ArrowRight = make("ArrowRight", ArrowRight02Icon);
export const ArrowUp = make("ArrowUp", ArrowUp02Icon);
export const OpenLink = make("OpenLink", ArrowUpRight01Icon);
export const Bookmark = make("Bookmark", Bookmark02Icon);
export const Boxes = make("Boxes", PackageIcon);
export const Calendar = make("Calendar", Calendar03Icon);
export const Close = make("Close", Cancel01Icon);
export const CheckCircle = make("CheckCircle", CheckmarkCircle02Icon);
export const Chrome = make("Chrome", ChromeIcon);
export const Dot = make("Dot", CircleIcon);
export const Clock = make("Clock", Clock01Icon);
export const Command = make("Command", CommandIcon);
export const Monitor = make("Monitor", ComputerIcon);
export const Copy = make("Copy", Copy01Icon);
export const Database = make("Database", Database01Icon);
export const Trash = make("Trash", Delete02Icon);
export const Export = make("Export", Download04Icon);
export const Heart = make("Heart", FavouriteIcon);
export const FileText = make("File", File01Icon);
export const Import = make("Import", FileImportIcon);
export const FileUp = make("FileUp", FileUploadIcon);
export const Filter = make("Filter", FilterHorizontalIcon);
export const Zap = make("Zap", FlashIcon);
export const Folder = make("Folder", Folder01Icon);
export const FolderMove = make("FolderMove", FolderTransferIcon);
export const Github = make("Github", GithubIcon);
export const Globe = make("Globe", GlobeIcon);
export const Grid = make("Grid", GridViewIcon);
export const HardDrive = make("HardDrive", HardDriveIcon);
export const Hash = make("Hash", HashtagIcon);
export const Highlight = make("Highlight", HighlighterIcon);
export const ImageIcon = make("Image", Image01Icon);
export const ImageDown = make("ImageDown", ImageDownload02Icon);
export const ImageOff = make("ImageOff", ImageNotFound01Icon);
export const Inbox = make("Inbox", InboxIcon);
export const Info = make("Info", InformationCircleIcon);
export const Keyboard = make("Keyboard", KeyboardIcon);
export const Languages = make("Languages", LanguageSkillIcon);
export const Layers = make("Layers", Layers01Icon);
export const Library = make("Library", LibraryIcon);
export const Link = make("Link", Link01Icon);
export const List = make("List", ListViewIcon);
export const Spinner = make("Spinner", Loading03Icon);
export const Wand = make("Wand", MagicWand01Icon);
export const Menu = make("Menu", Menu01Icon);
export const Moon = make("Moon", Moon02Icon);
export const More = make("More", MoreHorizontalIcon);
export const Palette = make("Palette", PaintBoardIcon);
export const Edit = make("Edit", PencilEdit02Icon);
export const Play = make("Play", PlayIcon);
export const Plug = make("Plug", Plug01Icon);
export const Puzzle = make("Puzzle", PuzzleIcon);
export const Redo = make("Redo", Redo02Icon);
export const Refresh = make("Refresh", RefreshIcon);
export const RotateLeft = make("RotateLeft", RotateLeft01Icon);
export const RotateRight = make("RotateRight", RotateRight01Icon);
export const Search = make("Search", Search01Icon);
export const Server = make("Server", ServerStack01Icon);
export const Settings = make("Settings", Settings02Icon);
export const Shield = make("Shield", Shield01Icon);
export const Sidebar = make("Sidebar", SidebarLeftIcon);
export const Smartphone = make("Smartphone", SmartPhone01Icon);
export const Sort = make("Sort", SortingDownIcon);
export const Sparkles = make("Sparkles", SparklesIcon);
export const Sun = make("Sun", Sun03Icon);
export const Tablet = make("Tablet", Tablet01Icon);
export const Tag = make("Tag", Tag01Icon);
export const Check = make("Check", Tick02Icon);
export const CheckAll = make("CheckAll", TickDouble02Icon);
export const Undo = make("Undo", Undo02Icon);
export const Unlink = make("Unlink", Unlink02Icon);
export const Upload = make("Upload", Upload04Icon);
export const Video = make("Video", Video01Icon);
export const Eye = make("Eye", ViewIcon);
export const WifiOff = make("WifiOff", WifiDisconnected02Icon);

/* ---------------------------------------------- names used by older modules */

export {
  Warning as AlertTriangle,
  Warning as TriangleAlert,
  Unarchive as ArchiveRestore,
  Sort as ArrowDownWideNarrow,
  OpenLink as ArrowUpRight,
  OpenLink as ExternalLink,
  Check as CheckIcon,
  CheckAll as CheckCheck,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  ChevronUp as ChevronUpIcon,
  Dot as CircleIcon,
  Grid as LayoutGrid,
  Highlight as Highlighter,
  Export as Download,
  FolderMove as FolderInput,
  ImageIcon as Image,
  Link as Link2,
  Spinner as Loader2,
  Minus as MinusIcon,
  More as MoreHorizontal,
  Edit as Pencil,
  Redo as Redo2,
  Refresh as RefreshCw,
  RotateLeft as RotateCcw,
  RotateRight as RotateCw,
  Search as SearchIcon,
  Trash as Trash2,
  Undo as Undo2,
  Wand as Wand2,
  Close as X,
  Close as XIcon,
};
