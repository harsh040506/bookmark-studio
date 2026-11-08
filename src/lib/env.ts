/**
 * Where this bundle is running.
 *
 * One build of the interface ships three ways — as a website, as the page inside the Chrome
 * extension, and served by the optional local server — and the only thing that differs
 * between them is which *backend* answers the network questions a browser tab cannot answer
 * for itself (reading another site's page, checking a link, rendering a screenshot). That
 * decision lives in `lib/runtime.ts`; this file only answers the one question that can be
 * settled synchronously at load: are we the extension's own page?
 */
export const IS_EXTENSION: boolean =
  typeof chrome !== "undefined" &&
  typeof chrome.runtime !== "undefined" &&
  typeof chrome.runtime.id === "string" &&
  chrome.runtime.id.length > 0 &&
  typeof location !== "undefined" &&
  location.protocol === "chrome-extension:";

/** The Chrome Web Store page for the companion extension, when one has been published. */
export const EXTENSION_STORE_URL: string = import.meta.env.VITE_EXTENSION_STORE_URL ?? "";

/** Where the source code lives — shown in Settings → About. */
export const REPOSITORY_URL: string =
  import.meta.env.VITE_REPOSITORY_URL ?? "https://github.com/harsh040506/bookmark-studio";

/** The app version, injected at build time from package.json. */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? "dev";
