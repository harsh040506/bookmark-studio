/**
 * The interactive controls, each drawn as the design system specifies:
 *
 * - `Checkbox` — the custom square (`.bs-check`): a hairline edge at rest, accent fill and a
 *   white tick when checked. Never a native checkbox.
 * - `Switch` — `.switch` / `.switch-thumb`: 34×20 pill, accent when on, thumb slides 180 ms.
 * - `Slider` — composed per "Progress": a 4 px ink track with a white thumb.
 * - `Tabs`, `ToggleGroup` — the segmented control (`.segmented` / `.seg`).
 *
 * Radix supplies roles, keyboard handling and roving focus.
 */
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import * as React from "react";

import { CheckIcon, MinusIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/* --------------------------------------------------------------- checkbox */

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" className={cn("bs-check peer", className)} {...props}>
      <CheckboxPrimitive.Indicator className="bs-check-mark">
        {props.checked === "indeterminate" ? <MinusIcon size={12} strokeWidth={2.4} /> : <CheckIcon size={12} strokeWidth={2.4} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/* ----------------------------------------------------------------- switch */

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root data-slot="switch" className={cn("switch", className)} {...props}>
      <SwitchPrimitive.Thumb className="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

/* ----------------------------------------------------------------- slider */

function Slider({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const thumbCount = Array.isArray(props.value ?? props.defaultValue) ? (props.value ?? props.defaultValue ?? []).length : 1;
  return (
    <SliderPrimitive.Root data-slot="slider" className={cn("bs-slider", className)} {...props}>
      <SliderPrimitive.Track className="bs-slider-track">
        <SliderPrimitive.Range className="bs-slider-range" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_, index) => (
        <SliderPrimitive.Thumb key={index} className="bs-slider-thumb" />
      ))}
    </SliderPrimitive.Root>
  );
}

/* ------------------------------------------------------------------- tabs */

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-3", className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("segmented", className)} {...props} />;
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn("seg", className)} {...props} />;
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("flex-1 outline-none", className)} {...props} />;
}

/* ----------------------------------------------------------- toggle group */

const ToggleGroupContext = React.createContext<{ size: "sm" | "default" }>({ size: "default" });

function ToggleGroup({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & { size?: "sm" | "default" }) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("segmented", size === "sm" && "is-small", className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ size }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({ className, children, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item data-slot="toggle-group-item" className={cn("seg", className)} {...props}>
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { Checkbox, Switch, Slider, Tabs, TabsList, TabsTrigger, TabsContent, ToggleGroup, ToggleGroupItem };
