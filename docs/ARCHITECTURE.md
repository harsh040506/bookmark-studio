# How Bookmark Studio works

This is the map for contributors. Read the README first for what the app does; this is how and why.

- [One codebase, three runtimes](#one-codebase-three-runtimes)
- [The extension bridge](#the-extension-bridge)
- [One library, two copies](#one-library-two-copies)
- [The client: the library lives in the browser](#the-client-the-library-lives-in-the-browser)
- [Importing: 28 sources, one pipeline](#importing-28-sources-one-pipeline)
- [Built for scale](#built-for-scale)
- [The background pipeline](#the-background-pipeline)
- [Images live in the app, not the browser cache](#images-live-in-the-app-not-the-browser-cache)
- [The interface and the design system](#the-interface-and-the-design-system)
- [Builds](#builds)
- [Repository layout](#repository-layout)

---

## One codebase, three runtimes

The same React app ships three ways. The only thing that changes between them is who answers the questions a browser tab can't answer for itself: reading another site's page, checking whether a link is alive, rendering a screenshot, and touching the browser's own bookmarks.

| Running as | Network (pages, links, images) | Screenshots | Browser bookmarks |
| --- | --- | --- | --- |
| The extension's own page | direct `fetch`, once page access is allowed (host permissions lift CORS) | a brief, unfocused capture window | two-way, always on |
| The website, extension installed | relayed through the bridge | capture window, via the bridge | two-way, on unless switched off |
| The website, served by the local server | `/api/*` on the same origin | headless Chrome or Edge | via the extension, if installed |
| The website on its own | none: those features say how to switch them on | none | none |

Everything else — importing, searching, organising, smart collections, exporting, undo, and the visual index of pictures already stored — runs entirely in the tab and is identical in every row.

**Page access is asked for, not assumed.** The extension's manifest lists `<all_urls>` under `optional_host_permissions`, so installing asks only for bookmarks. The first time something needs to read a page, the app offers **Allow reading pages**, which calls `chrome.permissions.request` from that click (on the website, through a small extension window, because only an extension page may ask). Until then, page reading, link checks and previews wait, and the runtime says why.

**Capture windows are opt-in.** An extension can only photograph a page in a real window. Background captures in the extension are off unless **Capture in the background with small windows** is switched on; cards use the page's own preview image instead, and a screenshot is still taken when the person asks for one. The local server's headless renderer has no window and is not affected.

**Firefox** runs the same code from `dist/extension-firefox`: Manifest V3 with an event page (`background.scripts`) instead of a service worker, a fixed add-on id, and Firefox's named bookmark folders (`toolbar_____`, `unfiled_____`), which `src/lib/chrome-bookmarks.ts` learns from the tree at sync time.

**Where the decision lives.** `src/lib/runtime.ts` works out the backend before the first paint, in well under a second. It waits up to ~450 ms for the bridge's hello and pings `api/ping` on the same origin. It runs again when the tab regains focus, so installing the extension or starting the server is noticed without a reload. `src/lib/api.ts` asks the runtime which implementation to call for each capability:

- **extension / bridge** → the browser-native readers in `src/lib/ext-net.ts` and the capture flow in `src/lib/ext-shots.ts`. Every request goes through `guardedFetch` in `src/lib/net-guard.ts`. On the website, `main.tsx` installs a transport (`src/lib/transport.ts`) that relays those requests over the bridge and rebuilds the reply into an ordinary `Response`. The readers are written once and don't know which path carried them.
- **server** → the routes in `server/routes.ts`, served by `server/app.ts`. These are the same routes the dev server mounts in-process (`vite.config.ts`), so `npm run dev` has every capability at one address.
- **offline** → each call fails with a readable reason. `useLibrary`'s `requireServer` turns that into a toast pointing at Settings → Connections.

When both the server and the extension are present, the server carries the network. It renders headlessly with no capture window, and it re-checks every redirect hop against private addresses after a real DNS lookup, which a browser cannot do. The extension still provides the browser's bookmarks.

**Addresses** live in the URL fragment (`#/folder/abc`, see `src/lib/router.ts`), not the path. The same build is served from a static host (at a domain root or a sub-directory), from `chrome-extension://…/index.html`, from the local server, and from any static host. Only a fragment survives a reload on all of them without server-side rewrites.

## The extension bridge

```
 website tab                        content script (isolated world)        service worker
 ─────────────                      ──────────────────────────────         ──────────────
 src/lib/bridge.ts   postMessage →  src/ext/bridge-content.ts   sendMessage →  src/ext/bridge-host.ts
                     ← postMessage                               ← reply        (+ background.ts)
                                    port "bookmark-studio/events"  ←  chrome.bookmarks.on* listeners
```

- **Where it runs.** The content script is injected only into the sites in `extension/sites.json` (localhost and 127.0.0.1 by default), plus the deployed site the build was made for (`SITE_URL`). It is also injected into tabs of those sites that were already open when the extension was installed.
- **What it can do.** A fixed list of operations: `hello`, `fetch` (a guarded GET/HEAD of a public URL; body returned as base64, capped at 8 MB), `capture` (a screenshot as a data URL), `bookmarks` (one call among getTree, create, update, move, remove, removeTree), `subscribe` (forward `chrome.bookmarks` and library events), `request-access` and `request-page-access` (open the extension's own approval windows), and `library-id`, `library-pull` and `library-push` (below).
- **How it checks.** Both ends accept only messages from the same window and origin, tagged with the channel `bookmark-studio/bridge`. A local address (localhost, 127.0.0.1) is served only after the person allows that exact origin once. The service worker re-checks the sender's URL on every message, validates every payload (a fetch's timeout and size are clamped; a bookmark can only be written with an `http`, `https` or `ftp` address), applies `assertPlausiblyPublic` to every fetch and to where its redirects end, strips request headers down to `accept`, `accept-language` and `range`, and sends no cookies.
- **Events.** Bookmark listeners are registered at the top level of the service worker so a change wakes it. When the worker restarts, the content script reconnects and tells the page. The page then reconciles from the whole tree instead of trusting that no event was missed.
- **Bookmarks shim.** `src/lib/bookmarks-api.ts` gives back an object shaped like `chrome.bookmarks`: the real one inside the extension, or a bridge-backed proxy on the website. `src/lib/chrome-bookmarks.ts` therefore runs the same two-way sync in both places. On the website it starts as soon as the extension is connected, unless the person has switched it off (`wantsBrowserSync` in `shared/types.ts`). Rows synced from the browser carry `sourceId: "chrome"`; a "replace" import never deletes them.

## One library, two copies

A browser gives a website and an extension separate storage, so each keeps its own copy of the library in its own IndexedDB. While the extension is connected (and **Share one library with the extension** is on), the copies swap changes. Nothing crosses the network: both live in the same browser profile.

- **Stamps and tombstones** (`src/lib/db.ts`). Every write stamps the record with when it was written and by which copy (`syncAt`, `syncBy`, stripped on read like the other index fields), and every delete leaves a tombstone. A `["syncAt", "id"]` index answers "what changed since we last spoke".
- **The exchange** (`src/lib/replication.ts`). The website drives it, because it is the side that can reach the other. Each round pulls the extension's changes page by page (`library-pull`, at most 400 rows or 3 MB a page), merges them, then pushes its own (`library-push`). Each side remembers how far it has read. A round runs when the extension connects, after a write on either side (the extension's page tells its service worker, which tells connected sites), when the tab comes back into view, and once a minute. Web Locks keep it to one tab per site; failures back off.
- **The merge** (`src/lib/replica.ts`, pure and tested). The newer stamp wins, except that the fields a person decides (tags, folder, favourite, trash, notes, a hand-written title) follow `changedAt`, the person's last change, which `commit` sets and background work never does. A page read finishing on one side therefore cannot undo a tag added on the other. The first time two copies meet, bookmarks with the same address are combined instead of duplicated. Screenshots, offline copies and uploaded files are files only one copy has, so those fields never travel.
- **Trust.** The service worker validates every pushed row with the same repair used for stored records and accepts only `http`, `https` and `ftp` addresses. Open extension windows learn about applied changes through the same `BroadcastChannel` notice other tabs use.

## The client: the library lives in the browser

The library lives in IndexedDB (`src/lib/db.ts`). `localStorage` isn't viable: a real Chrome export embeds a base64 favicon per bookmark and blows past its ~5 MB quota within a few hundred entries. The theme is the one value kept in `localStorage`, under `bs:settings`, because `public/theme-init.js` must read it synchronously before the first paint.

| Module | Responsibility |
| --- | --- |
| `hooks/useLibrary.ts` | The single source of truth, composed from `hooks/library/`: `core.ts` (state, derivations, and `commit`, which gives persistence, an undo entry and an activity record in one place), `browser-sync.ts`, `import-export.ts` (imports, backups, exports, uploads), `editing.ts` and `background-work.ts` (jobs and the pipeline). |
| `lib/replica.ts`, `lib/replication.ts` | One library across the website and the extension: merge rules, and the exchange over the bridge. |
| `lib/engine.ts` | Selection. It builds the index, answers every filter, sort and search, and counts every facet. Nothing else in the app filters an array. |
| `lib/import/` | The 28-source import pipeline (below). |
| `lib/query.ts` | Search parsing: operators (`tag:`, `site:`, `is:`, `has:`, `kind:`, `color:`, `before:`) *and* plain English ("saved last month", "never opened"). |
| `lib/tfidf.ts`, `lib/fuzzy.ts` | Ranking and similarity, with incremental writes; typo correction against the library's own vocabulary. |
| `lib/visual.ts` | 64-bit average hash plus a 12-bin hue histogram: look-alikes and search by colour, with no model. |
| `lib/pipeline.ts` | One prioritised queue for the five background passes. |
| `lib/assets.ts` | The app's own image store, with a byte budget. |
| `lib/smart.ts` | Smart collections: a saved query, answered by the same engine as the search box. |
| `lib/share.ts`, `lib/backup.ts`, `lib/netscape.ts` | Share-as-a-page, the lossless JSON backup, and the browser bookmark HTML format. |
| `lib/sample.ts` | The sample library, written as a real bookmarks file and imported through the real pipeline. |

**Undo is a diff, not a snapshot.** An entry stores only the fields that changed, so forty entries don't hold hundreds of megabytes of favicons. Deletions are the exception and carry the whole row.

**A second tab is reconciled, not clobbered** (`lib/sync.ts`). A tab announces a change only after it is saved; the others re-read just the changed rows (and the folders and boards, when those changed). A whole-library replace reloads.

## Importing: 28 sources, one pipeline

Twenty-eight sources don't mean twenty-eight code paths. Eight browsers export the identical Netscape HTML file; what differs is *provenance*, not format. The catalogue (`lib/import/catalog.ts`) maps each source to a name, a hint about where its export lives, a detector, and the parsers to try. There are nine parsers: `netscape`, `chromium-json`, `firefox-json`, `safari-plist`, `enex`, `csv`, `json`, `x-archive` and `text-urls`. Every parser produces the same `RawItem`, and every `RawItem` goes through `normalizeItems`. That single path is where URL canonicalisation, the scheme allow-list, folder reconstruction, timestamp sanity checks, categorisation, tagging, de-duplication and provenance are handled, once.

- **Detection is a hint, never a gate.** Sources are ranked by confidence; the dialog shows the winner and the runners-up and lets you pick before anything is written.
- **The preview is the real thing.** The review step runs the actual pipeline with `previewOnly`, in a worker, so the numbers it promises are the numbers it delivers.
- **CSV columns are guessed, then editable.** The CSV parser handles quoted fields, embedded newlines and delimiters.
- **Duplicates are kept by default**, listed under Duplicates, and merged in one undoable step.
- **Imports are objects.** Every import is a sidebar row you can name, count and remove wholesale. Removing one deletes exactly the bookmarks it brought in, plus any folders it created that nothing else uses.
- **Your own order is preserved.** One counter runs through the whole file, so **As imported** reproduces the arrangement at every depth.

## Built for scale

The target is 5,000 bookmarks comfortably and 100,000 on an ordinary laptop.

- **The selection engine** (`lib/engine.ts`) lower-cases text once when the index is built, keeps each sort order as a cached permutation, and stores state, format, health and timestamps in typed arrays keyed by row position. Filtering walks the chosen order and keeps what passes, so results come out sorted without sorting. It returns an `Int32Array` of positions. `src/lib/__tests__/scale.test.ts` builds a 50,000-row library and pins the timings.
- **Windowed grid, masonry and list** (`components/app/virtual-grid.tsx`). Only rows near the viewport exist in the DOM. Overscan is measured in screens, and the mounted layer moves by `transform`.
- **Masonry without measuring.** Card heights are computed from each picture's own aspect ratio, so an arriving image never reflows the column below it.
- **Images are warmed ahead of travel**, biased in the scroll direction (`lib/prefetch.ts`).
- **Workers** handle imports, backup parsing and building the search index on large libraries.
- **One facet pass** produces every sidebar count.

## The background pipeline

A page is processed as soon as it appears (on import, paste or undo) by up to five passes:

- read the page: description, headings and text for search;
- capture a screenshot;
- check the link;
- index pictures;
- save an offline copy (off by default).

The passes share one queue (`lib/pipeline.ts`). What's on screen goes first. The queue is paced with a token bucket, capped per pass, paused when nothing is connected, and stands down while a job you started is running. It keeps going when the tab is in the background: Chrome slows a hidden tab's timers to about once a minute, so the queue waits on a timer in a small worker instead (`lib/wake.ts`).

- **Nothing is fetched twice at once.** A row being worked on is not queued again, and a page saved under several bookmarks is captured once and marked on all of them.
- **Results never overwrite newer changes.** Work can take seconds while the library keeps changing, so each result is applied as the fields that work changed, onto the row as it is now (`lib/rebase.ts`). A row deleted in the meantime stays deleted.
- **Work survives a reload.** Each pass stamps its result on the bookmark (`preview.shotAt`, `meta.fetchedAt`, `health.checkedAt`). A failure is stamped as attempted with a plain reason (`lib/failure.ts`), retried a few times, then listed for retry.

## Images live in the app, not the browser cache

Every screenshot, page image and favicon is fetched once, stored in IndexedDB beside the bookmarks, and handed to the DOM as an object URL (`lib/assets.ts`). The browser's HTTP cache is bypassed on the way in. The bytes exist in exactly one place, and that place can be measured, kept within a budget (Settings → Storage) and emptied. Past the budget, the images shown least recently are dropped first, and never one currently on screen.

## The interface and the design system

The interface uses one design system, summarised in [DESIGN.md](DESIGN.md):

- **Tokens and controls.** `src/styles/tokens.css` (every colour, shadow, radius and easing, light and dark) and `src/styles/ui.css` (toolbar buttons, menus, dialogs, inputs, segmented controls, switches, tooltips, toasts) define the system.
- **App surfaces.** `src/styles/app.css` composes the sidebar, cards, list rows, detail sheet, welcome and settings from those tokens, following the "Extending the system" recipes. No colour is hard-coded.
- **Tailwind** is kept for layout utilities only. Its colour, radius, font and type scales are mapped onto the design tokens in `src/index.css`, so a utility can only ever produce a design-system value. The design CSS sits in Tailwind's `components` layer, so utilities can still adjust layout.
- **Behaviour comes from Radix primitives** (`src/components/ui/`): focus trapping, keyboard navigation, positioning. Every visual is the design system's class.
- **Icons** are Hugeicons Free (stroke rounded) through `src/components/icons.tsx`: 16 px, 1.5 px stroke, `currentColor`, and named for what they mean in the app.
- **Fonts:** DM Sans, Newsreader and JetBrains Mono, bundled from `@fontsource-variable` (SIL Open Font License). Nothing is fetched from a font CDN.
- **Themes:** System, Light and Dark through `data-theme` on `<html>`, applied before first paint by `public/theme-init.js`.

## Builds

| Command | Output |
| --- | --- |
| `npm run build:web` | `dist/web`: the website / PWA, with a generated service worker (`scripts/build-web.mjs`) |
| `npm run build:vercel` | the website plus the extension zip beside it, for download from the site (used by `vercel.json`) |
| `npm run build:extension` | `dist/extension` and `dist/extension-firefox`, each with a zip. esbuild bundles `background.js`, `bridge.js` and `approve.js` with the served sites compiled in, and `manifest.json` is written from `extension/manifest.json` (the Firefox copy gets an event page and a gecko id, overridable with `GECKO_ID`). If `dist/web` exists, both zips are copied into it for download from the site. |
| `npm run build:server` | `dist/server/server.js`, which serves `dist/web` plus `/api/*` |
| `npm start` | builds whatever is stale, then runs the server and opens the browser (`scripts/start.mjs`) |

All builds use relative asset URLs (`base: "./"`), so one output works at any path.

## Repository layout

```
src/
  App.tsx                 the shell: one screen, many places
  main.tsx                runtime probe, transport, service worker, render
  components/
    app/                  sidebar, top bar, grid, cards, detail sheet, dialogs, settings, welcome
    ui/                   design-system primitives on Radix (button, menu, dialog, select…)
    icons.tsx             the Hugeicons set
  hooks/                  useLibrary, useTheme, useRuntime, useAsset
    library/              core (state, commit, undo), browser-sync, import-export, editing, background-work
  lib/                    engine, import, query, tfidf, visual, pipeline, assets, runtime, bridge…
  ext/                    extension service worker, bridge host and content script
  styles/                 tokens.css, ui.css, doc.css (design system) + app.css
server/                   the local server (Express + puppeteer-core)
shared/                   types and the private-address classifier, shared by the client and the server
extension/                manifest template and the list of sites the bridge serves
scripts/                  build, start, icons, smoke test
docs/                     this file, the design rules, screenshots
```
