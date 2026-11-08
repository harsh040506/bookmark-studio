/**
 * Everything that puts a picture on screen: favicons, card thumbnails, and the detail
 * panel's large preview.
 *
 * ## One resolver, three sizes
 *
 * A bookmark's picture comes from one of four places, in this order:
 *
 *   1. **Bytes this library owns** — an uploaded image, a stored video's poster frame.
 *   2. **A headless-browser screenshot**, captured by the local server. Measured against a
 *      real library, roughly 85% of bookmarked sites refuse to be framed, so this is the
 *      only tier that works for most of the web.
 *   3. **The page's own og:image**, found by the scraper.
 *   4. **A favicon plate** — the site's icon on a tinted ground, which is not a fallback
 *      so much as the honest answer for a page that has no picture.
 *
 * That chain used to be written out separately in the card, the list row, the lightbox and
 * the detail panel, and the four had already drifted: one preferred the og:image over a
 * screenshot, one forgot the device dimension, one never showed a plate. It is written
 * once here and parameterised by size.
 *
 * ## Why the bytes come from the asset store, never from `<img src="https://…">`
 *
 * The store is the library's own copy: it survives the browser cache being cleared, it can
 * be counted and budgeted, it works offline, and — for a grid that mounts and unmounts
 * hundreds of images while scrolling — it answers synchronously once warm, so a card that
 * scrolls back into view paints in the same frame rather than flashing empty.
 */
import { FileText, ImageOff, Play } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Bookmark, DeviceName } from "@shared/types";
import { useAsset } from "@/hooks/useAsset";
import { proxiedImage, screenshotUrl } from "@/lib/api";
import { assetKey, assetMissed, ensureAsset, peekAsset, subscribeAsset } from "@/lib/assets";
import { cn, faviconFor, hashUnit } from "@/lib/utils";

/** The design system's category tints, light + dark (tokens.css `--hue-*`). */
const HUES = ["gray", "red", "orange", "yellow", "green", "aqua", "blue", "violet", "magenta"] as const;

/* ---------------------------------------------------------------- favicon */

/**
 * A tinted square with the first letter, shown while an icon resolves or fails.
 *
 * Exported because it is also the sidebar's source mark. A rail of identical grey trays
 * makes eight sources look like one thing eight times; a stable colour per name is what
 * lets somebody find "Raindrop" in the rail without reading it.
 */
export function FaviconPlate({
  label,
  size,
  className,
  muted,
}: {
  label: string;
  size: number;
  className?: string;
  muted?: boolean;
}) {
  const letter = label.trim().charAt(0).toUpperCase() || "•";
  /*
   * A hue from the name, so the same site is always the same colour.
   *
   * A hash rather than a palette lookup: a fixed palette assigns two adjacent sites the
   * same swatch often enough to be confusing, and the point of the plate is recognition.
   */
  const hue = HUES[Math.floor(hashUnit(label) * HUES.length) % HUES.length];

  return (
    <span
      aria-hidden
      className={cn("bs-plate", muted && "is-muted", className)}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.52), background: `var(--hue-${hue})` }}
    >
      {letter}
    </span>
  );
}

