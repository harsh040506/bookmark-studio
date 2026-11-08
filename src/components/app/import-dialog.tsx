/**
 * The import wizard.
 *
 * ## Four steps, and why none of them can be skipped
 *
 * 1. **Choose a file.** Drag it in or pick it; the extension is only a hint.
 * 2. **Confirm where it came from.** Detection guesses and shows its confidence, but a
 *    Netscape file from Brave is byte-identical to one from Chrome, so the guess is a
 *    default rather than a verdict. Getting this right is what makes the sidebar say
 *    "Brave · 1,204" and what makes a re-import fold into the same source.
 * 3. **Map columns, for a CSV.** Twelve services spell the same four columns differently;
 *    the mapping is guessed from the header row and remains editable, because the long tail
 *    of one-off exports is genuinely unguessable.
 * 4. **See what will happen.** The preview runs the *real* pipeline with `previewOnly`, so
 *    the numbers on this screen are the numbers that will land. An approximation here is
 *    how a dialog ends up promising 4,102 and delivering 3,880.
 *
 * ## Why the file is read once
 *
 * The text is read on drop and carried through every step. Re-reading a 90 MB export for
 * the preview and again for the import is two multi-second stalls for one file.
 */
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  FileUp,
  Import,
  Loader2,
  Search,
  Upload,
} from "@/components/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  ACCEPTED_EXTENSIONS,
  bestSource,
  csvHeaders,
  detectInput,
  detectSources,
  EMPTY_COLUMNS,
  guessColumns,
  SOURCE_BY_ID,
  SOURCE_GROUPS,
  SOURCES,
  sniffDelimiter,
  type ColumnMap,
  type ImportOutcome,
  type SourceDefinition,
} from "@/lib/import";
import { Badge, Progress, Separator } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MAX_IMPORT_BYTES } from "@/lib/import";
import { readImportText } from "@/lib/import/read-text";
import { log } from "@/lib/log";
import { cn, formatBytes } from "@/lib/utils";

type Step = "file" | "source" | "columns" | "review";

const COLUMN_ROLES: { key: keyof ColumnMap; label: string; required?: boolean }[] = [
  { key: "url", label: "URL", required: true },
  { key: "title", label: "Title" },
  { key: "description", label: "Description" },
  { key: "note", label: "Note" },
  { key: "tags", label: "Tags" },
  { key: "folder", label: "Folder" },
  { key: "addedAt", label: "Date added" },
  { key: "favorite", label: "Favourite" },
  { key: "archived", label: "Archived" },
];

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-seeded when a file was dropped onto the window. */
  initialFile?: File | null;
  keepDuplicatesDefault: boolean;
  /** Downloads a full backup, offered before a replace. */
  onBackup?: () => void;
  /** Set when the sample library is loaded; the import then offers to remove it first. */
  onRemoveSample?: () => Promise<void>;
  onPreview: (options: {
    file: File;
    source: SourceDefinition;
    csvColumns?: ColumnMap;
    mode: "merge" | "replace";
    keepDuplicates: boolean;
    text?: string;
  }) => Promise<ImportOutcome>;
  onImport: (options: {
    file: File;
    source: SourceDefinition;
    csvColumns?: ColumnMap;
    mode: "merge" | "replace";
    keepDuplicates: boolean;
    label?: string;
    text?: string;
  }) => Promise<ImportOutcome | null>;
}

