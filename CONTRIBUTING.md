# Contributing

Thanks for helping. Bookmark Studio is a small, opinionated codebase. These notes keep it that way.

## Setup

```bash
git clone https://github.com/harsh040506/bookmark-studio.git
cd bookmark-studio
npm install
npm run dev        # the app and the local API at http://localhost:5173
```

You need Node.js 20.19+ or 22.12+. Chrome or Edge is optional; it is only used for screenshot previews and the smoke test.

## Before you open a pull request

```bash
npm run check      # TypeScript, for the app and for the server
npm test           # unit tests (Vitest)
npm run build      # website, extension and server
npm run test:smoke # optional: drives the built extension and website in a real Chrome
```

All four should pass. CI runs the first three on every pull request.

## Ground rules

- **Local-first.** Nothing leaves the user's browser except requests to the sites in their own library, and only when a backend (the extension or the local server) is connected. No analytics, no third-party services, no accounts.
- **No AI or language models.** Categories come from rules, tags from term statistics, similarity from TF-IDF and perceptual hashes. Please keep it that way.
- **One codebase, three runtimes.** Anything that needs the network goes through `src/lib/api.ts`, which picks the backend (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). Never call `fetch` on another origin directly from a component.
- **The design system is the only design system.** Use the tokens in `src/styles/tokens.css` and the components in `src/styles/ui.css` and `src/components/ui/`. Don't hard-code colours, add new fonts, or mix in another icon set. Compose new surfaces from the existing tokens, as described in [docs/DESIGN.md](docs/DESIGN.md). Icons come from Hugeicons through `src/components/icons.tsx`.
- **Scale matters.** Nothing in `App.tsx` may `map`, `filter` or `sort` the whole library. Ask the selection engine (`src/lib/engine.ts`) for a subset.
- **Undo covers destructive actions.** Mutations go through `commit` in `src/hooks/useLibrary.ts`.
- **Comments explain why.** The codebase documents its decisions in place; keep doing that.

## Reporting bugs

Open an issue with your browser and version, how you run the app (website, extension, or local server), what you expected, and what happened. Please never attach your real bookmarks file. A small made-up export that reproduces the problem is perfect.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
