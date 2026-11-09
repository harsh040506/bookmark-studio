# Changelog

## Unreleased

### One library
- The website and the extension now share one library. Each still keeps its own copy, because browsers give them separate storage, but while the extension is connected, bookmarks, tags, folders, boards, imports and smart collections changed on either side appear on the other within seconds. Deletions carry over and never come back.
- When both sides changed the same bookmark, the person's latest decision wins for tags, folders, favourites, notes and the trash, and the newest result wins for what pages report. A page read finishing on one side can no longer undo a tag added on the other.
- The first time the two meet, bookmarks saved at the same address on both sides are combined, with tags from both, instead of showing up twice.
- Screenshots, offline copies and uploaded files stay in the copy that has their bytes.
- Switch it off in Settings → Background ("Share one library with the extension").

### Background work
- Fixed libraries stuck on "filling in" forever. A page saved under several bookmarks was captured again on every pass, results written from an older copy of a row could erase each other (and bring back deleted bookmarks), and a page already being worked on could be queued again. Each page is now fetched once at a time, marked on every bookmark that shares it, and given up on after a few failed tries.
- Background work keeps going while the tab is in the background, instead of slowing to about one step a minute.
- Failures stored on bookmarks are plain sentences ("The site took too long to answer") and never include addresses from your network.

### Extension
- Installing asks only for your bookmarks. Permission to read the pages in your library is asked for the first time it is needed, with **Allow reading pages** in the app.
- Background capture windows are off by default: cards use the page's own preview image, and a screenshot is still taken when you ask for one. Switch them on in Settings → Background.
- Firefox 128 or newer: `npm run build` also writes `dist/extension-firefox` and its zip, and releases attach it. Bookmark sync understands Firefox's folders.
- Browser bookmark sync is on by default once the extension is connected, unless you switch it off, and starts even when the extension connects after the page has opened.
- New bookmarks appear in your other open tabs straight away. A tab now announces a change only after it is saved, and the others read just the rows that changed.
- The console no longer fills with "Executing inline event handler violates…" errors while pages are read. Chrome reported one for every `onclick=`-style attribute in a page's HTML as it was parsed, even though none of them ever ran. The smoke test now fails on any Content Security Policy violation.
- No more "Unchecked runtime.lastError" message when a page moves into the back/forward cache.

### Security
- Private network addresses written inside IPv6 (`http://[::ffff:127.0.0.1]/`, which the URL parser turns into `[::ffff:7f00:1]`, plus NAT64, 6to4 and Teredo forms) and `localhost.` with a trailing dot are refused by the local server and the extension. One classifier (`shared/ip.ts`) serves both.
- The local server connects only to an address it has just checked, so DNS rebinding cannot reach your network, and throws away a screenshot of a page that was served from a private address.
- The extension refuses redirects that end on a private address. Through the bridge, an allowed website can no longer lift the download size limit with an invalid number or save `javascript:` bookmarks into the browser.
- Addresses with a username or password in them are refused.
- The local server identifies itself as `BookmarkStudio/5` with a link to this repository.

### Phones
- Installed on Android, the website appears in the share sheet: share a link from any app and it opens ready to save.

### Code
- `useLibrary` is split into a core (state, `commit`, undo) and four hooks in `src/hooks/library/`: browser sync, import and export, editing, and background work.

