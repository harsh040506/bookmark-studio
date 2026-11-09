/**
 * The extension's own "Allow this site?" window, opened by the service worker when a local
 * address asks to use the bridge. Running on the extension's origin, a web page cannot click
 * it on the person's behalf.
 */
import { isLocalOrigin, setApproval } from "./bridge-host";

const params = new URLSearchParams(location.search);

/*
  "Allow reading pages": Chrome only shows its permission prompt in answer to a click on an
  extension page, which is what this window is for. The request runs first in the click
  handler, before anything awaits, or Chrome no longer counts it as the user's click.
*/
function setUpPageAccess(): void {
  const title = document.getElementById("title");
  const body = document.getElementById("body");
  const note = document.getElementById("note");
  const allowButton = document.getElementById("allow") as HTMLButtonElement | null;
  const denyButton = document.getElementById("deny") as HTMLButtonElement | null;
  if (title) title.textContent = "Let Bookmark Studio read your bookmarked pages?";
  if (body) {
    body.textContent =
      "To show previews, find dead links and search inside pages, Bookmark Studio opens the pages you have bookmarked. Chrome will ask you to confirm.";
  }
  if (note) note.textContent = "Pages are read in your browser, only when you have bookmarked them. Nothing is sent anywhere else.";
  allowButton?.addEventListener("click", () => {
    chrome.permissions
      .request({ origins: ["<all_urls>"] })
      .then((granted) => {
        if (granted) window.close();
        else if (note) note.textContent = "Not allowed. Previews and link checks stay off until you allow it.";
      })
      .catch(() => {
        if (note) note.textContent = "Chrome did not show its prompt. Try again from the app.";
      });
  });
  denyButton?.addEventListener("click", () => window.close());
  allowButton?.focus();
}

function setUpSiteApproval(): void {
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
}

if (params.get("mode") === "pages") setUpPageAccess();
else setUpSiteApproval();
