/**
 * Text fields (`.input` in styles/ui.css): 34 px, an inset 1 px border, and on focus an accent
 * border with a soft 3 px halo. `SearchInput` adds the leading magnifier (`.file-search`).
 */
import type * as React from "react";

import { Search } from "@/components/icons";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn("input", className)} {...props} />;
}

function Textarea({ className, rows = 3, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" rows={rows} className={cn("input", className)} {...props} />;
}

function SearchInput({ className, wrapperClassName, ...props }: React.ComponentProps<"input"> & { wrapperClassName?: string }) {
  return (
    <div className={cn("file-search", wrapperClassName)}>
      <Search />
      <input type="search" data-slot="input" className={cn("input", className)} {...props} />
    </div>
  );
}

export { Input, SearchInput, Textarea };
