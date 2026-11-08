/**
 * The first screen of an empty library.
 *
 * Three ways in, side by side, each one honest about what it does:
 *
 *   1. Import your own bookmarks — any of the 28 supported sources, or a backup.
 *   2. Try a sample library — real links through the real importer, removable in one step.
 *   3. Connect — the browser's own bookmarks (extension), or how to switch on previews and
 *      link checks when nothing is connected yet.
 *
 * Laid out as a document page in the design system's voice: a serif headline, one paragraph,
 * cards built from surface-2 + ring, and a single line about where the data lives.
 */
import { Chrome, Import, Plug, Server, Shield, Sparkles } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { requestBridgeAccess } from "@/lib/bridge";
import type { RuntimeState } from "@/lib/runtime";
import { SAMPLE_LINK_COUNT } from "@/lib/sample";
import { SOURCES } from "@/lib/import";

export function Welcome({
  runtime,
  browserSync,
  loadingSample,
  onImport,
  onSample,
  onAdd,
  onEnableSync,
  onConnections,
}: {
  runtime: RuntimeState;
  browserSync: boolean;
  loadingSample: boolean;
  onImport: () => void;
  onSample: () => void;
  onAdd: () => void;
  onEnableSync: () => void;
  onConnections: () => void;
}) {
  const sourceNames = ["Chrome", "Safari", "Firefox", "Edge", "Pocket", "Raindrop.io"];
  return (
    <div className="bs-welcome">
      <div className="bs-welcome-inner">
        <h1 className="bs-welcome-title">A calm home for everything you save.</h1>
        <p className="bs-welcome-lede">
          Bring in your bookmarks from any browser or service, then search them properly, find the dead links,
          spot duplicates and see every page at a glance. It all runs in this browser.
        </p>

        <div className="bs-welcome-cards">
          <section className="bs-card">
            <span className="bs-card-icon">
              <Import />
            </span>
            <h2 className="bs-card-title">Import your bookmarks</h2>
            <p className="bs-card-text">
              From {sourceNames.join(", ")} and {SOURCES.length - sourceNames.length} more — or a CSV, a JSON backup, a
              list of links. Drop a file anywhere.
            </p>
            <div className="bs-card-actions">
              <Button onClick={onImport}>
                <Import /> Choose a file…
              </Button>
              <Button variant="ghost" onClick={onAdd}>
                Add one link
              </Button>
            </div>
          </section>

          <section className="bs-card">
            <span className="bs-card-icon">
              <Sparkles />
            </span>
            <h2 className="bs-card-title">Try a sample library</h2>
            <p className="bs-card-text">
              {SAMPLE_LINK_COUNT} real links across a dozen folders, so you can explore search, filters and views first.
              Remove it in one step from the sidebar.
            </p>
            <div className="bs-card-actions">
              <Button variant="outline" onClick={onSample} disabled={loadingSample}>
                {loadingSample ? "Loading…" : "Load the sample"}
              </Button>
            </div>
          </section>

          <ConnectCard runtime={runtime} browserSync={browserSync} onEnableSync={onEnableSync} onConnections={onConnections} />
        </div>

        <p className="bs-welcome-foot">
          <Shield size={14} />
          Your library is saved in this browser only. No account, no tracking, no AI — and nothing is uploaded.
        </p>
      </div>
    </div>
  );
}

function ConnectCard({
  runtime,
  browserSync,
  onEnableSync,
  onConnections,
}: {
  runtime: RuntimeState;
  browserSync: boolean;
  onEnableSync: () => void;
  onConnections: () => void;
}) {
  if (runtime.net === "extension") {
    return (
      <section className="bs-card">
        <span className="bs-card-icon">
          <Chrome />
        </span>
        <h2 className="bs-card-title">Synced with Chrome</h2>
        <p className="bs-card-text">
          This library mirrors your Chrome bookmarks both ways. Star a page in Chrome and it appears here; edit it here
          and Chrome follows. Your bookmarks bar looks empty right now.
        </p>
      </section>
    );
  }
  if (runtime.extensionNeedsApproval) {
    return (
      <section className="bs-card">
        <span className="bs-card-icon">
          <Plug />
        </span>
        <h2 className="bs-card-title">Allow this site in the extension</h2>
        <p className="bs-card-text">
          The Bookmark Studio extension is installed. Because this is a local address, it asks once before this site
          can use it.
        </p>
        <div className="bs-card-actions">
          <Button variant="outline" onClick={() => void requestBridgeAccess().catch(() => undefined)}>
            <Plug /> Allow this site…
          </Button>
        </div>
      </section>
    );
  }
  if (runtime.browserBookmarks && !browserSync) {
    return (
      <section className="bs-card">
        <span className="bs-card-icon">
          <Chrome />
        </span>
        <h2 className="bs-card-title">Use this browser’s bookmarks</h2>
        <p className="bs-card-text">
          The extension is connected. Mirror this browser’s bookmarks here, kept in sync both ways.
        </p>
        <div className="bs-card-actions">
          <Button variant="outline" onClick={onEnableSync}>
            <Chrome /> Sync with this browser
          </Button>
        </div>
      </section>
    );
  }
  if (runtime.net === "server" || runtime.net === "bridge") {
    return (
      <section className="bs-card">
        <span className="bs-card-icon">{runtime.net === "server" ? <Server /> : <Plug />}</span>
        <h2 className="bs-card-title">{runtime.net === "server" ? "Local server connected" : "Extension connected"}</h2>
        <p className="bs-card-text">
          Pages are read for search, links are checked and previews are captured automatically after you import.
        </p>
        <div className="bs-card-actions">
          <Button variant="ghost" onClick={onConnections}>
            Connection settings
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="bs-card">
      <span className="bs-card-icon">
        <Plug />
      </span>
      <h2 className="bs-card-title">Previews and link checks</h2>
      <p className="bs-card-text">
        A web page can’t read other sites by itself. Add the free extension (or run the app locally) to capture
        previews, read pages for search and check which links still work.
      </p>
      <div className="bs-card-actions">
        <Button variant="outline" onClick={onConnections}>
          How to connect
        </Button>
      </div>
    </section>
  );
}
