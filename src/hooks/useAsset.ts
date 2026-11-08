/**
 * One stored image, as a source string.
 *
 * The single-tier counterpart to the chain inside a card's preview: give it a key and the
 * endpoint that can supply the bytes, and get back an object URL from the app's own store
 * — synchronously if the bytes are already materialised, which is the usual case for
 * anything the grid has shown.
 *
 * `null` means the source genuinely has nothing to give (a page with no screenshot yet),
 * which is a real answer and distinct from `pending`.
 */
import { useEffect, useState } from "react";
import { ensureAsset, peekAsset, subscribeAsset } from "../lib/assets";

export function useAsset(
  key: string | null,
  remoteUrl: string | null,
  enabled = true,
): { source: string | null; pending: boolean } {
  const [source, setSource] = useState<string | null>(() =>
    key && enabled ? (peekAsset(key) ?? null) : null,
  );
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!key || !remoteUrl || !enabled) {
      setSource(null);
      setPending(false);
      return;
    }

    let cancelled = false;

    const resolve = () => {
      const immediate = peekAsset(key);
      if (immediate) {
        setSource(immediate);
        setPending(false);
        return;
      }
      setPending(true);
      void ensureAsset(key, remoteUrl).then((url) => {
        if (cancelled) return;
        setSource(url);
        setPending(false);
      });
    };

    resolve();
    // A later capture, or an invalidation after "refresh screenshot", both arrive here.
    const unsubscribe = subscribeAsset(key, () => {
      if (!cancelled) resolve();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [key, remoteUrl, enabled]);

  return { source, pending };
}
