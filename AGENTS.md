# AGENTS.md

Notes for coding agents (and people) working in this repository. The README describes the product; this file describes how to change it safely.

## What this is

Bookmark Studio is a local-first bookmark manager. One TypeScript codebase ships three ways:

- **Website / PWA** (`dist/web`), hosted statically on Vercel.
- **Browser extension** (`dist/extension` for Chromium browsers, `dist/extension-firefox` for Firefox 128+), Manifest V3.
- **Local server** (`dist/server`), Express plus puppeteer-core, serving the website build and an `/api` for page reading, link checks and screenshots.

`src/lib/runtime.ts` decides at load which backend answers network questions. The library itself always lives in the user's browser (IndexedDB, `src/lib/db.ts`). There is no account, no remote database and no analytics.

## Layout

| Path | Contents |
| --- | --- |
| `src/App.tsx`, `src/components/` | The interface. `components/ui/` are the design-system controls |
| `src/hooks/useLibrary.ts` | Puts the library hooks together. `hooks/library/core.ts` holds state and `commit` (every mutation, with undo); `browser-sync`, `import-export`, `editing` and `background-work` add their actions |
| `src/lib/` | Engine, search, import (`lib/import/`), storage, sync, network guard, logging |
| `src/ext/` | Extension service worker and bridge |
| `src/styles/` | Design tokens and component CSS. The only styling source |
| `server/` | Local server: routes, SSRF-safe fetch, tab pool, circuit breaker, logs |
| `shared/` | Types (`types.ts`) and the private-address classifier (`ip.ts`), shared by client and server |
| `site/` | The public pages (about, privacy, 404), their CSS and JS, and the content they are generated from |
| `scripts/` | Build steps, the smoke test, icon and media capture |
| `public/` | Static files copied into the website build, including `og/` and `media/` images |
| `docs/` | Architecture, design rules, README media |

## Commands

```bash
npm install
npm run dev          # app + local API on http://localhost:5173
npm run check        # TypeScript for client and server
npm test             # Vitest unit tests (src/**, server/**, site/**)
npm run build        # web, extension (Chrome and Firefox), server
npm run check:site   # verifies the built public site: tags, links, sitemap, JSON-LD, budgets
npm run test:smoke   # real Chrome: loads the extension and the website (needs Chrome or Edge)
npm run media        # re-shoots README and site images (needs the build, Chrome, and `npm i --no-save sharp`)
```

Run `check`, `test`, `build` and `check:site` before calling a change done. CI runs the same.

**Releasing:** the version is written in `package.json` (and its lockfile), `shared/version.ts`, the README badge and the top heading of `CHANGELOG.md`. `server/__tests__/version.test.ts` fails if they disagree.

## Rules that matter

- **Nothing leaves the browser** except requests to sites in the user's own library, and only when a backend is connected. No analytics, telemetry, third-party scripts, fonts or CDNs. The website's Content Security Policy (`vercel.json`) enforces `'self'` only.
- **No AI or language models.** Classification is rules and a topic vocabulary (`src/lib/classify.ts`); similarity is TF-IDF and perceptual hashes.
- **Network access goes through `src/lib/api.ts`**, never a direct cross-origin `fetch` in a component. On the server, every outbound request goes through `server/safe-fetch.ts`.
- **Never more than five browser pages loading at once**, and a browser is fully closed before another opens. `server/tab-pool.ts` and the window gate in `src/ext/background.ts` enforce this; don't bypass them.
- **Scale:** nothing in `App.tsx` may map, filter or sort the whole library. Ask `src/lib/engine.ts` for subsets. Libraries of 100k bookmarks must stay responsive.
- **Folder trees are walked with loops, never recursion**, and through the helpers in `src/lib/library.ts` (paths, totals, subtrees, ancestors, `folderMoveProblem`). A tree can arrive thousands of levels deep or with loops from a backup, the browser or the other copy. Choosing a folder in the interface is always `src/components/app/folder-picker.tsx`, never a plain select: there can be thousands.
- **Storage writes** go through `writeKeyed` in `src/lib/db.ts` so failed writes are tracked and retried. Records read back are repaired by `src/lib/repair.ts`; extend it when the record shape changes.
- **One library, two copies.** The website and the extension each store the library and swap changes (`src/lib/replica.ts`, `replication.ts`). Every write is stamped in `db.ts` and every delete leaves a tombstone, so never write or delete library records around the `db.ts` functions. Person-made changes go through `commit`, which sets `changedAt`; background results must not.
- **Design system only.** Tokens from `src/styles/tokens.css`, controls from `src/components/ui/`, icons from `src/components/icons.tsx`. See `docs/DESIGN.md`. Both themes must work.
- **Public pages are generated.** Edit `site/content.mjs`, not the HTML in `dist/`. Titles and descriptions must stay unique, and every claim must be true of the code.
- **Comments explain why**, not what.

## Safety

- Imported files are untrusted. Importers allow only `http`, `https` and `ftp` URLs.
- Don't log full URLs: use `src/lib/log.ts` (client) and `server/log.ts` (server), which cut addresses to the site name.
- Don't commit secrets, `.env` files, real bookmark exports, or anything under `.cache/` or `dist/`.
- The local server binds to `127.0.0.1` by default. Don't change that default.
