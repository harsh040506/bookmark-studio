/**
 * Modal dialogs, as the design system draws them (`.scrim` + `.dialog`): top-aligned at ~10vh
 * rather than centred, a 14 px radius, the popover shadow plus ring, a 150 ms scrim fade and a
 * 180 ms rise. Footers put Cancel (ghost) before the primary action, right-aligned.
 *
 * Radix provides the behaviour the system specifies — focus trap, Esc, scrim click, focus
 * restored to the trigger on close.
 */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";

import { Close } from "@/components/icons";
import { cn } from "@/lib/utils";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn("bs-scrim", className)} {...props} />;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay>
        <DialogPrimitive.Content data-slot="dialog-content" className={cn("dialog bs-dialog", className)} {...props}>
          {children}
          {showCloseButton ? (
            <DialogPrimitive.Close data-slot="dialog-close" className="icon-btn bs-dialog-close" aria-label="Close">
              <Close />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </DialogOverlay>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("bs-dialog-head", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("bs-dialog-foot", className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("dialog-title", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description data-slot="dialog-description" className={cn("dialog-text", className)} {...props} />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
