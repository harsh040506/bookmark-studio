/**
 * The app's motion vocabulary.
 *
 * ## Two curves and one switch, shared by everything that moves
 *
 * Motion in an interface is only legible when the same kind of change always moves the
 * same way. Components that each invent a duration produce an interface where a menu, a
 * sheet and a section header all arrive on different clocks, which reads as jitter rather
 * than as feedback. These are the only two curves: `EASE_OUT` for anything that reveals or
 * conceals, `SPRING` for anything the user is directly manipulating.
 *
 * ## Reduced motion is read from the DOM, not from props
 *
 * The app already writes a `reduce-motion` class onto `<html>` from *both* the user's
 * setting and the OS media query, and the CSS animations key off it. `useReducedMotion`
 * reads that same class, so React motion and CSS motion can never disagree, and no
 * component has to be handed the setting through four levels of props to know.
 */
import { useEffect, useState } from "react";

/** Interface reveal: fast out of the gate, long settle. Matches --ease-out-quint. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Direct manipulation: something the user pushed, arriving with a little weight. */
export const SPRING = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;

/** The reveal transition, in the one duration the app uses for it. */
export const REVEAL = { duration: 0.22, ease: EASE_OUT } as const;

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("reduce-motion"),
  );

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setReduced(root.classList.contains("reduce-motion"));
    read();
    // The class is written by the app shell in an effect, which can land after this
    // component has already mounted and read a stale value.
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return reduced;
}
