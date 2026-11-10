# Changelog

## 6.0.0

### Folders
- **Move a folder.** A folder's menu has **Move to…**: pick another folder or the top level and everything inside goes with it. A folder cannot be moved into itself or its own subfolders, the browser is told when the folder is one of its own, and the move can be undone from the message that confirms it.
- **A path above every folder.** A folder's page shows the folders above it, each one a way back up. In a deep tree the middle of the path folds away so the top and the nearest parents stay readable.
- **Every folder can be chosen when adding or editing a bookmark.** The Folder field listed only the first 200 folders, so in a large library most folders could not be picked and a bookmark filed further down showed a blank field. It is now the same searchable list used for moving bookmarks.
- **Choosing a folder works from the keyboard.** Type, arrow to a row, press Enter. A folder whose own name matches is listed before folders that merely sit under one that does, and each row shows the folder's name with its path beneath.
- Deleting a folder says how many bookmarks move and where to, and how many subfolders go, before asking. If you are inside the folder, you are taken to where its bookmarks went. Large folders show progress while the browser's copy is moved.
- Renaming or moving a folder updates search straight away. Bookmarks used to stay findable only under the old path until the next reload.
- An address that points at a folder, board, import or collection that no longer exists says so and offers a way back, instead of an empty page titled "Folder".
- Folder, board and collection names are limited to 200 characters.

### Importing
- A file that cannot be read says so on the review step, with what to try next. It used to show four zeros and a greyed-out button.
- A file with nothing new in it explains why: everything is already saved, or no links were found.
- The sample library is removed only after your own bookmarks are in. Removing it first meant a failed import left an empty library.
- The dialog cannot be closed half-way through writing, and stays open on a failure so another source can be tried.
- The list of sources works with the arrow keys, like any group of radio buttons.

### Search and commands
- The command palette lists folders by how well they match (the folder called "Design" before the folders under it), by name with the path beside it, and ranks an exact match of any kind first.
- New commands: New folder (inside the current one when you are in a folder), Export as CSV, Undo and Redo.

### Browsers
- A folder deleted in the browser while the app was closed is removed here at the next sync, once nothing is left in it. Its bookmarks were already removed; the empty folder used to stay for good.
- The app names the browser it is running in. It said "Chrome" in Firefox, Edge and Opera too.
- Settings → Connections gives Firefox its own steps and its own download, and lists Firefox among the supported browsers.
- Settings said the local server needs Node.js 20; it needs 22.12 or newer.

### Website
- The public pages print in black on white whatever theme is on (a dark-mode reader used to get near-white text), leave out the navigation, and write out where each link goes.
- Buttons and boxes keep their edges in high-contrast modes, where shadows and backgrounds are not drawn.
- The path at the top of each page lines up with the heading beneath it.
- Pictures of the app in the README, on the about page and in link previews are re-shot from this version.

### Details
- The loading placeholder for the list layout is a list. It was drawn as a grid of rows side by side.
- A note or alt text is saved when the panel closes or moves to another bookmark, not only when the field loses focus. Pressing Esc with the cursor still in the note could drop what had been typed.
- Tags typed by hand are tidied: a leading `#`, extra spaces and capitals are removed, so `#Design` and `design` are one tag.
- Clearing stored images says how much space was freed, and says so if it could not be done. Copy buttons say when the clipboard refuses.
- The local server takes its version from one place, and a test fails if `package.json`, the lockfile, the changelog and the server ever disagree.

### Large, deeply nested libraries
- Tested at 10,000 bookmarks in folders eight levels deep: importing, naming and counting the tree, opening a folder with its subfolders, typing a search inside one, exporting and importing again, and syncing with the browser (`src/lib/__tests__/nesting.test.ts`, `browser-sync.test.ts`).
- Opening the app no longer rewrites every browser bookmark. Comparing the browser's tree with the library used to save every bookmark again, send all of them to the other copy of the library, and mark each one as changed by you just now, which could let an untouched copy overrule a real edit made on the other side. Only bookmarks and folders that actually differ are written now; an unchanged library costs one read of the tree.
- Changes made in the browser arrive in batches. The browser reports one event per bookmark, and its own sync, a dragged folder or another extension can deliver thousands at once. Each used to rebuild the library, redraw and open a database transaction on its own.
- Changes sent to the browser go a few at a time. Moving or deleting thousands of bookmarks no longer sends every request in the same instant.
- A first sync with thousands of new bookmarks no longer freezes the page while it works out their categories and tags.
- The folder tree opens down to the folder you are in, wherever you came from (search, the command palette, a bookmark's panel, a reload). Deep levels are indented less so names stay readable, and hovering a folder shows its whole path.
- The tree is grouped and sorted once per change to the folders instead of on every keystroke of a search inside a folder.

### Reliability
- Exporting to a bookmarks file no longer leaves bookmarks out. A bookmark whose folder was missing from the export, or sat in folders that named each other as parent, was silently dropped along with the folder. They are written at the top level instead.
- Deleting a folder can no longer delete bookmarks in the browser. If a bookmark could not be moved out of the folder there first, the browser's folder is kept and the app says so.
- A bookmark in the trash is never removed because the browser reported it deleted late.
- A picture that cannot be indexed is given up on after two tries. It was written down under a key nothing looked up, so it was queued again on every change to the library, for as long as the tab stayed open.
- An import no longer hangs forever if the background reader crashes; the file is read again directly, or the app says the file is too large. Import errors are plain sentences.
- Imported folders stop at 32 levels. A damaged or hostile file describing thousands of nested folders used to produce a tree that could crash every later page load; bookmarks below the limit are kept in the deepest folder that is.
- Folder paths, folder totals, the export and the browser sync no longer use recursion, so a very deep tree from a backup, the browser or the other copy cannot overflow the stack. Repairing the tree on load is one pass.
- A backup containing folders that name each other as parent is repaired as it is read, not at the next reload.
- A failed export says so instead of doing nothing.

### Security
- CSV export: a title, tag or folder name beginning with `=`, `+`, `-` or `@` is written as text, so a spreadsheet does not run it as a formula.

## 5.2.0

### Background work
- Background work carries on with no Bookmark Studio window open. Close the last window, or restart the browser, with pages still to read, and the extension finishes them in a hidden page, which closes itself once everything is done. Opening a window takes over from it. The switches in Settings → Background still decide what runs. Not yet in Firefox, which has no hidden pages for extensions; there the work resumes when a window opens.
- Bookmarks added on the website while the extension is connected are filled in by the extension too, even with no extension window open.
- Nothing runs in the background when there is nothing it could do: no page access yet, every pass switched off, or offline.

### Extension
- Two new permissions in Chromium browsers, `offscreen` and `alarms`, for the hidden page and a five-minute check that restarts it. Neither shows a warning, so updating does not ask again. The Firefox build leaves `offscreen` out.

### Code
- The hidden page is the app itself (`index.html?runner`), mounting the library hook with nothing drawn, so it reads, checks and saves exactly as a window does. When to open and close it is decided in `src/lib/background-runner.ts`, which is unit-tested.
- The smoke test closes the last window with work left and checks that the hidden page opens, fills in a bookmark the window never saw, and closes itself.

## 5.1.0

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
