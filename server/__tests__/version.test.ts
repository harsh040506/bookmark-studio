/**
 * One version, written once.
 *
 * `package.json` is what npm, the extension manifest and the app's About page read. The local
 * server reads `shared/version.ts`. A release that bumps one and not the other ships a server
 * that reports the wrong version to the tab talking to it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MAJOR_VERSION, VERSION } from "../../shared/version";
import { USER_AGENT } from "../safe-fetch";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("the version", () => {
  it("is the same in package.json, its lockfile and the server", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const lock = JSON.parse(read("package-lock.json")) as { version: string; packages: Record<string, { version: string }> };
    expect(VERSION).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("has an entry at the top of the changelog", () => {
    const firstHeading = read("CHANGELOG.md").match(/^## (.+)$/m)?.[1];
    expect(firstHeading).toBe(VERSION);
  });

  it("is the one the README's badge shows", () => {
    expect(read("README.md")).toContain(`version-${VERSION}-`);
  });

  it("is the one the server names itself by", () => {
    expect(USER_AGENT).toContain(`BookmarkStudio/${MAJOR_VERSION};`);
  });
});
