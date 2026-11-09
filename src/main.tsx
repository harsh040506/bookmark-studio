/**
 * Client entry point.
 *
 * Before the first render it settles *where* the app is running (`lib/runtime.ts`): the
 * extension's own page, the website with the extension installed, the local server, or the
 * website on its own. That probe is bounded to well under a second and decides which
 * backend answers network questions for the rest of the session (re-checked on focus).
 *
 * The app is wrapped in an error boundary *outside* StrictMode so that a crash during a
 * StrictMode double-render is still caught and shown as a recoverable screen.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { BackgroundRunner } from "./components/app/background-runner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { writeHealth } from "./lib/db";
import { IS_BACKGROUND_RUNNER, IS_EXTENSION } from "./lib/env";
import { setGuardedTransport } from "./lib/net-guard";
import { probeRuntime, watchRuntime } from "./lib/runtime";
import { log } from "./lib/log";
import { netFetch } from "./lib/transport";

// The design system's three open-source faces, bundled rather than fetched from a font CDN.
import "@fontsource-variable/dm-sans/wght.css";
import "@fontsource-variable/dm-sans/wght-italic.css";
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  // Only reachable if index.html was altered; failing loudly beats a silent no-op.
  throw new Error("Root element #root is missing from the document");
}

// On the website every guarded fetch goes through the transport, which relays it to the
// extension when one is connected (inside the extension, a plain fetch is already allowed).
if (!IS_EXTENSION) setGuardedTransport((url, init) => netFetch(url, init));

/*
  Closing the tab is the one moment a change the device refused to store is really lost.
  Registered here, outside React, so it keeps working even if the interface has crashed.
*/
window.addEventListener("beforeunload", (event) => {
  if (!writeHealth().unsaved) return;
  event.preventDefault();
  event.returnValue = "";
});

/**
 * Offline support for the website build: a small service worker caches the app shell so
 * the library opens with the network off. Never registered in the extension (which is
 * already local) or in development (where it would serve stale modules).
 */
function registerServiceWorker(): void {
  if (IS_EXTENSION || import.meta.env.DEV || import.meta.env.VITE_TARGET !== "web") return;
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  const register = () => {
    navigator.serviceWorker.register(new URL("sw.js", document.baseURI), { scope: "./" }).catch((error: unknown) => {
      // Offline caching is an enhancement; the app works without it.
      log.warn("offline.sw-register-failed", { error });
    });
  };
  // The runtime probe usually finishes after `load` has fired, so register at once in that case.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

/**
 * On the website the stylesheet is linked with media="print" so it does not hold back the
 * first paint of the text shell (scripts/build-site.mjs). Switch it on, and wait until it has
 * loaded, before the app draws. Elsewhere (extension, development) there is nothing to do.
 */
function appStyles(): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>("link[data-app-css]");
  if (!link) return Promise.resolve();
  const ready = link.sheet
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        link.addEventListener("load", () => resolve(), { once: true });
        // A failed stylesheet must not keep the app from starting.
        link.addEventListener("error", () => resolve(), { once: true });
      });
  return ready.then(() => {
    link.media = "all";
  });
}

void Promise.all([probeRuntime().catch(() => undefined), appStyles()])
  .catch(() => undefined)
  .finally(() => {
    watchRuntime();
    registerServiceWorker();
    createRoot(container).render(
      <ErrorBoundary>
        <StrictMode>{IS_BACKGROUND_RUNNER ? <BackgroundRunner /> : <App />}</StrictMode>
      </ErrorBoundary>,
    );
  });
