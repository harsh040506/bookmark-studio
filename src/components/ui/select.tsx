/**
 * A select, drawn the way the design system asks for one ("Dropdown / select" in Extending the
 * system): a ghost button with a caret that opens a `.menu` of checkable rows. Never a native
 * `<select>`. Radix supplies the listbox semantics and keyboard behaviour.
 */
import * as SelectPrimitive from "@radix-ui/react-select";
import type * as React from "react";

import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "sm" | "default" }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn("btn btn-ghost bs-select-trigger", size === "sm" && "btn-sm", className)}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon size={12} className="tb-caret" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          "menu bs-menu relative z-[60] max-h-(--radix-select-content-available-height) overflow-x-hidden overflow-y-auto",
          position === "popper" && "min-w-[var(--radix-select-trigger-width)]",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex items-center justify-center py-1 text-text-3">
          <ChevronUpIcon size={14} />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex items-center justify-center py-1 text-text-3">
          <ChevronDownIcon size={14} />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn("menu-item bs-menu-item", className)} {...props}>
      <span className="menu-label">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </span>
      <SelectPrimitive.ItemIndicator className="menu-check">
        <CheckIcon size={16} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn("menu-header", className)} {...props} />;
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn("menu-sep", className)} {...props} />;
}

function SelectGroup(props: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem, SelectLabel, SelectSeparator, SelectGroup };
