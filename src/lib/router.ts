/**
 * A very small history router.
 *
 * ## Why not a routing library
 *
 * This app has one screen with six or seven addressable states. A router package would
 * add a dependency, a provider, a matcher and a vocabulary of its own to express what is
 * written below in eighty lines — and none of its real value (nested layouts, loaders,
 * code-split routes) applies to a single-view application.
 *
 * ## What having URLs buys
 *
 * Every view is now a place: a folder, a tag, an import batch and a page of results can
 * each be linked, bookmarked in the user's *other* bookmark manager, reopened after a
 * crash, and — the one people notice — reached with the browser's Back button. Before
 * this, Back left the app entirely, which is a harsh punishment for the reflex of
 * stepping out of a folder.
 *
 * ## What is deliberately *not* in the URL
 *
 * The search box, the selection, and the scroll position. A query is a transient act,
 * not a location: coming back to a folder and finding a search still narrowing it — with
 * results that no longer match what the sidebar says is selected — is disorienting.
 * Navigating anywhere clears it. Scroll position is remembered per view by the scroller
 * itself rather than written to the address bar, because a URL that changes as you read
 * turns every scroll into a history entry and makes the Back button useless.
 */
import { useCallback, useEffect, useState } from "react";
import type { Scope } from "./engine";

export type Route =
  | { kind: "scope"; scope: Scope }
  | { kind: "folder"; id: string }
  | { kind: "tag"; tag: string }
  | { kind: "category"; name: string }
  | { kind: "board"; id: string }
  | { kind: "import"; id: string }
  /** Everything that arrived from one standing source. */
  | { kind: "source"; id: string }
  /**
   * Everything that looks like one item.
   *
   * A place rather than a panel, because "See all" on a similarity strip is a request to
   * *browse* the matches — with the format pills, the sort and the selection tools that
   * every other view has — and a strip cannot offer any of that.
   */
  | { kind: "lookalike"; id: string }
  /**
   * A collection that fills itself by rule.
   *
   * A place, like a folder, rather than a saved query the search box happens to be holding
   * — which is the whole difference between a smart collection and a bookmarked search. It
   * can be linked, reached with Back, and reopened after a reload, and the grid it shows is
   * the current answer rather than the answer as of when it was saved.
   */
  | { kind: "smart"; id: string };

export interface Location {
  route: Route;
}

export const HOME: Route = { kind: "scope", scope: "all" };

/** Scope names that are addressable as a bare path segment. */
const SCOPE_PATHS: Record<string, Scope> = {
  "": "all",
  all: "all",
  recent: "recent",
  review: "review",
  favourites: "favorites",
  duplicates: "duplicates",
  untagged: "untagged",
  archived: "archived",
  cleanup: "cleanup",
  trash: "trash",
};

const PATH_FOR_SCOPE: Record<Scope, string> = {
  all: "/",
  recent: "/recent",
  review: "/review",
  favorites: "/favourites",
  duplicates: "/duplicates",
  untagged: "/untagged",
  archived: "/archived",
  cleanup: "/cleanup",
  trash: "/trash",
};

export function routeToPath(route: Route): string {
  return (() => {
    switch (route.kind) {
      case "scope":
        return PATH_FOR_SCOPE[route.scope];
      case "folder":
        return `/folder/${encodeURIComponent(route.id)}`;
      case "tag":
        return `/tag/${encodeURIComponent(route.tag)}`;
      case "category":
        return `/category/${encodeURIComponent(route.name)}`;
      case "board":
        return `/board/${encodeURIComponent(route.id)}`;
      case "import":
        return `/import/${encodeURIComponent(route.id)}`;
      case "source":
        return `/source/${encodeURIComponent(route.id)}`;
      case "lookalike":
        return `/looks-like/${encodeURIComponent(route.id)}`;
      case "smart":
        return `/collection/${encodeURIComponent(route.id)}`;
    }
  })();
}

/**
 * Reads a location out of the address bar.
 *
 * Unknown paths resolve to the home route rather than to a not-found screen: the only
 * way to reach one here is a hand-edited URL or a link written against an older version,
 * and dropping someone into their whole library is a kinder answer than a dead end.
 */
export function parseLocation(pathname: string): Location {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (segments.length === 0) return { route: HOME };

  if (segments.length === 1) {
    const scope = SCOPE_PATHS[segments[0].toLowerCase()];
    return { route: scope ? { kind: "scope", scope } : HOME };
  }

  const [head, ...rest] = segments;
  const value = rest.join("/");
  switch (head.toLowerCase()) {
    case "folder":
      return { route: { kind: "folder", id: value } };
    case "tag":
      return { route: { kind: "tag", tag: value } };
    case "category":
      return { route: { kind: "category", name: value } };
    case "board":
      return { route: { kind: "board", id: value } };
    case "import":
      return { route: { kind: "import", id: value } };
    case "source":
      return { route: { kind: "source", id: value } };
    case "looks-like":
      return { route: { kind: "lookalike", id: value } };
    case "collection":
      return { route: { kind: "smart", id: value } };
    default:
      return { route: HOME };
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return routeToPath(a) === routeToPath(b);
}

/** A short label for the current place, used by the breadcrumb and the document title. */
export function routeKey(route: Route): string {
  return routeToPath(route);
}

export interface Router extends Location {
  /** Push a new place. `replace` avoids stacking history for incidental changes. */
  navigate: (route: Route, options?: { replace?: boolean }) => void;
}

/**
 * The path part of the current address.
 *
 * Addresses live in the fragment (`#/folder/abc`) rather than the path. The same build is
 * served from a GitHub Pages sub-directory, from the extension's `index.html`, from the
 * local server and from any static host — and only a fragment survives a reload on every
 * one of those without server-side rewrites. A path-style address from an older version is
 * still read once and folded into the fragment.
 */
export function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("/")) return hash;
  return "/";
}

export function hrefFor(route: Route): string {
  return `#${routeToPath(route)}`;
}

export function useRouter(): Router {
  const [location, setLocation] = useState<Location>(() => parseLocation(currentPath()));

  useEffect(() => {
    const onChange = () => setLocation(parseLocation(currentPath()));
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);

  const navigate = useCallback<Router["navigate"]>((route, options) => {
    const path = routeToPath(route);
    if (path === currentPath()) {
      // Re-selecting the current place must not stack a duplicate history entry, or
      // Back appears to do nothing for as many presses as the user clicked.
      setLocation({ route });
      return;
    }
    const url = `${window.location.pathname}${window.location.search}#${path}`;
    window.history[options?.replace ? "replaceState" : "pushState"]({}, "", url);
    setLocation({ route });
  }, []);

  return { ...location, navigate };
}
