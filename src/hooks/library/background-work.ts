/**
 * Reading pages, checking links, screenshots, picture indexing and offline copies, both
 * as jobs the person starts and as the background pipeline.
 */
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  hasPage,
  type Bookmark,
  type DeviceName,
  
  
  
} from "../../../shared/types";
import * as api from "../../lib/api";
import {
  assetKey,
  ensureAsset,
  forgetAsset,
  getAssetBlob,
  pinAsset,
  putAssetBlob,
} from "../../lib/assets";
import {
  configurePipeline,
  observeLibrary,
  setPipelineHidden,
  setPipelineOnline,
  setPipelineSettings,
  subscribePipeline,
  yieldPipeline,
} from "../../lib/pipeline";
import { forgetPrefetch } from "../../lib/prefetch";
import { captureResultPairs } from "../../lib/rebase";
import { friendlyFailure } from "../../lib/failure";
import { applyPageMetadata } from "../../lib/enrich";
import { chunk } from "../../lib/utils";
import { groupLookalikes, indexImage } from "../../lib/visual";
import { IDLE_JOB, JOB_CAPTURE_BATCH, JOB_ENRICH_BATCH, JOB_HEALTH_BATCH } from "./shared";
import type { LibraryCore } from "./core";

export function useBackgroundWork(core: LibraryCore) {
  const {
    bookmarks,
    settings,
    runtime,
    loading,
    job,
    setJob,
    serverStatus,
    setServerStatus,
    setPipeline,
    cancelJob,
    bookmarksRef,
    settingsRef,
    logActivity,
    commit,
    commitDerived,
    undo,
  } = core;

  /* ----------------------------------------------------------------- jobs -- */

  const requireServer = useCallback(async (what: string) => {
    const status = await api.getServerStatus();
    setServerStatus(status);
    if (!status.online) {
      toast.error(`${what} needs the extension or the local server`, {
        description:
          "A web page cannot read other sites on its own. Add the Bookmark Studio extension, or run the local server (npm start). Settings → Connections explains both.",
        duration: 8000,
      });
      return false;
    }
    return true;
  }, []);

  const stopJob = useCallback(() => {
    cancelJob.current = true;
  }, []);

  /**
   * Checks one batch of links and folds the answers in.
   *
   * Shared by the visible job and the background pipeline, which matters more than it
   * sounds: two implementations of "what a health result means" would drift, and the one
   * nobody watches would be the one that drifted. Bookmarks are grouped by URL first, so a
   * library with the same link filed in four places costs one request rather than four.
   */
  const checkBatch = useCallback(
    async (targets: Bookmark[]): Promise<{ updated: number; dead: number }> => {
      const byUrl = new Map<string, Bookmark[]>();
      for (const bookmark of targets) {
        if (!hasPage(bookmark)) continue;
        const list = byUrl.get(bookmark.url) ?? [];
        list.push(bookmark);
        byUrl.set(bookmark.url, list);
      }
      if (!byUrl.size) return { updated: 0, dead: 0 };

      const { results } = await api.checkHealth([...byUrl.keys()]);
      const pairs: { before: Bookmark; after: Bookmark }[] = [];
      let dead = 0;
      for (const result of results) {
        for (const bookmark of byUrl.get(result.url) ?? []) {
          if (result.status === "dead") dead += 1;
          pairs.push({ before: bookmark, after: {
            ...bookmark,
            health: {
              ...bookmark.health,
              status: result.status,
              httpCode: result.httpCode,
              finalUrl: result.finalUrl,
              redirectCount: result.redirectCount,
              checkedAt: Date.now(),
              error: result.error,
            },
          } });
        }
      }

      commitDerived({ label: "Link check", kind: "health", pairs });
      // Counted from what was asked, not what was written: a row deleted mid-check is
      // finished as far as the queue is concerned.
      return { updated: pairs.length, dead };
    },
    [commitDerived],
  );

  const runHealthCheck = useCallback(
    async (targets: Bookmark[]) => {
      const usable = targets.filter(hasPage);
      if (!usable.length) {
        toast("Nothing here has a link to check");
        return;
      }
      if (!(await requireServer("Link checking"))) return;

      cancelJob.current = false;
      setJob({ running: true, done: 0, total: usable.length, label: "Checking links", failed: 0 });

      let done = 0;
      let dead = 0;
      for (const batch of chunk(usable, JOB_HEALTH_BATCH)) {
        if (cancelJob.current) break;
        try {
          const result = await checkBatch(batch);
          dead += result.dead;
        } catch {
          setJob((current) => ({ ...current, failed: current.failed + batch.length }));
        }
        done += batch.length;
        setJob((current) => ({ ...current, done: Math.min(done, usable.length) }));
      }

      setJob(IDLE_JOB);
      logActivity("health", `Checked ${done} links`, done);
      toast.success("Link check finished", {
        description: dead ? `${dead} link${dead === 1 ? "" : "s"} did not respond` : "Everything responded",
      });
    },
    [checkBatch, logActivity, requireServer],
  );

  /**
   * Captures one batch of screenshots and returns the URLs that landed.
   *
   * The `forgetAsset` call is the non-obvious part: the screenshot endpoint's URL does not
   * change when a page is re-rendered, so nothing about the `src` would tell a card the
   * bytes behind it are now different — and a card that asked a moment ago and got "not
   * captured yet" is holding a remembered miss that would keep it grey.
   */
  const captureBatch = useCallback(
    async (batch: Bookmark[], device: DeviceName): Promise<string[]> => {
      const pages = batch.filter(hasPage);
      if (!pages.length) return [];
      const { results } = await api.captureScreenshots(
        pages.map((bookmark) => bookmark.url),
        device,
      );
      const pairs = captureResultPairs(bookmarksRef.current, results, device);

      const capturedUrls = [...new Set(results.filter((result) => result.ok).map((result) => result.url))];
      for (const url of capturedUrls) {
        const key = assetKey("shot", url, device);
        forgetPrefetch(key);
        void forgetAsset(key);
      }

      commitDerived({ label: "Preview capture", kind: "capture", pairs });
      // The URLs, not a count: the pipeline needs to know *which* pages to stop asking
      // about, and a count silently attributes success to whichever rows come first.
      return capturedUrls;
    },
    [commitDerived],
  );

  const runCapture = useCallback(
    async (targets: Bookmark[], deviceOverride?: DeviceName) => {
      const usable = targets.filter(hasPage);
      if (!usable.length) {
        toast("Nothing here has a page to capture");
        return;
      }
      // Capture at the viewport the library is *showing*: the grid resolves its previews
      // through `previewDevice`, so a hardcoded default renders pictures no card requests.
      const device = deviceOverride ?? settingsRef.current.previewDevice;
      const status = await api.getServerStatus();
      setServerStatus(status);
      if (!status.online) {
        toast.error("Capturing previews needs the local server");
        return;
      }
      if (!status.screenshots) {
        toast.error("No Chrome or Edge installation found", {
          description: "Screenshots need a local Chrome/Edge. Set CHROME_PATH to point at one.",
        });
        return;
      }

      cancelJob.current = false;
      setJob({ running: true, done: 0, total: usable.length, label: "Capturing previews", failed: 0 });

      let done = 0;
      let failed = 0;
      for (const batch of chunk(usable, JOB_CAPTURE_BATCH)) {
        if (cancelJob.current) break;
        try {
          const captured = await captureBatch(batch, device);
          failed += batch.length - captured.length;
        } catch {
          failed += batch.length;
        }
        done += batch.length;
        setJob((current) => ({ ...current, done: Math.min(done, usable.length), failed }));
      }

      setJob(IDLE_JOB);
      logActivity("capture", `Captured ${done - failed} previews`, done - failed);
      toast.success("Preview capture finished", {
        description: failed ? `${failed} could not be captured` : `${done} pages captured`,
      });
    },
    [captureBatch, logActivity],
  );

  /**
   * Reads one page and folds what it says into the bookmark.
   *
   * This is the whole "intelligence" of the app in one function, and none of it is a
   * model: the description is the page's own, the tags are its keywords and headings, and
   * the body text is stored so search can find a bookmark by words that appear nowhere in
   * its title.
   */
  const enrichOne = useCallback(async (bookmark: Bookmark): Promise<Bookmark> => {
    const metadata = await api.fetchMetadata(bookmark.url);
    if (metadata.error) throw new Error(metadata.error);
    return applyPageMetadata(bookmark, metadata);
  }, []);

  /**
   * Reads a batch of pages.
   *
   * Returns two numbers because two callers need different things: a progress bar wants
   * `succeeded`, the background queue wants `recorded` — how many rows it can stop asking
   * about, which includes failures, because a page that cannot be reached is stamped as
   * attempted precisely so it is not tried forever.
   */
  const enrichBatch = useCallback(
    async (batch: Bookmark[], silent: boolean): Promise<{ succeeded: number; recorded: number }> => {
      const pages = batch.filter(hasPage);
      if (!pages.length) return { succeeded: 0, recorded: batch.length };

      const settled = await Promise.allSettled(pages.map(enrichOne));
      const pairs = settled.flatMap((entry, position) =>
        entry.status === "fulfilled" ? [{ before: pages[position], after: entry.value }] : [],
      );
      const updates = commitDerived({ label: "Page details", kind: "enrich", pairs, reindex: true });

      const failures = settled
        .map((entry, position) =>
          entry.status === "rejected"
            ? { row: pages[position], reason: String(entry.reason?.message ?? entry.reason) }
            : null,
        )
        .filter((entry): entry is { row: Bookmark; reason: string } => entry !== null);

      if (failures.length && silent) {
        commitDerived({
          label: "Unreadable pages",
          kind: "enrich",
          pairs: failures.map(({ row, reason }) => ({
            before: row,
            after: {
              ...row,
              enriched: true,
              meta: { ...row.meta, fetchedAt: Date.now(), error: friendlyFailure(reason) },
            },
          })),
        });
      }
      return {
        succeeded: updates.length,
        recorded: silent ? pairs.length + failures.length : pairs.length,
      };
    },
    [commitDerived, enrichOne],
  );

  const runEnrichment = useCallback(
    async (targets: Bookmark[]) => {
      const usable = targets.filter(hasPage);
      if (!usable.length) {
        toast("Nothing here has a page to read");
        return;
      }
      if (!(await requireServer("Reading pages"))) return;

      cancelJob.current = false;
      setJob({ running: true, done: 0, total: usable.length, label: "Reading pages", failed: 0 });

      let done = 0;
      let failed = 0;
      for (const batch of chunk(usable, JOB_ENRICH_BATCH)) {
        if (cancelJob.current) break;
        const { succeeded } = await enrichBatch(batch, true);
        failed += batch.length - succeeded;
        done += batch.length;
        setJob((current) => ({ ...current, done: Math.min(done, usable.length), failed }));
      }

      setJob(IDLE_JOB);
      logActivity("enrich", `Read ${done - failed} pages`, done - failed);
      toast.success("Finished reading pages", {
        description: failed ? `${failed} could not be read` : undefined,
      });
    },
    [enrichBatch, logActivity, requireServer],
  );

  /* --------------------------------------------------------- visual index -- */

  /**
   * Builds the perceptual hash and colour histogram for one row's picture.
   *
   * Reads the bytes the asset store already holds rather than the network: by the time a
   * card has been on screen its image is materialised, so indexing is a canvas draw and a
   * few hundred arithmetic operations with no request at all.
   */
  const indexVisual = useCallback(async (row: Bookmark): Promise<Bookmark | null> => {
    const key =
      row.media?.posterKey ??
      row.media?.assetKey ??
      (row.preview.shotAt
        ? assetKey("shot", row.url, settingsRef.current.previewDevice)
        : row.preview.imageUrl
          ? assetKey("image", row.preview.imageUrl)
          : null);
    if (!key) return null;

    const source = await ensureAsset(
      key,
      row.media?.assetKey
        ? ""
        : row.preview.shotAt
          ? api.screenshotUrl(row.url, settingsRef.current.previewDevice, "cached")
          : api.proxiedImage(row.preview.imageUrl ?? ""),
    );
    if (!source) return null;

    const visual = await indexImage(source);
    if (!visual) return null;
    return { ...row, visual };
  }, []);

  const runVisualIndex = useCallback(
    async (targets?: Bookmark[]) => {
      const pending = (targets ?? bookmarksRef.current).filter(
        (row) =>
          !row.trashedAt &&
          !row.visual?.at &&
          (row.media?.assetKey || row.preview.shotAt || row.preview.imageUrl),
      );
      if (!pending.length) {
        toast("Every picture is already indexed");
        return;
      }

      cancelJob.current = false;
      setJob({ running: true, done: 0, total: pending.length, label: "Indexing pictures", failed: 0 });

      let done = 0;
      let failed = 0;
      for (const group of chunk(pending, 8)) {
        if (cancelJob.current) break;
        const settled = await Promise.all(group.map(indexVisual));
        const pairs = settled.flatMap((row, position) => (row ? [{ before: group[position], after: row }] : []));
        failed += group.length - pairs.length;
        commitDerived({ label: "Picture index", kind: "enrich", pairs });
        done += group.length;
        setJob((current) => ({ ...current, done: Math.min(done, pending.length), failed }));
      }

      setJob(IDLE_JOB);
      toast.success("Finished indexing pictures", {
        description: failed ? `${failed} could not be read` : `${done - failed} indexed`,
      });
    },
    [commitDerived, indexVisual],
  );

  /**
   * Collapses groups of the same picture saved more than once.
   *
   * The visual counterpart to `dedupeLibrary`, and it catches what that cannot: a
   * screenshot pasted from three places has three different URLs, or none, so comparing
   * addresses finds nothing.
   */
  const mergeLookalikes = useCallback((): number => {
    const groups = groupLookalikes(bookmarksRef.current, settingsRef.current.lookalikeThreshold);
    if (!groups.length) {
      toast("No look-alike pictures found");
      return 0;
    }

    const keep: Bookmark[] = [];
    const remove: string[] = [];
    for (const group of groups) {
      keep.push({
        ...group.keep,
        tags: [...new Set([...group.keep.tags, ...group.rest.flatMap((row) => row.tags)])].slice(0, 24),
        boardIds: [...new Set([...group.keep.boardIds, ...group.rest.flatMap((row) => row.boardIds)])],
        note: group.keep.note ?? group.rest.find((row) => row.note)?.note,
        favorite: [group.keep, ...group.rest].some((row) => row.favorite) || undefined,
      });
      for (const row of group.rest) remove.push(row.id);
    }

    commit({
      label: `Merged ${groups.length} group${groups.length === 1 ? "" : "s"} of look-alikes`,
      kind: "delete",
      next: keep,
      remove,
    });
    toast.success(`Removed ${remove.length} duplicate picture${remove.length === 1 ? "" : "s"}`, {
      description: `${groups.length} group${groups.length === 1 ? "" : "s"} collapsed — the original was kept.`,
      action: { label: "Undo", onClick: () => undo() },
    });
    return remove.length;
  }, [commit, undo]);

  /* --------------------------------------------------------- offline copy -- */

  /**
   * Saves a page as a self-contained file that opens with the network off.
   *
   * Stored and pinned, because unlike a screenshot there is no way to regenerate it once
   * the site is gone — which is the case the whole feature exists for.
   */
  const saveOfflineCopy = useCallback(
    async (bookmark: Bookmark): Promise<boolean> => {
      if (!hasPage(bookmark)) {
        toast.error("There is no page to save", { description: "Offline copies are for links." });
        return false;
      }
      if (!(await requireServer("Saving an offline copy"))) return false;

      const id = toast.loading(`Saving ${bookmark.domain}…`);
      try {
        const response = await api.requestSnapshot(bookmark.url);
        if (!response.ok) {
          toast.error(`Could not save ${bookmark.domain}`, { id });
          return false;
        }
        const type = response.headers.get("content-type") ?? "";
        if (type.includes("application/json")) {
          const detail = (await response.json()) as { error?: string };
          commitDerived({
            label: "Offline copy failed",
            kind: "offline",
            pairs: [
              {
                before: bookmark,
                after: {
                  ...bookmark,
                  offline: {
                    assetKey: "",
                    capturedAt: Date.now(),
                    bytes: 0,
                    error: friendlyFailure(detail.error ?? "Could not be archived"),
                  },
                },
              },
            ],
          });
          toast.error(`Could not save ${bookmark.domain}`, { id, description: detail.error });
          return false;
        }

        const blob = await response.blob();
        const key = assetKey("image", `offline:${bookmark.id}`);
        if (!(await putAssetBlob(key, blob))) {
          toast.error("Storage refused the copy", { id });
          return false;
        }
        pinAsset(key);

        commitDerived({
          label: "Saved an offline copy",
          kind: "offline",
          pairs: [
            {
              before: bookmark,
              after: {
                ...bookmark,
                offline: {
                  assetKey: key,
                  capturedAt: Date.now(),
                  bytes: blob.size,
                  inlined: Number(response.headers.get("x-snapshot-inlined") ?? 0) || 0,
                },
              },
            },
          ],
        });
        toast.success(`Saved ${bookmark.domain} for offline`, {
          id,
          description: `${Math.round(blob.size / 1024)} KB · opens without a connection`,
        });
        return true;
      } catch {
        toast.error(`Could not save ${bookmark.domain}`, { id });
        return false;
      }
    },
    [commit, requireServer],
  );

  /** Opens a stored offline copy in a new tab, from bytes rather than the network. */
  const openOfflineCopy = useCallback(async (bookmark: Bookmark): Promise<boolean> => {
    if (!bookmark.offline?.assetKey) return false;
    const blob = await getAssetBlob(bookmark.offline.assetKey);
    if (!blob) {
      toast.error("The saved copy is missing", { description: "Save it again from the detail panel." });
      return false;
    }
    // A blob URL keeps this app's origin, so the copy must not be able to run anything. Two
    // things hold that: copies are only stored from snapshots that already had scripts,
    // handlers and frames removed and a `default-src 'none'` policy added, and the new tab
    // inherits this app's own policy, which refuses inline script. Revoked on a delay so
    // the new tab has time to claim it.
    const url = URL.createObjectURL(new Blob([blob], { type: "text/html" }));
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  }, []);

  /** Re-captures one page's screenshot on demand, bypassing the disk cache. */
  const refreshShot = useCallback(
    async (bookmark: Bookmark, deviceOverride?: DeviceName) => {
      const device = deviceOverride ?? settingsRef.current.previewDevice;
      const status = await api.getServerStatus();
      setServerStatus(status);
      if (!status.online) {
        toast.error("Capturing previews needs the local server");
        return false;
      }
      if (!status.screenshots) {
        toast.error("No Chrome or Edge installation found", {
          description: "Screenshots need a local Chrome/Edge. Set CHROME_PATH to point at one.",
        });
        return false;
      }

      const id = toast.loading(`Capturing ${bookmark.domain}…`);
      const ok = await api.renderScreenshot(bookmark.url, device);
      if (ok) {
        // Drop the stored bytes *before* the commit, so the re-render finds an empty key
        // and fetches the new picture rather than showing the old one.
        const key = assetKey("shot", bookmark.url, device);
        forgetPrefetch(key);
        await forgetAsset(key);
        commitDerived({
          label: "Refreshed a preview",
          kind: "capture",
          pairs: [
            {
              before: bookmark,
              after: {
                ...bookmark,
                preview: { ...bookmark.preview, method: "screenshot", shotAt: Date.now(), shotDevice: device },
              },
            },
          ],
        });
        toast.success(`Fresh screenshot of ${bookmark.domain}`, { id });
      } else {
        toast.error(`Could not capture ${bookmark.domain}`, {
          id,
          description: "The page may block automated browsers or be slow to load.",
        });
      }
      return ok;
    },
    [commit],
  );

  const attachArchive = useCallback(
    async (bookmark: Bookmark) => {
      try {
        const { archiveUrl } = await api.fetchArchiveUrl(bookmark.url);
        if (!archiveUrl) {
          toast.error("No archived copy found");
          return;
        }
        commit({
          label: "Attached an archive snapshot",
          kind: "edit",
          next: [{ ...bookmark, health: { ...bookmark.health, archiveUrl } }],
          reindex: false,
        });
        toast.success("Attached a Wayback Machine snapshot");
      } catch {
        toast.error("Could not reach the archive");
      }
    },
    [commit],
  );

  /* ------------------------------------------------------------- pipeline -- */

  /**
   * Hand the background pipeline the five things it can do.
   *
   * The pipeline owns *when* and *in what order*; this owns *how*, and every one of these
   * is the same function the equivalent toolbar button calls. The alternative is a second,
   * quieter implementation of "capture a page" whose behaviour nobody ever verifies.
   */
  useEffect(() => {
    configurePipeline({
      // Rows, not URLs: a URL-keyed lookup kept one bookmark per page and dropped the rest.
      capture: async (rows, device) => (rows.length ? captureBatch(rows, device) : []),
      enrich: async (rows) => (await enrichBatch(rows, true)).recorded,
      check: async (rows) => (await checkBatch(rows)).updated,
      /**
       * Indexing reports *recorded*, not succeeded.
       *
       * A picture that will not decode is stamped with an empty index so it leaves the
       * queue — the alternative is retrying a corrupt file until it is abandoned, twice per
       * row, for every unreadable image in the library.
       */
      indexVisual: async (rows) => {
        const settled = await Promise.all(rows.map(indexVisual));
        const pairs = settled.map((result, position) => ({
          before: rows[position],
          after: result ?? { ...rows[position], visual: { at: Date.now() } },
        }));
        commitDerived({ label: "Picture index", kind: "enrich", pairs });
        return pairs.length;
      },
      offline: async (rows) => {
        let recorded = 0;
        for (const row of rows) {
          // Sequential on purpose: each call is a document plus up to a hundred and twenty
          // subresources, and two at once is a burst no site should receive from a
          // background pass nobody asked for.
          const ok = await saveOfflineCopy(row);
          recorded += 1;
          if (!ok) {
            // The row as it is now: saveOfflineCopy may already have recorded the reason.
            const current = bookmarksRef.current.find((candidate) => candidate.id === row.id);
            if (current && !current.offline?.capturedAt) {
              commitDerived({
                label: "Offline copy attempted",
                kind: "offline",
                pairs: [
                  {
                    before: current,
                    after: {
                      ...current,
                      offline: { assetKey: "", capturedAt: Date.now(), bytes: 0, error: "Could not be archived" },
                    },
                  },
                ],
              });
            }
          }
        }
        return recorded;
      },
    });
  }, [captureBatch, checkBatch, enrichBatch, indexVisual, saveOfflineCopy, commitDerived]);

  /**
   * Tell the pipeline what exists.
   *
   * This is the line that makes "as soon as a page appears in the app" literally true: any
   * change to the library reaches the pipeline in the same render that puts it on screen.
   */
  useEffect(() => {
    if (loading) return;
    observeLibrary(bookmarks);
  }, [bookmarks, loading]);

  useEffect(() => {
    setPipelineSettings({
      /*
        Background screenshots only where they are invisible (the local server's headless
        renderer), unless the person has allowed the extension's capture windows. A
        screenshot can still be taken on request from a bookmark's detail panel.
      */
      shots:
        settings.autoCapture &&
        settings.showScreenshots &&
        (runtime.net === "server" || settings.captureWithWindows),
      meta: settings.autoEnrich,
      health: settings.autoCheckLinks,
      visual: settings.autoIndexVisuals,
      offline: settings.autoOfflineCopy,
      device: settings.previewDevice,
    });
  }, [
    settings.autoCapture,
    settings.showScreenshots,
    settings.captureWithWindows,
    runtime.net,
    settings.autoEnrich,
    settings.autoCheckLinks,
    settings.autoIndexVisuals,
    settings.autoOfflineCopy,
    settings.previewDevice,
  ]);

  useEffect(() => {
    setPipelineOnline(serverStatus.online);
  }, [serverStatus.online]);

  // A permission granted or an extension connected changes the answer at once, not at the
  // next heartbeat.
  useEffect(() => {
    let current = true;
    void api.getServerStatus().then((status) => current && setServerStatus(status));
    return () => {
      current = false;
    };
  }, [runtime.net, runtime.pageAccess, runtime.screenshots]);

  /**
   * Stand down while the user is watching something.
   *
   * A foreground capture and a background sweep drive the same single renderer. Letting
   * them interleave makes the job the user is waiting on take twice as long, for no
   * benefit they can see.
   */
  useEffect(() => {
    yieldPipeline(job.running);
  }, [job.running]);

  useEffect(() => {
    const onVisibility = () => setPipelineHidden(document.visibilityState === "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => subscribePipeline(setPipeline), []);

  return {
    requireServer,
    stopJob,
    checkBatch,
    runHealthCheck,
    captureBatch,
    runCapture,
    enrichOne,
    enrichBatch,
    runEnrichment,
    indexVisual,
    runVisualIndex,
    mergeLookalikes,
    saveOfflineCopy,
    openOfflineCopy,
    refreshShot,
    attachArchive,
  };
}
