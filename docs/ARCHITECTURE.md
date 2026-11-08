# How Bookmark Studio works

This is the map for contributors. Read the README first for what the app does; this is how and why.

- [One codebase, three runtimes](#one-codebase-three-runtimes)
- [The extension bridge](#the-extension-bridge)
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
| The extension's own page | direct `fetch` (host permissions lift CORS) | a brief, unfocused capture window | two-way, always on |
| The website, extension installed | relayed through the bridge | capture window, via the bridge | two-way, opt-in |
| The website, served by the local server | `/api/*` on the same origin | headless Chrome or Edge | via the extension, if installed |
| The website on its own | none: those features say how to switch them on | none | none |

Everything else — importing, searching, organising, smart collections, exporting, undo, and the visual index of pictures already stored — runs entirely in the tab and is identical in every row.

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
- **What it can do.** A fixed list of operations: `hello`, `fetch` (a guarded GET/HEAD of a public URL; body returned as base64, capped at 8 MB), `capture` (a screenshot as a data URL), `bookmarks` (one call among getTree, create, update, move, remove, removeTree) and `subscribe` (forward `chrome.bookmarks` events).
- **How it checks.** Both ends accept only messages from the same window and origin, tagged with the channel `bookmark-studio/bridge`. The service worker re-checks the sender's URL against the served sites on every message, applies `assertPlausiblyPublic` to every fetch, strips request headers down to `accept`, `accept-language` and `range`, and sends no cookies.
- **Events.** Bookmark listeners are registered at the top level of the service worker so a change wakes it. When the worker restarts, the content script reconnects and tells the page. The page then reconciles from the whole tree instead of trusting that no event was missed.
- **Bookmarks shim.** `src/lib/bookmarks-api.ts` gives back an object shaped like `chrome.bookmarks`: the real one inside the extension, or a bridge-backed proxy on the website. `src/lib/chrome-bookmarks.ts` therefore runs the same two-way sync in both places. On the website it is opt-in (Settings → Connections), because a library imported from a file shouldn't start writing into the browser unasked. Rows synced from the browser carry `sourceId: "chrome"`; a "replace" import never deletes them.

## The client: the library lives in the browser

The library lives in IndexedDB (`src/lib/db.ts`). `localStorage` isn't viable: a real Chrome export embeds a base64 favicon per bookmark and blows past its ~5 MB quota within a few hundred entries. The theme is the one value kept in `localStorage`, under `bs:settings`, because `public/theme-init.js` must read it synchronously before the first paint.

| Module | Responsibility |
| --- | --- |
| `hooks/useLibrary.ts` | The single source of truth. Every mutation goes through `commit`, which gives persistence, an undo entry and an activity record in one place. Also owns importing (`previewImport`, `importFile`, backup restore) and browser sync. |
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

**A second tab is reconciled, not clobbered** (`lib/sync.ts`). Per-row changes are re-read from the database; a whole-library replace reloads.

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

The passes share one queue (`lib/pipeline.ts`). What's on screen goes first. The queue is paced with a token bucket, capped per pass, suspended when the tab is hidden or nothing is connected, and stands down while a job you started is running. Each pass stamps its result on the bookmark (`preview.shotAt`, `meta.fetchedAt`, `health.checkedAt`), so work survives a reload. A failure is stamped as attempted, with a reason, and listed for retry.

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
| `npm run build:extension` | `dist/extension` and `dist/bookmark-studio-extension.zip`. esbuild bundles `background.js` and `bridge.js` with the served sites compiled in, and `manifest.json` is written from `extension/manifest.json`. If `dist/web` exists, the zip is copied into it for download from the site. |
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
  lib/                    engine, import, query, tfidf, visual, pipeline, assets, runtime, bridge…
  ext/                    extension service worker, bridge host and content script
  styles/                 tokens.css, ui.css, doc.css (design system) + app.css
server/                   the local server (Express + puppeteer-core)
shared/types.ts           types shared by the client and the server
extension/                manifest template and the list of sites the bridge serves
scripts/                  build, start, icons, smoke test
docs/                     this file, the design rules, screenshots
```
