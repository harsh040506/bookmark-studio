/**
 * Test configuration, kept apart from the build.
 *
 * Vitest's defaults would collect from the whole tree. The suite is therefore pinned to
 * this project's own source rather than left to discovery — which is what kept a vendored
 * reference app's `node --test` suite from being collected here and reporting eighteen
 * failures that had nothing to do with this codebase. That folder is gone, but an
 * explicit include is the right default regardless: a test run that is always red is one
 * nobody reads.
 *
 * A separate file rather than a `test` key in `vite.config.ts` so the build config keeps
 * its own type and needs no triple-slash reference to widen it.
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}", "server/**/*.{test,spec}.ts", "site/**/*.{test,spec}.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
