/**
 * The version, for code that is not built by Vite.
 *
 * The app's own pages get the version injected from `package.json` at build time. The local
 * server is bundled separately and used to carry its own copy of the number, which was one
 * more place to forget on every release. `server/__tests__/version.test.ts` fails if this
 * and `package.json` ever disagree.
 */
export const VERSION = "6.0.0";

/** "6", for the name the local server gives the sites it reads. */
export const MAJOR_VERSION = VERSION.split(".")[0];
