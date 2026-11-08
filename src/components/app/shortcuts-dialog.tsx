/**
 * The keyboard sheet (`.shortcuts` in the design system): two columns of groups, each a
 * label on the left and `<kbd>` chips on the right, one column on phones. Opened with `?`.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { shortcutParts } from "@/lib/utils";

const GROUPS: { title: string; rows: { label: string; keys: string[] }[] }[] = [
  {
    title: "Anywhere",
    rows: [
      { label: "Search and commands", keys: ["mod+K"] },
      { label: "Focus the search box", keys: ["/"] },
      { label: "Add a link", keys: ["N"] },
      { label: "Import bookmarks", keys: ["I"] },
      { label: "Save a copied link or picture", keys: ["mod+V"] },
      { label: "Settings", keys: ["mod+,"] },
      { label: "Undo / redo", keys: ["mod+Z", "mod+shift+Z"] },
      { label: "This sheet", keys: ["?"] },
    ],
  },
  {
    title: "Views",
    rows: [
      { label: "Grid", keys: ["1"] },
      { label: "Masonry", keys: ["2"] },
      { label: "List", keys: ["3"] },
      { label: "Select everything in view", keys: ["mod+A"] },
      { label: "Clear selection, close panel", keys: ["Esc"] },
      { label: "Previous / next in the panel", keys: ["←", "→"] },
    ],
  },
  {
    title: "Selected items",
    rows: [
      { label: "Favourite", keys: ["F"] },
      { label: "Archive", keys: ["A"] },
      { label: "Add tags", keys: ["T"] },
      { label: "Move to a folder", keys: ["M"] },
      { label: "Edit", keys: ["E"] },
      { label: "Move to trash", keys: ["⌫"] },
    ],
  },
  {
    title: "Mouse",
    rows: [
      { label: "Open details", keys: ["Click"] },
      { label: "Add to selection", keys: ["mod+Click"] },
      { label: "Select a range", keys: ["shift+Click"] },
      { label: "Open the page", keys: ["Double-click"] },
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[720px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="shortcuts">
          {GROUPS.map((group) => (
            <div key={group.title} className="shortcut-group">
              <h3>{group.title}</h3>
              <dl>
                {group.rows.map((row) => (
                  <div key={row.label} className="contents">
                    <dt>{row.label}</dt>
                    <dd>
                      {row.keys.map((spec, index) => (
                        <span key={spec} className="inline-flex items-center gap-1">
                          {index > 0 ? <span className="kbd-or">/</span> : null}
                          <span className="kbd">
                            {shortcutParts(spec).map((part, partIndex) => (
                              <kbd key={partIndex}>{part}</kbd>
                            ))}
                          </span>
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
