/**
 * Empty states: centred, quiet, one sentence explaining the next step, and at most a couple
 * of actions (design system "Extending the system" → Empty state). The headline is set in the
 * serif, like every heading in the app.
 */
import type * as React from "react";

import { cn } from "@/lib/utils";

function Empty({
  icon,
  title,
  description,
  actions,
  tone = "default",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  tone?: "default" | "destructive";
}) {
  return (
    <div data-slot="empty" className={cn("empty", className)} {...props}>
      {icon ? <div className={cn("empty-icon", tone === "destructive" && "is-danger")}>{icon}</div> : null}
      <div className="empty-copy">
        <h2 className="empty-title">{title}</h2>
        {description ? <p className="empty-text">{description}</p> : null}
      </div>
      {actions ? <div className="empty-actions">{actions}</div> : null}
      {children}
    </div>
  );
}

export { Empty };