export function ImportDialog(props: ImportDialogProps) {
  const [step, setStep] = useState<Step>("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [source, setSource] = useState<SourceDefinition | null>(null);
  const [candidates, setCandidates] = useState<{ id: string; confidence: number }[]>([]);
  const [columns, setColumns] = useState<ColumnMap>(EMPTY_COLUMNS);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [keepDuplicates, setKeepDuplicates] = useState(props.keepDuplicatesDefault);
  const [label, setLabel] = useState("");
  const [dropSample, setDropSample] = useState(true);
  const [preview, setPreview] = useState<ImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStep("file");
    setFile(null);
    setText("");
    setSource(null);
    setCandidates([]);
    setColumns(EMPTY_COLUMNS);
    setHeaders([]);
    setPreview(null);
    setLabel("");
    setDropSample(true);
    setSourceFilter("");
    setBusy(false);
    setReading(false);
  }, []);

  useEffect(() => {
    if (!props.open) reset();
  }, [props.open, reset]);

  /**
   * Takes a file in: reads it once, detects the source, and pre-maps CSV columns.
   *
   * The whole file is read here rather than a slice, because every later step needs the
   * text and a 90 MB export must not be read three times.
   */
  const accept = useCallback(async (chosen: File) => {
    // Checked before reading: a multi-gigabyte file read into a tab can crash it.
    if (chosen.size > MAX_IMPORT_BYTES) {
      toast.error("That file is too large to import here", {
        description: `The limit is ${formatBytes(MAX_IMPORT_BYTES)}. Export a smaller part of your library, or split the file.`,
      });
      return;
    }
    if (chosen.size === 0) {
      toast.error("That file is empty", { description: "Export your bookmarks again and choose the new file." });
      return;
    }
    setReading(true);
    setFile(chosen);
    setLabel(chosen.name.replace(/\.[^.]+$/, ""));
    try {
      const { text: body } = await readImportText(chosen);
      setText(body);
      const input = detectInput(chosen.name, body.slice(0, 64 * 1024), chosen.size);
      const ranked = detectSources(input);
      setCandidates(ranked.slice(0, 4).map((entry) => ({ id: entry.source.id, confidence: entry.confidence })));
      const guess = bestSource(input);
      setSource(guess);

      if (guess.parsers.includes("csv")) {
        const found = csvHeaders(body, sniffDelimiter(body));
        setHeaders(found);
        setColumns(guessColumns(found, guess.csv));
      }
      setStep("source");
    } catch (error) {
      // Typically the file was moved, deleted or locked after it was chosen.
      log.warn("import.read-failed", { error, size: chosen.size });
      toast.error("That file could not be read", {
        description: "It may have been moved, deleted or still be open in another program. Try choosing it again.",
      });
      setFile(null);
      setStep("file");
    } finally {
      setReading(false);
    }
  }, []);

  useEffect(() => {
    if (props.open && props.initialFile && !file) void accept(props.initialFile);
  }, [props.open, props.initialFile, file, accept]);

  const isCsv = Boolean(source?.parsers.includes("csv") && headers.length);

  const runPreview = useCallback(async () => {
    if (!file || !source) return;
    setBusy(true);
    try {
      const outcome = await props.onPreview({
        file,
        source,
        csvColumns: isCsv ? columns : undefined,
        mode,
        keepDuplicates,
        text,
      });
      setPreview(outcome);
      setStep("review");
    } finally {
      setBusy(false);
    }
  }, [file, source, isCsv, columns, mode, keepDuplicates, text, props]);

  /** Re-run the preview whenever a choice that changes the numbers changes. */
  useEffect(() => {
    if (step !== "review" || !file || !source) return;
    let active = true;
    setBusy(true);
    void props
      .onPreview({ file, source, csvColumns: isCsv ? columns : undefined, mode, keepDuplicates, text })
      .then((outcome) => {
        if (active) setPreview(outcome);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed to the choices
  }, [mode, keepDuplicates]);

  const grouped = useMemo(() => {
    const needle = sourceFilter.trim().toLowerCase();
    const matching = needle
      ? SOURCES.filter(
          (entry) =>
            entry.name.toLowerCase().includes(needle) || entry.hint.toLowerCase().includes(needle),
        )
      : SOURCES;
    /*
      The sources this file could have come from go first, in their own group, so the
      choice that matters is on screen without scrolling past 28 others. They are left out
      of the groups below so nothing appears twice.
    */
    const suggestedIds = needle ? [] : candidates.filter((entry) => entry.confidence > 0).map((entry) => entry.id);
    const suggested = suggestedIds
      .map((id) => SOURCE_BY_ID.get(id))
      .filter((entry): entry is SourceDefinition => Boolean(entry));
    const rest = matching.filter((entry) => !suggestedIds.includes(entry.id));
    return [
      ...(suggested.length ? [{ group: "Matches this file", sources: suggested }] : []),
      ...SOURCE_GROUPS.map((group) => ({
        group,
        sources: rest.filter((entry) => entry.group === group),
      })),
    ].filter((entry) => entry.sources.length);
  }, [sourceFilter, candidates]);

  const bestId = candidates[0]?.id;
  const confidenceFor = (id: string) => candidates.find((entry) => entry.id === id)?.confidence ?? 0;

  const runImport = async () => {
    if (!file || !source) return;
    setBusy(true);
    try {
      // A replace clears the sample anyway; a merge removes it only when asked.
      if (mode === "merge" && dropSample && props.onRemoveSample) await props.onRemoveSample();
      await props.onImport({
        file,
        source,
        csvColumns: isCsv ? columns : undefined,
        mode,
        keepDuplicates,
        label,
        text,
      });
      props.onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Import bookmarks</DialogTitle>
          <DialogDescription>
            {step === "file"
              ? `${SOURCES.length} sources are supported — browsers, read-later services, and plain HTML, CSV or JSON.`
              : file
                ? `${file.name} · ${formatBytes(file.size)}`
                : ""}
          </DialogDescription>
        </DialogHeader>

        {/* ------------------------------------------------------ step: file */}
        {step === "file" ? (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const dropped = event.dataTransfer.files?.[0];
              if (dropped) void accept(dropped);
            }}
            className={cn("bs-dropbox", dragging && "is-over")}
          >
            {reading ? (
              <>
                <Loader2 size={22} className="animate-spin text-text-3" />
                <p className="bs-dropbox-title">Reading the file…</p>
              </>
            ) : (
              <>
                <Upload size={24} className="text-text-3" />
                <div>
                  <p className="bs-dropbox-title">Drop an export here</p>
                  <p className="bs-dropbox-text">HTML, JSON, CSV, ENEX, plist or a plain list of links. Nothing leaves this browser.</p>
                </div>
                <Button onClick={() => inputRef.current?.click()}>
                  <FileUp /> Choose a file…
                </Button>
                <p className="bs-dropbox-hint">
                  In Chrome, Edge or Brave: Bookmarks → Bookmark manager → ⋮ → Export bookmarks. In Safari: File → Export → Bookmarks.
                </p>
                <input
                  ref={inputRef}
                  type="file"
                  accept={ACCEPTED_EXTENSIONS.join(",")}
                  className="hidden"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    if (chosen) void accept(chosen);
                    event.target.value = "";
                  }}
                />
              </>
            )}
          </div>
        ) : null}

        {/* ---------------------------------------------------- step: source */}
        {step === "source" ? (
          <div className="flex flex-col gap-3">
            <div className="file-search">
              <Search />
              <Input
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value)}
                placeholder="Find a source"
                aria-label="Find a source"
              />
            </div>

            <div className="file-list bs-scroll-fade" role="radiogroup" aria-label="Where this file came from">
              {grouped.map((entry) => (
                <div key={entry.group} className="mb-2" role="group" aria-label={entry.group}>
                  <p className="menu-header" aria-hidden="true">{entry.group}</p>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {entry.sources.map((candidate) => {
                      const active = source?.id === candidate.id;
                      const confidence = confidenceFor(candidate.id);
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => {
                            setSource(candidate);
                            if (candidate.parsers.includes("csv") && text) {
                              const found = csvHeaders(text, sniffDelimiter(text));
                              setHeaders(found);
                              setColumns(guessColumns(found, candidate.csv));
                            }
                          }}
                          onDoubleClick={() => {
                            setSource(candidate);
                            if (!candidate.parsers.includes("csv")) void runPreview();
                          }}
                          className={cn("bs-source", active && "is-on")}
                        >
                          <span className="bs-source-top">
                            <span className="bs-source-name">{candidate.name}</span>
                            {confidence >= 0.8 ? (
                              <Badge variant="success">Detected</Badge>
                            ) : candidate.id === bestId && confidence > 0 ? (
                              <Badge variant="secondary">Best match</Badge>
                            ) : null}
                            {active ? <Check size={16} className="bs-source-check" aria-hidden="true" /> : null}
                          </span>
                          <span className="bs-source-hint line-clamp-2">
                            {candidate.hint}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {!grouped.length ? <p className="file-empty">No source matches “{sourceFilter}”.</p> : null}
            </div>
            <p className="field-hint">
              Files from Chromium browsers look identical, so the best match is a guess. Pick the
              browser it really came from to keep each source’s count right.
            </p>
          </div>
        ) : null}

        {/* --------------------------------------------------- step: columns */}
        {step === "columns" ? (
          <div className="flex flex-col gap-2">
            <p className="dialog-text">
              Columns were matched by name. Change anything that looks wrong — only the URL is
              required.
            </p>
            <div className="grid max-h-[46vh] gap-x-3 gap-y-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {COLUMN_ROLES.map((role) => (
                <label key={role.key} className="field">
                  <span className="field-label">
                    {role.label}
                    {role.required ? <span className="text-danger-text"> *</span> : null}
                  </span>
                  <Select
                    value={String(columns[role.key])}
                    onValueChange={(value) =>
                      setColumns((current) => ({ ...current, [role.key]: Number(value) }))
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue placeholder="Not mapped" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="-1">Not mapped</SelectItem>
                      {headers.map((header, position) => (
                        <SelectItem key={`${header}-${position}`} value={String(position)}>
                          {header || `Column ${position + 1}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {/* ---------------------------------------------------- step: review */}
        {step === "review" ? (
          <div className="flex flex-col gap-3">
            {busy && !preview ? (
              <div className="file-empty flex items-center justify-center gap-2">
                <Loader2 size={16} className="animate-spin" /> Working out what this file holds…
              </div>
            ) : null}

            {preview ? (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Will import" value={preview.total} tone="primary" />
                  <Stat label="Folders" value={preview.folderCount} />
                  <Stat
                    label="Already saved"
                    value={preview.duplicates + preview.internalDuplicates}
                    tone={preview.duplicates ? "warning" : undefined}
                  />
                  <Stat label="Skipped" value={preview.skipped} />
                </div>

                {preview.span ? (
                  <p className="field-hint">
                    Covering {new Date(preview.span.from).getFullYear()}–
                    {new Date(preview.span.to).getFullYear()}, read as{" "}
                    <span className="font-medium">{preview.parser}</span>.
                  </p>
                ) : null}

                {preview.warnings.length ? (
                  <div className="bs-banner is-warning flex-col gap-1">
                    {preview.warnings.map((warning) => (
                      <p key={warning} className="flex items-start gap-1.5">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        {warning}
                      </p>
                    ))}
                  </div>
                ) : null}

                {preview.sample.length ? (
                  <div className="bs-sample">
                    <p className="menu-header">A few of them</p>
                    <ul>
                      {preview.sample.map((entry, position) => (
                        <li key={`${entry.url}-${position}`}>
                          <p className="file-name">{entry.title}</p>
                          <p className="file-dir">
                            {entry.folder ? `${entry.folder} · ` : ""}
                            {entry.url}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <Separator />

                <label className="field">
                  <span className="field-label">Name this import</span>
                  <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Work laptop, March" />
                </label>

                <label className="bs-check-row">
                  <Checkbox
                    checked={keepDuplicates}
                    onCheckedChange={(checked) => setKeepDuplicates(checked === true)}
                  />
                  <span className="flex flex-col">
                    <span className="form-row-label">Keep duplicates for review</span>
                    <span className="form-row-hint bs-hint-wide">
                      Off discards them silently. On puts them in the Duplicates view, where one
                      click merges the lot.
                    </span>
                  </span>
                </label>

                {props.onRemoveSample && mode === "merge" ? (
                  <label className="bs-check-row">
                    <Checkbox checked={dropSample} onCheckedChange={(checked) => setDropSample(checked === true)} />
                    <span className="flex flex-col">
                      <span className="form-row-label">Remove the sample library</span>
                      <span className="form-row-hint bs-hint-wide">
                        So its demo folders and links don’t mix with yours.
                      </span>
                    </span>
                  </label>
                ) : null}

                <label className="bs-check-row">
                  <Checkbox
                    checked={mode === "replace"}
                    onCheckedChange={(checked) => setMode(checked === true ? "replace" : "merge")}
                  />
                  <span className="flex flex-col">
                    <span className="form-row-label">Replace the library</span>
                    <span className="form-row-hint bs-hint-wide text-danger-text">
                      Deletes everything currently saved first — except bookmarks synced from this browser. This cannot be undone;
                      export a backup first.
                    </span>
                  </span>
                </label>
                {mode === "replace" && props.onBackup ? (
                  <div className="bs-banner is-warning items-center">
                    <p className="flex-1">Keep a copy of what you have now, in case you change your mind.</p>
                    <Button size="sm" variant="outline" onClick={props.onBackup}>
                      Download a backup
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {busy && step !== "review" ? <Progress value={60} /> : null}

        {/* ---------------------------------------------------------- footer */}
        <div className="bs-dialog-foot items-center">
          {step !== "file" ? (
            <Button
              variant="ghost"
              onClick={() =>
                setStep(
                  step === "review" ? (isCsv ? "columns" : "source") : step === "columns" ? "source" : "file",
                )
              }
            >
              <ArrowLeft /> Back
            </Button>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            {step === "source" ? (
              <Button
                disabled={!source}
                onClick={() => (isCsv ? setStep("columns") : void runPreview())}
              >
                {isCsv ? "Map columns" : "Preview"} <ArrowRight />
              </Button>
            ) : null}
            {step === "columns" ? (
              <Button disabled={columns.url < 0} onClick={() => void runPreview()}>
                Preview <ArrowRight />
              </Button>
            ) : null}
            {step === "review" ? (
              <Button
                disabled={busy || !preview?.total}
                variant={mode === "replace" ? "destructive" : "default"}
                onClick={() => void runImport()}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Import />}
                {mode === "replace"
                  ? `Replace with ${preview?.total.toLocaleString() ?? 0}`
                  : `Import ${preview?.total.toLocaleString() ?? 0}`}
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "primary" | "warning";
}) {
  return (
    <div className="bs-stat">
      <p className={cn("bs-stat-value tabular", tone === "warning" && "text-warning-text")}>{value.toLocaleString()}</p>
      <p className="bs-stat-label">{label}</p>
    </div>
  );
}

/** The catalogue, for the settings screen's "what can I import" list. */
export function SupportedSources() {
  return (
    <div className="flex flex-col gap-3">
      {SOURCE_GROUPS.map((group) => (
        <div key={group}>
          <p className="menu-header px-0">{group}</p>
          <div className="flex flex-wrap gap-1">
            {SOURCES.filter((entry) => entry.group === group).map((entry) => (
              <Badge key={entry.id} variant="secondary">
                {entry.name}
              </Badge>
            ))}
          </div>
        </div>
      ))}
      <p className="field-hint">
        {SOURCES.length} sources · {SOURCE_BY_ID.size} definitions
      </p>
    </div>
  );
}
