# Contributing

Thanks for helping. Bookmark Studio is a small, opinionated codebase. These notes keep it that way.

## Setup

```bash
git clone https://github.com/harsh040506/bookmark-studio.git
cd bookmark-studio
npm install
npm run dev        # the app and the local API at http://localhost:5173
```

You need Node.js 22.12 or newer. Chrome or Edge is optional; it is only used for screenshot previews and the smoke test. To try the Firefox build, run `npm run build:extension` and load `dist/extension-firefox` from `about:debugging`.

## Before you open a pull request

```bash
npm run check      # TypeScript, for the app and for the server
npm test           # unit tests (Vitest)
npm run build      # website, extension and server
npm run check:site # the public pages: tags, links, sitemap, structured data, size budgets
npm run test:smoke # optional: drives the built extension and website in a real Chrome
```

All five should pass. CI runs all but the smoke test on every pull request. Coding agents: see [AGENTS.md](AGENTS.md).

## Ground rules

- **Local-first.** Nothing leaves the user's browser except requests to the sites in their own library, and only when a backend (the extension or the local server) is connected. No analytics, no third-party services, no accounts.
- **No AI or language models.** Categories come from rules, tags from a list of topics, similarity from TF-IDF and perceptual hashes. Please keep it that way.
- **One codebase, three runtimes.** Anything that needs the network goes through `src/lib/api.ts`, which picks the backend (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). Never call `fetch` on another origin directly from a component.
- **The design system is the only design system.** Use the tokens in `src/styles/tokens.css` and the components in `src/styles/ui.css` and `src/components/ui/`. Don't hard-code colours, add new fonts, or mix in another icon set. Compose new surfaces from the existing tokens, as described in [docs/DESIGN.md](docs/DESIGN.md). Icons come from Hugeicons through `src/components/icons.tsx`.
- **Scale matters.** Nothing in `App.tsx` may `map`, `filter` or `sort` the whole library. Ask the selection engine (`src/lib/engine.ts`) for a subset.
- **Undo covers destructive actions.** Mutations go through `commit` in `src/hooks/library/core.ts`, which also marks them as the person's change for the shared library.
- **Storage goes through `src/lib/db.ts`.** It stamps every write and records every delete, which is how the website and the extension keep one library. Don't write to IndexedDB around it.
- **Comments explain why.** The codebase documents its decisions in place; keep doing that.

## Reporting bugs

Open an issue with your browser and version, how you run the app (website, extension, or local server), what you expected, and what happened. Please never attach your real bookmarks file. A small made-up export that reproduces the problem is perfect.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
