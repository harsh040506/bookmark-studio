/**
 * The extension's hidden page: the library with nothing drawn.
 *
 * Opened by the service worker as an offscreen document while background work is left and
 * no Bookmark Studio window is open (see `lib/background-runner.ts`). Mounting the library
 * hook is all it takes: the hook loads the library, runs the queue with the same workers a
 * window uses, saves results the same way, and reports when the queue is empty, at which
 * point the service worker closes this page.
 */
import { useLibrary } from "@/hooks/useLibrary";

export function BackgroundRunner(): null {
  useLibrary();
  return null;
}
