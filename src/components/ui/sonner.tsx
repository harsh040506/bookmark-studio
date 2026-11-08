/**
 * Toasts, drawn as the design system's `.toast`: an ink pill centred at the bottom, 13.5 px,
 * with a ✓ or ⚠ glyph for success and errors and an optional action button. Sonner keeps the
 * stacking and timing; every visual comes from styles/app.css (`.bs-toast`).
 */
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { Check, Info, Spinner, Warning } from "@/components/icons";

function Toaster({ theme = "system", ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      position="bottom-center"
      offset={22}
      gap={8}
      visibleToasts={4}
      duration={2600}
      icons={{
        success: <Check size={16} />,
        error: <Warning size={16} />,
        warning: <Warning size={16} />,
        info: <Info size={16} />,
        loading: <Spinner size={16} className="animate-spin" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "bs-toast",
          content: "bs-toast-content",
          title: "bs-toast-title",
          description: "bs-toast-description",
          icon: "bs-toast-icon",
          actionButton: "toast-action",
          cancelButton: "toast-action",
          closeButton: "bs-toast-close",
        },
      }}
      style={{ "--width": "440px" } as React.CSSProperties}
      {...props}
    />
  );
}

export { Toaster };
