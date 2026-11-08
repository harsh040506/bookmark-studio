/**
 * One Vite config, three targets.
 *
 *   - `vite`                       — development: the app plus the local API mounted in the
 *                                    same server, so every capability works at one address.
 *   - `vite build --mode web`       — the website / PWA (Vercel or any static host),
 *                                    and the client the local server serves. → dist/web
 *   - `vite build --mode extension` — the page inside the Chrome extension. → dist/extension
 *
 * `base: "./"` makes every asset URL relative, so the same output works from a domain root,
 * a sub-directory, `chrome-extension://…/index.html` and the local server.
 * Addresses inside the app live in the URL fragment (see `src/lib/router.ts`) for the same
 * reason.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/** The source repository: set explicitly, read from Vercel's Git metadata, or the default. */
const repositoryUrl =
  process.env.VITE_REPOSITORY_URL ||
  (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
    ? `https://github.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
    : "https://github.com/harsh040506/bookmark-studio");

/** The local API, mounted inside the dev server. Imported lazily so a server error cannot stop the client. */
function apiPlugin(): Plugin {
  return {
    name: "bookmark-studio-api",
    apply: "serve",
    async configureServer(server) {
      const { createApiApp } = await import("./server/app");
      server.middlewares.use(createApiApp());
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const target = mode === "extension" ? "extension" : "web";
  return {
    base: "./",
    plugins: [react(), tailwindcss(), apiPlugin()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
      },
    },
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
      "import.meta.env.VITE_REPOSITORY_URL": JSON.stringify(repositoryUrl),
      "import.meta.env.VITE_TARGET": JSON.stringify(command === "serve" ? "dev" : target),
    },
    // The extension never uses the PWA files; the website never ships the extension manifest.
    publicDir: "public",
    build: {
      outDir: path.resolve(import.meta.dirname, target === "extension" ? "dist/extension" : "dist/web"),
      emptyOutDir: true,
      target: "es2022",
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          // Vendor code split out so an app edit does not invalidate it in the browser cache.
          manualChunks(id: string) {
            if (!id.includes("node_modules")) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
            if (/[\\/]node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return "motion";
            if (id.includes("@hugeicons")) return "icons";
            if (id.includes("@radix-ui") || id.includes("cmdk")) return "radix";
            return undefined;
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: false,
    },
  };
});
