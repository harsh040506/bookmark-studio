/**
 * The command palette's parts, composed from the design system's searchable-list dialog
 * (`.file-browser`): a dialog 600 px wide at 10vh, a search field with a leading magnifier,
 * then rows drawn like menu items — the active row on the ghost fill, group headings as
 * 12 px tertiary labels, shortcuts as quiet `<kbd>` chips on the right.
 */
import { Command as CommandPrimitive } from "cmdk";
import type * as React from "react";

import { SearchIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive data-slot="command" className={cn("bs-command", className)} {...props} />;
}

function CommandDialog({
  title = "Command palette",
  description = "Search the library and run commands",
  children,
  className,
  open,
  onOpenChange,
  shouldFilter = false,
  ...props
}: React.ComponentProps<typeof CommandPrimitive> & {
  title?: string;
  description?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className={cn("bs-command-dialog", className)}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command shouldFilter={shouldFilter} loop {...props}>
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="file-search bs-command-search">
      <SearchIcon />
      <CommandPrimitive.Input data-slot="command-input" className={cn("input", className)} {...props} />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List data-slot="command-list" className={cn("bs-command-list", className)} {...props} />;
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-empty" className="file-empty" {...props} />;
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group data-slot="command-group" className={cn("bs-command-group", className)} {...props} />;
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator data-slot="command-separator" className={cn("menu-sep", className)} {...props} />;
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return <CommandPrimitive.Item data-slot="command-item" className={cn("menu-item bs-command-item", className)} {...props} />;
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("menu-kbd ml-auto", className)} {...props} />;
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
