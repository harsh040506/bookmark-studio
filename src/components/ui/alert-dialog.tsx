import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as React from "react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

function AlertDialog(props: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="bs-scrim">
        <AlertDialogPrimitive.Content
          data-slot="alert-dialog-content"
          className={cn("dialog bs-dialog max-w-[400px]", className)}
          {...props}
        />
      </AlertDialogPrimitive.Overlay>
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("dialog-title", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("dialog-text", className)}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> & {
  variant?: "default" | "destructive";
}) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
    />
  );
}

/* ------------------------------------------------------ imperative confirm */

interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type Resolver = (value: boolean) => void;
let openConfirm: ((request: ConfirmRequest, resolve: Resolver) => void) | null = null;

/**
 * Asks the question from wherever the action lives.
 *
 * Destructive actions are triggered from context menus, keyboard shortcuts and bulk bars
 * alike; threading dialog state through every one of those would mean each call site
 * owning a piece of UI it does not otherwise care about. The host below is mounted once.
 *
 * Resolves `false` when no host is mounted, so a confirmation can never be silently
 * skipped into performing the deletion.
 */
export function confirm(request: ConfirmRequest): Promise<boolean> {
  if (!openConfirm) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => openConfirm?.(request, resolve));
}

export function ConfirmHost() {
  const [state, setState] = React.useState<{ request: ConfirmRequest; resolve: Resolver } | null>(
    null,
  );

  React.useEffect(() => {
    openConfirm = (request, resolve) => setState({ request, resolve });
    return () => {
      openConfirm = null;
    };
  }, []);

  const settle = React.useCallback(
    (value: boolean) => {
      state?.resolve(value);
      setState(null);
    },
    [state],
  );

  const request = state?.request;
  return (
    <AlertDialog
      open={Boolean(state)}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
    >
      <AlertDialogContent>
        <div className="bs-dialog-head">
          <AlertDialogTitle>{request?.title ?? ""}</AlertDialogTitle>
          {request?.description ? (
            <AlertDialogDescription>{request.description}</AlertDialogDescription>
          ) : null}
        </div>
        <div className="bs-dialog-foot">
          <AlertDialogCancel onClick={() => settle(false)}>
            {request?.cancelLabel ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={request?.destructive ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            {request?.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
