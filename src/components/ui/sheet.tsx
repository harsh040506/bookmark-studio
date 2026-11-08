/**
 * A side sheet — the detail panel's container.
 *
 * The design system has no sheet, so it is composed from its parts as "Extending the system"
 * directs: the popover surface (popover background, ring, soft shadow), a 14 px radius on the
 * inner edge, the dialog scrim and the 180 ms ease-out entrance. It floats with an 8 px inset
 * from the window edge on wide screens and goes edge-to-edge on phones.
 */
import * as SheetPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";

import { Close } from "@/components/icons";
import { cn } from "@/lib/utils";

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  overlay = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "right" | "left" | "bottom";
  showCloseButton?: boolean;
  /** A dimmed scrim behind the sheet. Off for the reading panel, which sits beside the grid. */
  overlay?: boolean;
}) {
  return (
    <SheetPrimitive.Portal>
      {overlay ? <SheetPrimitive.Overlay data-slot="sheet-overlay" className="bs-sheet-scrim" /> : null}
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn("bs-sheet", className)}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <SheetPrimitive.Close className="icon-btn bs-sheet-close" aria-label="Close">
            <Close />
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("bs-sheet-head", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn("dialog-title", className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description data-slot="sheet-description" className={cn("text-hint text-text-3", className)} {...props} />
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription };
