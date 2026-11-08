/**
 * Settings.
 *
 * A two-pane dialog: a sidebar of sections (ghost rows, the system's sidebar recipe) and the
 * settings themselves as `.form-row`s — label and hint on the left, a switch, segmented
 * control or button on the right, hairlines between.
 *
 * The sections are grouped by *what a switch costs you*: appearance costs nothing,
 * connections and background work cost requests to other people's servers, storage costs
 * disk, and data is destructive. That ordering is why "clear the library" is the last thing
 * in the last section.
 */
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import type { ActivityEntry, DeviceName, Settings, SortMode, ViewMode } from "@shared/types";
import {
  AlertTriangle,
  Check,
  Chrome,
  Copy,
  Database,
  Github,
  HardDrive,
  Import,
  Info,
  Loader2,
  OpenLink,
  Palette,
  Plug,
  Server,
  Shield,
  Sparkles,
  Trash2,
  Zap,
} from "@/components/icons";
import { confirm } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Slider, Switch, ToggleGroup, ToggleGroupItem } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Badge, Progress } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ThemePreference } from "@/hooks/useTheme";
import { assetStats, clearAssets } from "@/lib/assets";
import { writeHealth } from "@/lib/db";
import { APP_VERSION, EXTENSION_STORE_URL, IS_EXTENSION, REPOSITORY_URL } from "@/lib/env";
import { diagnosticsReport } from "@/lib/log";
import { formatRelative } from "@/lib/library";
import { requestBridgeAccess } from "@/lib/bridge";
import { describeRuntime, type RuntimeState } from "@/lib/runtime";
import { cn, formatBytes } from "@/lib/utils";

export type SettingsTab = "appearance" | "connections" | "background" | "storage" | "data" | "about";

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "connections", label: "Connections", icon: <Plug /> },
  { id: "background", label: "Background", icon: <Zap /> },
  { id: "storage", label: "Storage", icon: <HardDrive /> },
  { id: "data", label: "Data", icon: <Database /> },
  { id: "about", label: "About", icon: <Info /> },
];

/* ---------------------------------------------------------------- atoms */

