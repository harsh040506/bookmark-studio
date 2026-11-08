import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { onMirrorFailure } from "@/lib/chrome-bookmarks";
import { classifyWriteFailure, isReported, retryUnsaved, subscribeWriteHealth, writeHealth, type WriteHealth } from "@/lib/db";
import { IS_EXTENSION } from "@/lib/env";
import { log } from "@/lib/log";

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
 * - **Unsaved changes.** A change the device refused to store is said so plainly, retried on
 *   its own, and protected by a warning before the tab closes.
 */

const SAVE_TOAST = "save-health";
const AUTO_RETRY_MS = 30_000;

function saveMessage(health: WriteHealth): { title: string; description: string } {
  const count = health.unsaved.toLocaleString();
  const what = health.unsaved === 1 ? "1 change" : `${count} changes`;
  switch (health.failure) {
    case "quota":
      return {
        title: `${what} not saved: this device is out of space for Bookmark Studio`,
        description:
          "They are still on screen. Free up disk space, or remove saved previews in Settings → Storage, then try again. Downloading a backup keeps them safe meanwhile.",
      };
    case "blocked":
      return {
        title: `${what} not saved: the browser is blocking storage for this site`,
        description: "Allow site data for this site in your browser settings, then try again.",
      };
    default:
      return {
        title: `${what} not saved yet`,
        description: "They are still on screen and will be retried automatically. Keep this tab open until this clears.",
      };
  }
}
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
          log.info("storage.persist-denied", {});
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
    let wasFailing = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const retry = async (manual: boolean) => {
      if (!writeHealth().unsaved) return;
      const done = await retryUnsaved();
      if (!done && manual) log.warn("storage.retry-failed", { unsaved: writeHealth().unsaved });
    };

    const show = (health: WriteHealth) => {
      if (health.unsaved && health.failure) {
        if (!wasFailing) log.error("storage.write-failed", { kind: health.failure, unsaved: health.unsaved });
        wasFailing = true;
        const { title, description } = saveMessage(health);
        toast.error(title, {
          id: SAVE_TOAST,
          description,
          duration: Infinity,
          action: { label: "Try again", onClick: () => void retry(true) },
        });
        timer ??= setInterval(() => void retry(false), AUTO_RETRY_MS);
      } else if (!health.unsaved && wasFailing) {
        wasFailing = false;
        if (timer) clearInterval(timer);
        timer = undefined;
        log.info("storage.recovered", {});
        // A fresh message rather than an update: an update would keep the old description
        // and the "Try again" button next to "All changes saved".
        toast.dismiss(SAVE_TOAST);
        toast.success("All changes saved", { duration: 4000 });
      }
    };

    const unsubscribe = subscribeWriteHealth(show);
    const nudge = () => void retry(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") nudge();
    };
    // The warning before closing the tab lives in main.tsx, outside the error boundary,
    // so it still protects unsaved changes if the interface itself has crashed.
    window.addEventListener("online", nudge);
    window.addEventListener("focus", nudge);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      if (timer) clearInterval(timer);
      window.removeEventListener("online", nudge);
      window.removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    let lastShown = 0;
    // One message per burst: a bulk move that fails fails for every row at once.
    return onMirrorFailure((operation) => {
      const now = Date.now();
      if (now - lastShown < 10_000) return;
      lastShown = now;
      const undone = operation === "remove" || operation === "remove-folder";
      toast.warning("A change could not be copied to Chrome’s bookmarks", {
        id: "chrome-mirror",
        description: undone
          ? "Chrome still has it, so it may reappear the next time the two sync. Try the change again, or make it in Chrome’s bookmark manager."
          : "It is kept here, but Chrome’s bookmarks are not updated. Try the change again, or make it in Chrome’s bookmark manager.",
      });
    });
  }, []);

  useEffect(() => {
    let lastShown = 0;
    const report = (reason: unknown) => {
      // Already explained to the person by whoever raised it (a failed save, for one).
      if (isReported(reason)) return;
      // A full disk is explained by the saving message, if anything was lost; a vaguer
      // second message about the same cause only alarms.
      if (classifyWriteFailure(reason) === "quota") {
        log.warn("storage.quota", { error: reason });
        return;
      }
      log.error("app.unexpected", { error: reason });
      const now = Date.now();
      if (now - lastShown < 15_000) return;
      lastShown = now;
      toast.error("Something went wrong in the background", {
        description: writeHealth().unsaved
          ? "Some changes are not saved yet; see the message about saving."
          : "Your saved library is not affected. If this keeps happening, reload the page.",
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      // Aborted fetches and cancelled transitions are routine, not failures.
      const reason = event.reason;
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      // A failed save is tracked and explained by the saving message; marking the rejection
      // handled keeps the browser from also logging it as "Uncaught (in promise)".
      if (isReported(reason)) {
        event.preventDefault();
        return;
      }
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
