import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** Shared with `public/theme-init.js`, which reads it before the first paint. */
const STORAGE_KEY = "bs:settings";

function readPreference(): ThemePreference {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}").theme;
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function writePreference(preference: ThemePreference): void {
  try {
    const current = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, theme: preference }));
  } catch {
    // Storage blocked (private mode): the theme still applies for this session.
  }
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolve(preference: ThemePreference): Theme {
  return preference === "system" ? systemTheme() : preference;
}

/**
 * System / Light / Dark.
 *
 * ## Why this one thing is in `localStorage`
 *
 * Everything else the app stores lives in IndexedDB. The theme cannot: it has to be known
 * before the first paint, and IndexedDB is asynchronous. `public/theme-init.js` reads this
 * key and stamps `data-theme` on `<html>` before the body renders; this hook owns it after.
 *
 * "System" is a real choice, not the absence of one: it follows the machine live, so a
 * laptop that switches to dark at sunset takes an open tab with it.
 */
export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    typeof window === "undefined" ? "system" : readPreference(),
  );
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window === "undefined" ? "light" : resolve(readPreference()),
  );

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle("dark", theme === "dark");
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = theme === "dark" ? "#0b0b0b" : "#faf9f5";
    }
  }, [theme]);

  useEffect(() => {
    setTheme(resolve(preference));
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => setTheme(systemTheme());
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    writePreference(next);
    setPreferenceState(next);
  }, []);

  /** Flips between light and dark (leaving "system" behind, since a choice was made). */
  const toggleTheme = useCallback(() => {
    setPreference(theme === "dark" ? "light" : "dark");
  }, [setPreference, theme]);

  return { theme, preference, setPreference, toggleTheme };
}