export function Favicon({
  bookmark,
  size = 16,
  className,
}: {
  bookmark: Pick<Bookmark, "icon" | "domain" | "title">;
  size?: number;
  className?: string;
}) {
  const embedded = bookmark.icon;
  const key = embedded || !bookmark.domain ? null : assetKey("icon", bookmark.domain);

  const [source, setSource] = useState<string | null>(
    () => embedded ?? (key ? (peekAsset(key) ?? null) : null),
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (embedded) {
      setSource(embedded);
      setFailed(false);
      return;
    }
    if (!key) {
      setSource(null);
      return;
    }

    let cancelled = false;
    const immediate = peekAsset(key);
    if (immediate) {
      setSource(immediate);
      setFailed(false);
      return;
    }
    setSource(null);
    const remote = faviconFor(bookmark.domain);
    if (!remote) {
      setFailed(true);
      return;
    }
    void ensureAsset(key, remote).then((url) => {
      if (cancelled) return;
      if (url) setSource(url);
      else setFailed(true);
    });
    const unsubscribe = subscribeAsset(key, () => {
      const next = peekAsset(key);
      if (next && !cancelled) setSource(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [embedded, key, bookmark.domain]);

  if (failed || (!source && !key)) {
    return <FaviconPlate label={bookmark.domain || bookmark.title} size={size} className={className} />;
  }
  if (!source) {
    // A plate of the right size while the icon resolves, so nothing on the row moves when
    // it lands. An empty box here would make every list reflow as its icons arrive.
    return (
      <FaviconPlate label={bookmark.domain || bookmark.title} size={size} className={className} muted />
    );
  }
  return (
    <img
      src={source}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      /*
       * Favicons sit on a white chip.
       *
       * They are drawn for a light page — GitHub's, Vercel's and most others are a black
       * mark on transparency — so on a near-black card they render as nothing at all,
       * leaving a hole where the mark should be. Compositing is not available to us, so
       * the chip is: white in both themes, with a hairline in dark so it reads as an icon
       * tile rather than as a bright square, and a pixel of padding so the mark is not
       * flush against its own edge.
       */
      className={cn("bs-favicon", className)}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}

/* -------------------------------------------------------------- thumbnails */

export interface PictureSource {
  /** Asset-store key, or null when this row has no picture at all. */
  key: string | null;
  /** Where the bytes come from on a miss. Empty for bytes the library already owns. */
  remote: string;
  /** Whether the source is a stored video rather than a still. */
  video: boolean;
}

/**
 * Which picture a row should show, and where its bytes come from.
 *
 * Pure and cheap, so the grid can call it per visible card on every render without
 * memoising — and so the prefetcher can call it for rows that are not mounted yet.
 */
export function pictureFor(bookmark: Bookmark, device: DeviceName): PictureSource {
  const media = bookmark.media;
  if (media?.assetKey) {
    return {
      key: media.posterKey ?? media.assetKey,
      remote: "",
      video: Boolean(media.mime?.startsWith("video/")),
    };
  }
  /*
   * A screenshot only counts if it was taken at *this* viewport.
   *
   * A mobile and a desktop capture are different pictures under different keys, so "has a
   * screenshot" is only ever true of a device. Without the check, switching the preview
   * device leaves every card requesting a capture that was never rendered.
   */
  const shotDevice = bookmark.preview.shotDevice ?? "desktop";
  if (bookmark.preview.shotAt && shotDevice === device) {
    return {
      key: assetKey("shot", bookmark.url, device),
      remote: screenshotUrl(bookmark.url, device, "cached"),
      video: false,
    };
  }
  if (bookmark.preview.imageUrl) {
    return {
      key: assetKey("image", bookmark.preview.imageUrl),
      remote: proxiedImage(bookmark.preview.imageUrl),
      video: false,
    };
  }
  return { key: null, remote: "", video: false };
}

/**
 * A card's picture.
 *
 * Lazy in three senses at once: the asset is only requested when `enabled` (the grid turns
 * it off for rows outside the warm band), the `<img>` carries `loading="lazy"` so a
 * mounted-but-offscreen row costs nothing, and decoding is asynchronous so a burst of
 * cards arriving together cannot block a frame.
 */
export function Thumbnail({
  bookmark,
  device,
  enabled = true,
  className,
  rounded = "rounded-[inherit]",
}: {
  bookmark: Bookmark;
  device: DeviceName;
  enabled?: boolean;
  className?: string;
  rounded?: string;
}) {
  const picture = useMemo(() => pictureFor(bookmark, device), [bookmark, device]);
  const missed = picture.key ? assetMissed(picture.key) : false;
  const { source, pending } = useAsset(
    picture.key,
    picture.remote || (picture.key ? "" : null),
    enabled && !missed,
  );

  if (!picture.key || missed || (!source && !pending)) {
    return <PlatePreview bookmark={bookmark} className={cn(className, rounded)} />;
  }

  if (!source) {
    return (
      <div className={cn("bs-ph size-full", className, rounded)} aria-hidden />
    );
  }

  return (
    <div className={cn("relative size-full overflow-hidden", className, rounded)}>
      <img
        src={source}
        alt={bookmark.alt ?? ""}
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
      />
      {picture.video ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="bs-play">
            <Play size={15} />
          </span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The card for a page with no picture.
 *
 * Deliberately not an empty grey rectangle: a favicon on a ground tinted from the domain
 * is recognisable at a glance and makes a grid of un-captured links still scannable, which
 * is the state a freshly imported library is in for its first few minutes.
 */
export function PlatePreview({ bookmark, className }: { bookmark: Bookmark; className?: string }) {
  const label = bookmark.domain || bookmark.title || "•";
  const hue = HUES[Math.floor(hashUnit(label) * HUES.length) % HUES.length];

  const isNote = !bookmark.url && Boolean(bookmark.text);

  return (
    <div
      className={cn("bs-plate-preview", className)}
      style={{ ["--plate" as string]: `var(--hue-${hue})` }}
    >
      {isNote ? (
        <>
          <FileText size={20} className="text-text-3" />
          <p className="bs-plate-note line-clamp-4">
            {bookmark.text}
          </p>
        </>
      ) : bookmark.domain ? (
        <>
          <Favicon bookmark={bookmark} size={26} />
          <span className="bs-plate-domain">
            {bookmark.domain}
          </span>
        </>
      ) : (
        <ImageOff size={20} className="text-text-3" />
      )}
    </div>
  );
}

/* ----------------------------------------------------------- large preview */

export type PreviewTier = "screenshot" | "snapshot" | "card";

export const DEVICE_WIDTHS: Record<DeviceName, number> = {
  desktop: 1280,
  tablet: 834,
  mobile: 414,
};

/**
 * The detail panel's picture.
 *
 * The same resolver as the thumbnail, at a size where a screenshot is actually readable,
 * plus a label naming which tier is on screen — so a cached capture from last week is
 * never mistaken for the live page.
 */
export function PreviewSurface({
  bookmark,
  device,
  className,
}: {
  bookmark: Bookmark;
  device: DeviceName;
  className?: string;
}) {
  const picture = useMemo(() => pictureFor(bookmark, device), [bookmark, device]);
  const { source, pending } = useAsset(picture.key, picture.remote || (picture.key ? "" : null));
  const videoRef = useRef<HTMLVideoElement>(null);
  const { source: videoSource } = useAsset(
    picture.video ? (bookmark.media?.assetKey ?? null) : null,
    picture.video ? "" : null,
  );

  const tier: PreviewTier = bookmark.media?.assetKey
    ? "screenshot"
    : bookmark.preview.shotAt && (bookmark.preview.shotDevice ?? "desktop") === device
      ? "screenshot"
      : bookmark.preview.imageUrl
        ? "snapshot"
        : "card";

  if (picture.video && videoSource) {
    return (
      <div className={cn("bs-preview", className)}>
        <video
          ref={videoRef}
          src={videoSource}
          controls
          playsInline
          poster={source ?? undefined}
          className="size-full object-contain"
        />
      </div>
    );
  }

  return (
    <div className={cn("bs-preview", className)}>
      {source ? (
        <img src={source} alt={bookmark.alt ?? bookmark.title} className="size-full object-cover object-top" />
      ) : pending ? (
        <div className="bs-ph size-full" aria-hidden />
      ) : (
        <PlatePreview bookmark={bookmark} />
      )}
      <span className="bs-tier">
        {tier === "screenshot" ? "Screenshot" : tier === "snapshot" ? "Page image" : "No preview"}
      </span>
    </div>
  );
}
