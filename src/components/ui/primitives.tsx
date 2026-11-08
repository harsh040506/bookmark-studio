/**
 * The small, stateless primitives, composed from the design system's recipes:
 *
 * - `Badge` — a 20 px pill: neutral chip, or a status colour as *text* on its light tint.
 * - `Separator` — a 1 px low-alpha hairline.
 * - `Label` — the 12.5 px / 500 field label.
 * - `Progress` — a 4 px bar: track on the 10 % ghost fill, fill in ink (not accent).
 * - `Kbd` — a keyboard chip.
 */
import * as LabelPrimitive from "@radix-ui/react-label";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva("bs-badge", {
  variants: {
    variant: {
      default: "is-neutral",
      secondary: "is-neutral",
      outline: "is-outline",
      destructive: "is-danger",
      success: "is-success",
      warning: "is-warning",
      accent: "is-accent",
    },
  },
  defaultVariants: { variant: "default" },
});

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "bg-line-soft shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root data-slot="label" className={cn("field-label select-none", className)} {...props} />;
}

function Progress({ className, value, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root data-slot="progress" className={cn("bs-progress", className)} {...props}>
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bs-progress-fill"
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <span className={cn("kbd", className)}>
      <kbd data-slot="kbd" {...props} />
    </span>
  );
}

export { Badge, badgeVariants, Separator, Label, Progress, Kbd };
