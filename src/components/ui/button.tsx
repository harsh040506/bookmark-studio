/**
 * Buttons, as the design system draws them (`.btn` in styles/ui.css).
 *
 * - `default` is the primary action: inverted ink (black on light, white on dark), never blue.
 * - `outline` is the secondary action: transparent with a 1 px ring (`.btn-ghost`).
 * - `ghost` is a toolbar-style control: no ring, grey until hovered (`.tb-btn` metrics).
 * - `destructive` is the only coloured button.
 *
 * Heights follow the system: 32 default, 28 small, 24 extra-small; icon buttons are square.
 */
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva("btn select-none disabled:pointer-events-none [&_svg]:shrink-0 [&_svg]:pointer-events-none", {
  variants: {
    variant: {
      default: "btn-primary",
      destructive: "btn-danger",
      outline: "btn-ghost",
      secondary: "btn-secondary",
      ghost: "btn-plain",
      link: "btn-link",
    },
    size: {
      default: "",
      sm: "btn-sm",
      xs: "btn-xs",
      lg: "btn-lg",
      icon: "btn-icon",
      "icon-sm": "btn-icon btn-icon-sm",
      "icon-xs": "btn-icon btn-icon-xs",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
