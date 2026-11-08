/**
 * Popovers: the floating surface every menu shares — popover background, 10 px radius, the
 * soft two-layer shadow plus a 1 px ring, and the 120 ms pop-in (styles/app.css `.surface`).
 */
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "surface z-[60] w-72 p-3 outline-none",
          "max-h-(--radix-popover-content-available-height) overflow-y-auto",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
