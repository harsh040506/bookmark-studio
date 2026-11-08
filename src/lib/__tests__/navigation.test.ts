/**
 * Addresses.
 *
 * Pure functions behind a feature that is only noticed when it misbehaves: a URL that
 * does not round-trip loses the user's place on reload and makes the Back button lie.
 */
import { describe, expect, it } from "vitest";
import { HOME, parseLocation, routeToPath, sameRoute, type Route } from "../router";

const roundTrip = (route: Route) => parseLocation(routeToPath(route));

describe("routes", () => {
  it("round-trips every kind of place", () => {
    const routes: Route[] = [
      { kind: "scope", scope: "all" },
      { kind: "scope", scope: "recent" },
      { kind: "scope", scope: "duplicates" },
      { kind: "scope", scope: "archived" },
      { kind: "folder", id: "fld_123" },
      { kind: "tag", tag: "react" },
      { kind: "category", name: "Design Inspiration" },
      { kind: "board", id: "brd_9" },
      { kind: "import", id: "imp_4" },
    ];
    for (const route of routes) {
      expect(sameRoute(roundTrip(route).route, route)).toBe(true);
    }
  });

  it("gives the library the root path", () => {
    expect(routeToPath({ kind: "scope", scope: "all" })).toBe("/");
  });

  it("keeps links clean — no query string to carry", () => {
    expect(routeToPath({ kind: "tag", tag: "react" })).toBe("/tag/react");
    expect(routeToPath({ kind: "import", id: "imp_1" })).toBe("/import/imp_1");
  });

  it("survives names that need escaping", () => {
    const route: Route = { kind: "category", name: "News & Blogs" };
    expect(routeToPath(route)).toBe("/category/News%20%26%20Blogs");
    expect(roundTrip(route).route).toEqual(route);
  });

  it("keeps a slash inside a name rather than reading it as a new segment", () => {
    const route: Route = { kind: "tag", tag: "ui/ux" };
    expect(roundTrip(route).route).toEqual(route);
  });

  it("falls back to the whole library rather than a dead end", () => {
    expect(parseLocation("/nonsense").route).toEqual(HOME);
    expect(parseLocation("/unknown/thing").route).toEqual(HOME);
    expect(parseLocation("").route).toEqual(HOME);
  });
});
