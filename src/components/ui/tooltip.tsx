/**
 * Tooltips (`.tooltip` in styles/ui.css): ink pill, 12.5 px / 500, with the shortcut as
 * `<kbd>` chips. Appear after 450 ms; instantly when another tooltip was shown in the last
 * 400 ms (Radix's skip delay). Every icon-only control in the app has one.
 */
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";

import { cn, shortcutParts } from "@/lib/utils";

function TooltipProvider({
  delayDuration = 450,
  skipDelayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("tooltip bs-tooltip", className)}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** Shortcut chips for a tooltip or menu: "mod+K" → [Ctrl][K] or [⌘][K]. */
function KeyChips({ keys, className = "tooltip-kbd" }: { keys: string; className?: string }) {
  const parts = shortcutParts(keys);
  if (!parts.length) return null;
  return (
    <span className={className}>
      {parts.map((part, index) => (
        <kbd key={index}>{part}</kbd>
      ))}
    </span>
  );
}

function Hint({
  label,
  children,
  side = "bottom",
  keys,
  disabled,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  keys?: string;
  disabled?: boolean;
}) {
  if (disabled) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {keys ? <KeyChips keys={keys} /> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Hint, KeyChips };