### Website
- New [About](https://bookmark-studio-app.vercel.app/about) and [Privacy](https://bookmark-studio-app.vercel.app/privacy) pages, a real "not found" page, and a text introduction that shows while the app starts (and stays readable without JavaScript).
- Every page has its own title, description, canonical address, link-preview image and structured data. The site publishes `robots.txt`, a sitemap, `llms.txt`, Markdown copies of each page and `security.txt`.
- The about page has a share box: the system share sheet where there is one, copy link, and links for X, LinkedIn, Facebook, WhatsApp, Telegram, Reddit and email.
- After an update, a tab opened before it keeps working: the previous version's files stay cached until the next deploy. The offline cache now holds only the app, and an error page can never be cached in its place.
- `npm run check:site` checks the built site the way crawlers and preview bots see it (status codes, headers, metadata, links, sitemap, size budgets, and an accessibility scan when axe-core is installed). CI runs it.

### Accessibility
- Cards and list rows are a container with a real button inside, named by the title, instead of a button with other buttons nested in it. Enter opens, Space selects, as before.
- Folders with subfolders open and close with the arrow keys and announce whether they are open.
- Secondary text, counts and links in dark mode now meet WCAG AA contrast. Toolbar buttons whose labels hide on narrow screens keep their names; sliders, progress bars and settings menus are named.

### Maintenance
- Node.js 22.12 or newer is required (Node 20 has reached end of life). puppeteer-core 25 clears the advisories reported against version 23.
- README and site pictures are re-shot from the real app with `npm run media`.

### Large libraries
- Previews never load more than five pages at once. The local server runs one headless browser at most; a tab's slot is freed only once it has closed, and the browser is shut down completely before a new one starts. It restarts after a set number of captures, and whenever a tab will not close.
- The extension closes every capture window before starting another, and closes windows left behind if Chrome stops its background worker mid-capture. The page sends at most five capture requests at a time.
- Suggested tags now name real topics (`design`, `typography`, `ai`, …). Earlier versions split folder names and titles into words, so a folder called "Everything Else & Stuff" became the tags `everything`, `else` and `stuff`. Existing libraries are cleaned up once on first load; tags you added yourself are kept.

### Reliability
- Changes the device refuses to store (a full disk, storage blocked, the database closed by another tab) are no longer lost silently. Brief failures are retried; lasting ones show a plain message with **Try again**, are retried automatically when the tab regains focus or the network returns, and the browser asks before closing a tab that still has unsaved changes. An older failed change can never overwrite a newer one.
- Records read back from storage are repaired to the current shape instead of crashing the app. A folder whose parent is missing, or two folders that name each other as parent, move to the top level instead of disappearing from the tree. Unreadable or wrong-typed settings fall back to the defaults.
- Import reads UTF-16 files (Excel's "Unicode Text", many Windows tools) and legacy Windows-1252 files correctly, refuses empty and oversized files before reading them, and says so when a file cannot be read.
- The local server skips a site for a minute after it stops answering, instead of waiting out a timeout for every link on it, and pauses Chrome launches after repeated failures. Server errors carry a short reference that matches the log, without exposing details. A busy port is explained when the server starts.
- A change that cannot be copied to Chrome's bookmarks is reported, since the next sync would otherwise undo it without explanation.
- Settings → About → **Copy diagnostics** copies recent events for a bug report, with web addresses cut to the site name. The crash screen offers the same, and warns about unsaved changes before a reload.

### Interface
- Import: the sources that match the file are listed first, the list is a keyboard-friendly radio group, the Import button stays visible however long the step is, and a loaded sample library can be removed as part of a real import.
- Light favicons (white logos) sit on a dark chip, so they no longer show as blank squares. Cards without a preview show a larger icon.
- Theme menu icons sit beside their labels. Long titles wrap inside their cards. The list view's folder column lines up and shows the folder's own name.
- The hosted website no longer requests `/api/ping`, which only exists on the local server, so its console stays free of a 404 on every load and focus. The local server marks the pages it serves instead.
- The sidebar says "Add the extension for previews" rather than "Offline" when the network is fine. Cards have short, accurate screen-reader names.

## 5.0.0

First public release.

### Ways to run it
- **Website.** Works in any modern browser with nothing installed. It can be installed as an app and works offline.
- **Chrome extension.** Syncs both ways with the browser's bookmarks. Reads pages, checks links and captures previews.
- **Website + extension.** The extension gives the website the same capabilities. Optional two-way bookmark sync.
- **Local server.** Every capability in any browser (`npm start` or Docker), with previews rendered in headless Chrome or Edge.

### Features
- Import from 28 sources, including every major browser, Pocket, Instapaper, Raindrop, Pinboard, Notion, Evernote, CSV, JSON and plain link lists. Source detection, a preview before writing, merge or replace, and backup restore.
- A sample library to explore before importing.
- Search with typo correction, operators (`tag:`, `site:`, `is:`, `has:`, `kind:`, `color:`) and plain-English dates.
- Grid, masonry and list layouts, windowed for libraries of 100,000 items.
- Folders, boards, tags, favourites, archive, trash, and smart collections that fill themselves from a saved search.
- Page previews, link health with archive fallbacks, offline copies, duplicate detection and merging, look-alike and colour search.
- Notes and highlights, a detail panel with keyboard stepping, a command palette, keyboard shortcuts for everything.
- Export to browser HTML, a full JSON backup or CSV, and "share as a page": one self-contained HTML file.
- Paste a link or picture anywhere to save it.
- Undo for every destructive action, and an activity log.
- System, light and dark themes. Works on phones.