function Row({ label, hint, children, cost }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; cost?: string }) {
  return (
    <div className="form-row">
      <div className="min-w-0">
        <div className="form-row-label flex flex-wrap items-center gap-1.5">
          {label}
          {cost ? <Badge variant="outline">{cost}</Badge> : null}
        </div>
        {hint ? <div className="form-row-hint bs-hint-wide">{hint}</div> : null}
      </div>
      {children ? <div className="form-row-control">{children}</div> : null}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  cost,
  disabled,
}: {
  label: string;
  hint: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  cost?: string;
  disabled?: boolean;
}) {
  return (
    <Row label={label} hint={hint} cost={cost}>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
    </Row>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="bs-settings-heading">{children}</h3>;
}

function Note({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warning" | "success" | "danger" }) {
  return <div className={cn("bs-banner", `is-${tone}`)}>{children}</div>;
}

function CodeLine({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bs-code">
      <code>{code}</code>
      <button
        type="button"
        className="icon-btn"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- dialog */

export function SettingsDialog({
  open,
  onOpenChange,
  tab,
  onTab,
  settings,
  onChange,
  activity,
  runtime,
  themePreference,
  onThemePreference,
  onBrowserSync,
  onImport,
  onLoadSample,
  onExport,
  onSharePage,
  onClearActivity,
  onReset,
  onRunCapture,
  onRunEnrich,
  onRunHealth,
  onRunVisual,
  onMergeLookalikes,
  onDedupe,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  activity: ActivityEntry[];
  runtime: RuntimeState;
  themePreference: ThemePreference;
  onThemePreference: (preference: ThemePreference) => void;
  onBrowserSync: (enabled: boolean) => void;
  onImport: () => void;
  onLoadSample: () => void;
  onExport: (format: "html" | "json" | "csv") => void;
  onSharePage: () => void;
  onClearActivity: () => void;
  onReset: () => void;
  onRunCapture: () => void;
  onRunEnrich: () => void;
  onRunHealth: () => void;
  onRunVisual: () => void;
  onMergeLookalikes: () => void;
  onDedupe: () => void;
}) {
  const [storage, setStorage] = useState(() => assetStats());

  // Read while open, not subscribed: the figure ticks as screenshots arrive.
  useEffect(() => {
    if (!open) return;
    setStorage(assetStats());
    const timer = setInterval(() => setStorage(assetStats()), 2000);
    return () => clearInterval(timer);
  }, [open]);

  // A website built by `npm run build` (or the Pages workflow) carries the extension zip
  // beside it; offer that as a direct download when it is there.
  const [hostedZip, setHostedZip] = useState<string | null>(null);
  useEffect(() => {
    if (!open || IS_EXTENSION || hostedZip !== null) return;
    const url = new URL("bookmark-studio-extension.zip", document.baseURI).toString();
    void fetch(url, { method: "HEAD", cache: "no-store" })
      .then((response) => setHostedZip(response.ok && !(response.headers.get("content-type") ?? "").includes("html") ? url : ""))
      .catch(() => setHostedZip(""));
  }, [open, hostedZip]);

  const used = storage.bytes;
  const budget = settings.assetBudgetMb * 1024 * 1024;
  const online = runtime.net !== "offline";
  const status = describeRuntime(runtime);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bs-settings"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          // Focus the section that is open, not whichever tab happens to come first.
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(".bs-settings-tab.is-on")?.focus();
        }}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <nav className="bs-settings-nav" aria-label="Settings sections">
          <div className="bs-settings-title">Settings</div>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={cn("bs-settings-tab", tab === entry.id && "is-on")}
              onClick={() => onTab(entry.id)}
              aria-current={tab === entry.id ? "page" : undefined}
            >
              {entry.icon}
              <span>{entry.label}</span>
            </button>
          ))}
        </nav>

        <div className="bs-settings-body">
          {/* ------------------------------------------------- appearance */}
          {tab === "appearance" ? (
            <section>
              <Heading>Appearance</Heading>
              <Row label="Theme" hint="System follows your device, including its switch to dark at night.">
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={themePreference}
                  onValueChange={(value) => value && onThemePreference(value as ThemePreference)}
                >
                  <ToggleGroupItem value="system">System</ToggleGroupItem>
                  <ToggleGroupItem value="light">Light</ToggleGroupItem>
                  <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
                </ToggleGroup>
              </Row>
              <Row label="Default layout" hint="What a fresh window opens on.">
                <Select value={settings.defaultView} onValueChange={(value) => onChange({ defaultView: value as ViewMode })}>
                  <SelectTrigger size="sm" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gallery">Grid</SelectItem>
                    <SelectItem value="moodboard">Masonry</SelectItem>
                    <SelectItem value="list">List</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row label="Default sort" hint="A search always sorts by best match while it runs.">
                <Select value={settings.defaultSort} onValueChange={(value) => onChange({ defaultSort: value as SortMode })}>
                  <SelectTrigger size="sm" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recent">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                    <SelectItem value="title">Title A–Z</SelectItem>
                    <SelectItem value="domain">By site</SelectItem>
                    <SelectItem value="visits">Most opened</SelectItem>
                    <SelectItem value="custom">As imported</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Toggle
                label="Show pictures"
                hint="Screenshots and page images on cards. Turning this off is the biggest speed-up on a very large library."
                checked={settings.showScreenshots}
                onChange={(value) => onChange({ showScreenshots: value })}
              />
              <Toggle
                label="Reduce motion"
                hint="Removes every transition and animation. Your device setting is always respected."
                checked={settings.reduceMotion}
                onChange={(value) => onChange({ reduceMotion: value })}
              />
              <Toggle
                label="Remember where I was"
                hint="Restores the last layout and sort next time."
                checked={settings.rememberView}
                onChange={(value) => onChange({ rememberView: value })}
              />
              <Toggle
                label="Confirm before deleting"
                hint="Ask before anything destructive. Undo covers most of it either way."
                checked={settings.confirmDeletes}
                onChange={(value) => onChange({ confirmDeletes: value })}
              />
              <div className="form-row flex-col items-stretch gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="form-row-label">Search delay</span>
                  <span className="text-hint text-text-3 tabular">{settings.searchDebounceMs} ms</span>
                </div>
                <Slider
                  value={[settings.searchDebounceMs]}
                  min={0}
                  max={400}
                  step={20}
                  onValueChange={([value]) => onChange({ searchDebounceMs: value })}
                  aria-label="Search delay"
                />
                <p className="form-row-hint bs-hint-wide">
                  How long results wait after your last keystroke. Raise it if typing feels heavy on a huge library; zero turns it off.
                </p>
              </div>
            </section>
          ) : null}

          {/* ------------------------------------------------ connections */}
          {tab === "connections" ? (
            <section>
              <Heading>Connections</Heading>
              <Note tone={online ? "success" : "neutral"}>
                {online ? <Check /> : <Plug />}
                <div>
                  <p className="font-medium">{status.title}</p>
                  <p className="opacity-85">{status.detail}</p>
                </div>
              </Note>

              <p className="bs-settings-text">
                Importing, searching, organising and exporting always work offline. Reading pages for search, checking links,
                capturing previews and saving offline copies need something that can fetch other sites — a web page cannot do
                that on its own. There are two free options; use either.
              </p>

              <div className="bs-option">
                <div className="bs-option-head">
                  <Chrome />
                  <div className="min-w-0 flex-1">
                    <p className="bs-option-title">The Bookmark Studio extension</p>
                    <p className="bs-option-text">For Chrome, Edge, Brave, Arc, Opera and Vivaldi. Works with this website and as its own app.</p>
                  </div>
                  {runtime.extension ? (
                    <Badge variant="success">
                      <Check /> Connected{runtime.extensionVersion ? ` · ${runtime.extensionVersion}` : ""}
                    </Badge>
                  ) : null}
                </div>
                {runtime.extensionNeedsApproval ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => void requestBridgeAccess().catch(() => undefined)}>
                      <Plug /> Allow this site…
                    </Button>
                    <span className="form-row-hint">The extension asks once for each local address, in its own window.</span>
                  </div>
                ) : !runtime.extension ? (
                  <ol className="bs-steps">
                    {EXTENSION_STORE_URL ? (
                      <li>
                        Install it from the{" "}
                        <a href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
                          Chrome Web Store
                        </a>
                        , then come back to this tab.
                      </li>
                    ) : (
                      <>
                        <li>
                          {hostedZip ? (
                            <>
                              <a href={hostedZip} download>
                                Download the extension
                              </a>{" "}
                              (a small zip) and unzip it.
                            </>
                          ) : (
                            <>
                              Download <b>bookmark-studio-extension.zip</b> from the{" "}
                              <a href={`${REPOSITORY_URL}/releases/latest`} target="_blank" rel="noreferrer">
                                latest release
                              </a>{" "}
                              and unzip it.
                            </>
                          )}
                        </li>
                        <li>
                          Open <code>chrome://extensions</code> and switch on <b>Developer mode</b> (top right).
                        </li>
                        <li>
                          Click <b>Load unpacked</b>, choose the unzipped folder, then come back to this tab.
                        </li>
                      </>
                    )}
                  </ol>
                ) : null}
                {runtime.browserBookmarks && !IS_EXTENSION ? (
                  <Toggle
                    label="Sync with this browser’s bookmarks"
                    hint="Mirror this browser’s bookmarks here, two-way. Bookmarks you imported from files are never written to the browser."
                    checked={settings.browserSync}
                    onChange={onBrowserSync}
                  />
                ) : null}
              </div>

              <div className="bs-option">
                <div className="bs-option-head">
                  <Server />
                  <div className="min-w-0 flex-1">
                    <p className="bs-option-title">Run it on your computer</p>
                    <p className="bs-option-text">
                      Any browser. Previews are rendered in headless Chrome or Edge, with no capture windows. Needs Node.js 20 or newer.
                    </p>
                  </div>
                  {runtime.server ? (
                    <Badge variant="success">
                      <Check /> Connected
                    </Badge>
                  ) : null}
                </div>
                {!runtime.server ? (
                  <div className="flex flex-col gap-1.5">
                    <CodeLine code={`git clone ${REPOSITORY_URL}.git`} />
                    <CodeLine code="cd bookmark-studio && npm install && npm start" />
                    <p className="form-row-hint bs-hint-wide">
                      Then open http://127.0.0.1:5174. Your library lives in each browser separately — move it with Data → Export a full
                      backup.
                    </p>
                  </div>
                ) : null}
              </div>

              <p className="bs-settings-foot">
                <Shield size={14} /> Requests go only to the sites in your library, never to a third party, and never with your cookies.
              </p>
            </section>
          ) : null}

          {/* ------------------------------------------------- background */}
          {tab === "background" ? (
            <section>
              <Heading>Background</Heading>
              {!online ? (
                <Note tone="warning">
                  <AlertTriangle />
                  <p>
                    Nothing is connected, so the passes below that need the network are paused.{" "}
                    <button type="button" className="btn-link" onClick={() => onTab("connections")}>
                      Connect the extension or local server
                    </button>
                    .
                  </p>
                </Note>
              ) : null}
              <Toggle
                label="Read each page"
                hint="Fetches each page’s own description, headings and text, so a bookmark titled “Files” is found by searching “figma”."
                cost="one request per bookmark"
                checked={settings.autoEnrich}
                onChange={(value) => onChange({ autoEnrich: value })}
              />
              <Toggle
                label="Capture screenshots"
                hint="Real previews. Most sites refuse to be shown in a frame, so this is the only preview that works for most of the web."
                cost={runtime.net === "server" ? (runtime.screenshots ? "headless Chrome" : "no Chrome found") : runtime.net === "offline" ? "needs a connection" : "brief capture window"}
                checked={settings.autoCapture}
                onChange={(value) => onChange({ autoCapture: value })}
              />
              <Toggle
                label="Check links"
                hint="Verifies each link still works, and records where it now redirects."
                cost="one request per link"
                checked={settings.autoCheckLinks}
                onChange={(value) => onChange({ autoCheckLinks: value })}
              />
              <Toggle
                label="Index pictures"
                hint="A perceptual hash and colour histogram, computed in this browser from stored images. Powers look-alikes and colour search."
                cost="no network"
                checked={settings.autoIndexVisuals}
                onChange={(value) => onChange({ autoIndexVisuals: value })}
              />
              <Toggle
                label="Save offline copies"
                hint="Each page saved as one self-contained file that opens with the network off. Off by default — it is a lot of bytes."
                cost="heavy"
                checked={settings.autoOfflineCopy}
                onChange={(value) => onChange({ autoOfflineCopy: value })}
              />
              <Row label="Screenshot size" hint="Captures are taken at this viewport; changing it re-captures over time.">
                <Select value={settings.previewDevice} onValueChange={(value) => onChange({ previewDevice: value as DeviceName })}>
                  <SelectTrigger size="sm" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desktop">Desktop</SelectItem>
                    <SelectItem value="tablet">Tablet</SelectItem>
                    <SelectItem value="mobile">Mobile</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row label="Run a pass now" hint="On everything in the current view.">
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button size="sm" variant="outline" onClick={onRunEnrich} disabled={!online}>
                    Read pages
                  </Button>
                  <Button size="sm" variant="outline" onClick={onRunHealth} disabled={!online}>
                    Check links
                  </Button>
                  <Button size="sm" variant="outline" onClick={onRunCapture} disabled={!online || !runtime.screenshots}>
                    Capture
                  </Button>
                  <Button size="sm" variant="outline" onClick={onRunVisual}>
                    Index pictures
                  </Button>
                </div>
              </Row>
              <Row label="Tidy up" hint="Both are single, undoable steps.">
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button size="sm" variant="outline" onClick={onDedupe}>
                    Merge duplicate links
                  </Button>
                  <Button size="sm" variant="outline" onClick={onMergeLookalikes}>
                    Merge duplicate pictures
                  </Button>
                </div>
              </Row>
            </section>
          ) : null}

          {/* ---------------------------------------------------- storage */}
          {tab === "storage" ? (
            <section>
              <Heading>Storage</Heading>
              <div className="bs-card bs-card-flat">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-base font-medium tabular">
                    {formatBytes(used)} of {settings.assetBudgetMb.toLocaleString()} MB
                  </span>
                  <span className="text-hint text-text-3 tabular">{storage.count.toLocaleString()} stored images</span>
                </div>
                <Progress value={budget ? Math.min(100, (used / budget) * 100) : 0} />
                <p className="form-row-hint bs-hint-wide">
                  Screenshots, page images and favicons are kept here rather than in the browser’s cache, so they survive a cache clear,
                  work offline and can be counted. The least recently shown are dropped past the budget.
                </p>
              </div>
              <div className="form-row flex-col items-stretch gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="form-row-label">Image budget</span>
                  <span className="text-hint text-text-3 tabular">{settings.assetBudgetMb.toLocaleString()} MB</span>
                </div>
                <Slider
                  value={[settings.assetBudgetMb]}
                  min={128}
                  max={8192}
                  step={128}
                  onValueChange={([value]) => onChange({ assetBudgetMb: value })}
                  aria-label="Image budget"
                />
              </div>
              <Row label="Clear stored images" hint="Screenshots and page images are fetched again as you scroll. Uploads and offline copies are kept.">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Clear stored images?",
                      description: "Screenshots and page images will be fetched again as you scroll. Uploaded files and offline copies are kept.",
                      confirmLabel: "Clear images",
                    });
                    if (!ok) return;
                    await clearAssets();
                    setStorage(assetStats());
                  }}
                >
                  <Trash2 /> Clear
                </Button>
              </Row>
            </section>
          ) : null}

          {/* ------------------------------------------------------- data */}
          {tab === "data" ? (
            <section>
              <Heading>Data</Heading>
              <Row label="Import bookmarks" hint="From any browser, Pocket, Raindrop, Pinboard and more, a CSV, or a backup made here.">
                <Button size="sm" variant="outline" onClick={onImport}>
                  <Import /> Import…
                </Button>
              </Row>
              <Row label="Sample library" hint="Real links to explore with. Removable in one step from Imports in the sidebar.">
                <Button size="sm" variant="outline" onClick={onLoadSample}>
                  <Sparkles /> Load
                </Button>
              </Row>
              <Row
                label="Export"
                hint="HTML imports into any browser. The JSON backup is complete — tags, notes, boards and history — and restores through Import."
              >
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => onExport("html")}>
                    HTML
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onExport("json")}>
                    Backup (JSON)
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onExport("csv")}>
                    CSV
                  </Button>
                </div>
              </Row>

              <Row
                label="Share as a page"
                hint="The current view as one self-contained HTML file, pictures inside. Opens in any browser, offline; nothing is uploaded."
              >
                <Button size="sm" variant="outline" onClick={onSharePage}>
                  Share…
                </Button>
              </Row>

              <div className="form-row flex-col items-stretch gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="form-row-label">Recent activity</span>
                  <Button size="xs" variant="ghost" onClick={onClearActivity}>
                    Clear log
                  </Button>
                </div>
                <ul className="bs-activity">
                  {activity.slice(0, 40).map((entry) => (
                    <li key={entry.id}>
                      <Badge variant="outline">{entry.kind}</Badge>
                      <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
                      <span className="text-text-3 shrink-0 tabular">{formatRelative(entry.at)}</span>
                    </li>
                  ))}
                  {!activity.length ? <li className="text-text-3">Nothing logged yet.</li> : null}
                </ul>
              </div>

              <div className="form-row">
                <div className="min-w-0">
                  <div className="form-row-label text-danger-text">Clear the whole library</div>
                  <div className="form-row-hint bs-hint-wide">
                    Deletes every bookmark, folder, board, collection and stored image in this browser. This cannot be undone — export a
                    backup first.
                    {IS_EXTENSION ? " Your Chrome bookmarks themselves are not touched." : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Clear the whole library?",
                      description:
                        "Every bookmark, folder, board, collection and stored image in this browser will be deleted. This cannot be undone.",
                      confirmLabel: "Delete everything",
                      destructive: true,
                    });
                    if (ok) onReset();
                  }}
                >
                  Clear library
                </Button>
              </div>
            </section>
          ) : null}

          {/* ------------------------------------------------------ about */}
          {tab === "about" ? (
            <section>
              <Heading>About</Heading>
              <p className="bs-settings-text">
                <b>Bookmark Studio {APP_VERSION}</b> is a local-first bookmark manager and knowledge base. It is free and open source under
                the MIT license.
              </p>
              <Row label="Where your data lives" hint="In this browser’s storage (IndexedDB) — nowhere else. No account, no sync service, no analytics.">
                <Shield className="text-text-3" />
              </Row>
              <Row label="No AI" hint="Categories come from rules, tags from a list of topics, “similar” from TF-IDF, look-alikes from perceptual hashes.">
                <Sparkles className="text-text-3" />
              </Row>
              <Row label="Source code" hint="Report a bug, suggest a feature or read how it works.">
                <Button size="sm" variant="outline" asChild>
                  <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
                    <Github /> GitHub <OpenLink size={14} />
                  </a>
                </Button>
              </Row>
              <Row label="Running as" hint={status.detail}>
                <Badge variant="outline">{IS_EXTENSION ? "Extension" : runtime.server ? "Local server" : "Website"}</Badge>
              </Row>
              <Row
                label="Diagnostics"
                hint="Recent events and errors, for a bug report. Web addresses are cut to the site name, so it never lists your bookmarks."
              >
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const report = diagnosticsReport({
                      runningAs: IS_EXTENSION ? "extension" : runtime.server ? "local server" : "website",
                      unsavedChanges: writeHealth().unsaved,
                    });
                    void navigator.clipboard
                      .writeText(report)
                      .then(() => toast.success("Diagnostics copied", { description: "Paste them into your bug report." }))
                      .catch(() => toast.error("Could not copy to the clipboard", { description: "Your browser blocked it." }));
                  }}
                >
                  Copy diagnostics
                </Button>
              </Row>
            </section>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A small floating progress card while a user-started job runs. */
export function JobBar({
  label,
  done,
  total,
  failed,
  onStop,
}: {
  label: string;
  done: number;
  total: number;
  failed: number;
  /** Absent when the job cannot be stopped safely. */
  onStop?: () => void;
}) {
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="bs-jobbar" role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <Loader2 size={15} className="animate-spin text-text-3" />
        <span className="flex-1 truncate text-sm font-medium">{label}</span>
        {onStop ? (
          <Button size="xs" variant="ghost" onClick={onStop}>
            Stop
          </Button>
        ) : null}
      </div>
      <Progress value={percent} />
      <p className="text-xs text-text-3 tabular">
        {done.toLocaleString()} of {total.toLocaleString()}
        {failed ? ` · ${failed} failed` : ""}
      </p>
    </div>
  );
}
