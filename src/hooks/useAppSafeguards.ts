import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { IS_EXTENSION } from "@/lib/env";

/**
 * The quiet machinery a real-world session needs, in one place:
 *
 * - **Persistent storage.** Browsers may evict IndexedDB under storage pressure unless the site
 *   is granted persistence. Asked once the library holds something worth keeping (asking on an
 *   empty first visit is premature, and Firefox shows a prompt).
 * - **Updates.** When a new version's service worker takes over, say so and offer a reload,
 *   instead of running an old page against new assets.
 * - **Connectivity.** Losing the network is announced once, plainly: the library keeps working.
 * - **Unexpected errors.** Logged with a tag for bug reports; surfaced at most once every 15 s so
 *   a failing background task cannot bury the screen in toasts.
 */
export function useAppSafeguards({ itemCount }: { itemCount: number }): void {
  const askedPersist = useRef(false);

  useEffect(() => {
    if (askedPersist.current || itemCount === 0 || IS_EXTENSION) return;
    const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!storage?.persist || !storage.persisted) return;
    askedPersist.current = true;
    void storage
      .persisted()
      .then((already) => (already ? true : storage.persist()))
      .then((granted) => {
        if (!granted) {
          console.info("[bookmark-studio] persistent storage not granted; export a backup now and then");
        }
      })
      .catch(() => undefined);
  }, [itemCount]);

  useEffect(() => {
    if (IS_EXTENSION || !("serviceWorker" in navigator)) return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    let announced = false;
    const onChange = () => {
      if (!hadController || announced) return;
      announced = true;
      toast("A new version of Bookmark Studio is ready", {
        description: "Reload to use it. Your library is not affected.",
        duration: Infinity,
        action: { label: "Reload", onClick: () => window.location.reload() },
      });
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onChange);
  }, []);

  useEffect(() => {
    const offline = () =>
      toast("You’re offline", {
        id: "connectivity",
        description: "Your library still works. Previews and link checks resume when you’re back.",
      });
    const online = () => toast.success("Back online", { id: "connectivity" });
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, []);

  useEffect(() => {
    let lastShown = 0;
    const report = (reason: unknown) => {
      console.error("[bookmark-studio] unexpected error", reason);
      const now = Date.now();
      if (now - lastShown < 15_000) return;
      lastShown = now;
      toast.error("Something went wrong in the background", {
        description: "Your library is safe. If this keeps happening, reload the page.",
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      // Aborted fetches and cancelled transitions are routine, not failures.
      const reason = event.reason;
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      report(reason);
    };
    const onError = (event: ErrorEvent) => {
      // Resource load failures and benign ResizeObserver notices are not app errors.
      if (!event.error || /ResizeObserver/.test(event.message)) return;
      report(event.error);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);
}
