/**
 * The bar that appears when something is selected.
 *
 * ## Why a floating bar rather than a mode
 *
 * Bulk editing used to mean entering a "select" mode, which is a state the user has to
 * remember being in and a button they have to find to leave. Selecting is instead just
 * something you have done: click a checkbox and the bar arrives, press Escape and it goes.
 * The grid never changes shape, so nothing moves under the pointer at the moment of the
 * first click.
 *
 * ## Every action here is the same action the single-row menu offers
 *
 * It is built from the same {@link ItemActions}, so a bulk archive and a single archive
 * cannot behave differently — including their undo entries, which is where a separate bulk
 * implementation would most easily go wrong.
 */
import { AnimatePresence, motion } from "motion/react";
import {
  Archive,
  CheckCheck,
  FolderInput,
  Heart,
  MoreHorizontal,
  Tag,
  Trash2,
  X,
} from "@/components/icons";

import type { Board, Bookmark, Folder } from "@shared/types";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/ui/tooltip";
import { ItemDropdownContent, type ItemActions } from "./item-actions";

export function SelectionBar({
  targets,
  total,
  actions,
  folders,
  boards,
  folderPaths,
  inTrash,
  onSelectAll,
  onClear,
  reduceMotion,
}: {
  targets: Bookmark[];
  /** How many rows the current view holds, for "select all". */
  total: number;
  actions: ItemActions;
  folders: Folder[];
  boards: Board[];
  folderPaths: Map<string, string>;
  inTrash?: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  reduceMotion: boolean;
}) {
  const count = targets.length;
  const ids = targets.map((row) => row.id);
  const allFavorite = count > 0 && targets.every((row) => row.favorite);
  const allArchived = count > 0 && targets.every((row) => row.archived);

  return (
    <AnimatePresence>
      {count > 0 ? (
        <motion.div
          key="selection"
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
          transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          role="toolbar"
          aria-label={`${count} selected`}
          className="selbar is-visible bs-selbar"
        >
          <span className="bs-selbar-count tabular">{count.toLocaleString()} selected</span>

          {count < total ? (
            <button type="button" className="selbar-turn bs-selbar-text" onClick={onSelectAll}>
              <CheckCheck size={15} />
              Select all {total.toLocaleString()}
            </button>
          ) : null}

          <span className="selbar-sep" />

          {inTrash ? (
            <>
              <button type="button" className="selbar-turn bs-selbar-text" onClick={() => actions.restore(ids)}>
                Put back
              </button>
              <button type="button" className="selbar-turn bs-selbar-text is-danger" onClick={() => actions.deleteForever(ids)}>
                <Trash2 size={15} /> Delete forever
              </button>
            </>
          ) : (
            <>
              <Hint label={allFavorite ? "Remove from favourites" : "Add to favourites"} keys="F">
                <button type="button" className="selbar-btn" onClick={() => actions.toggleFavorite(ids, !allFavorite)} aria-label="Toggle favourite">
                  <Heart className={allFavorite ? "bs-fav" : ""} />
                </button>
              </Hint>
              <Hint label="Add a tag" keys="T">
                <button type="button" className="selbar-btn" onClick={() => actions.addTag(ids)} aria-label="Add a tag">
                  <Tag />
                </button>
              </Hint>
              <Hint label="Move to folder" keys="M">
                <button type="button" className="selbar-btn" onClick={() => actions.chooseFolder(ids)} aria-label="Move to folder">
                  <FolderInput />
                </button>
              </Hint>
              <Hint label={allArchived ? "Unarchive" : "Archive"} keys="A">
                <button type="button" className="selbar-btn" onClick={() => actions.setArchived(ids, !allArchived)} aria-label="Archive">
                  <Archive />
                </button>
              </Hint>
              <Hint label="Move to trash" keys="⌫">
                <button type="button" className="selbar-btn is-danger" onClick={() => actions.trash(ids)} aria-label="Move to trash">
                  <Trash2 />
                </button>
              </Hint>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="selbar-btn" aria-label="More actions">
                    <MoreHorizontal />
                  </button>
                </DropdownMenuTrigger>
                <ItemDropdownContent
                  align="end"
                  targets={targets}
                  actions={actions}
                  folders={folders}
                  boards={boards}
                  folderPaths={folderPaths}
                />
              </DropdownMenu>
            </>
          )}

          <span className="selbar-sep" />
          <Hint label="Clear selection" keys="Esc">
            <button type="button" className="selbar-btn" onClick={onClear} aria-label="Clear selection">
              <X />
            </button>
          </Hint>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
