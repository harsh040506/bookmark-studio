/**
 * The extension's own "Allow this site?" window, opened by the service worker when a local
 * address asks to use the bridge. Running on the extension's origin, a web page cannot click
 * it on the person's behalf.
 */
import { isLocalOrigin, setApproval } from "./bridge-host";

const params = new URLSearchParams(location.search);
const origin = params.get("origin") ?? "";
const valid = /^https?:\/\/[^/]+$/.test(origin);

const originEl = document.getElementById("origin");
const allow = document.getElementById("allow") as HTMLButtonElement | null;
const deny = document.getElementById("deny") as HTMLButtonElement | null;

if (originEl) originEl.textContent = valid ? origin : "an unknown site";
if (!valid || !isLocalOrigin(origin)) {
  if (allow) allow.disabled = true;
}

allow?.addEventListener("click", () => {
  if (!valid) return;
  void setApproval(origin, true).then(() => window.close());
});
deny?.addEventListener("click", () => {
  if (!valid) {
    window.close();
    return;
  }
  void setApproval(origin, false).then(() => window.close());
});
deny?.focus();
