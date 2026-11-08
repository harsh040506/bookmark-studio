/**
 * Structured, severity-based logging that never leaves the device.
 *
 * There is no telemetry by design, so when something goes wrong the only record is what the
 * person can see. Every entry is a severity, a stable event name ("storage.write-failed") and
 * a small details object. Entries go to the console with a consistent prefix and into a
 * bounded in-memory ring, which Settings can copy as a diagnostics report for a bug report.
 *
 * Redaction is part of the format, not left to callers: web addresses are reduced to their
 * origin and long strings are cut, so a pasted report never reveals which pages someone saved.
 */

export type Severity = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  at: number;
  severity: Severity;
  event: string;
  details: Record<string, unknown>;
}

const RING_SIZE = 200;
const MAX_STRING = 300;
const ring: LogEntry[] = [];

const URL_PATTERN = /\b(?:https?|chrome-extension|blob):\/\/[^\s"'<>]+/gi;

/** Keeps the origin of every address in a string and drops the path, query and fragment. */
export function redact(value: string): string {
  const cut = value.replace(URL_PATTERN, (match) => {
    try {
      const parsed = new URL(match);
      return `${parsed.protocol}//${parsed.host}/…`;
    } catch {
      return "[address]";
    }
  });
  return cut.length > MAX_STRING ? `${cut.slice(0, MAX_STRING)}…` : cut;
}

function clean(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error || (typeof DOMException !== "undefined" && value instanceof DOMException)) {
    const error = value as Error;
    return {
      name: error.name,
      message: redact(String(error.message ?? "")),
      // The top of the stack is enough to locate a bug; the rest is noise in a report.
      stack: error.stack ? redact(error.stack.split("\n").slice(0, 6).join("\n")) : undefined,
    };
  }
  if (depth >= 3) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => clean(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[key] = clean(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

function write(severity: Severity, event: string, details: Record<string, unknown> = {}): void {
  let entry: LogEntry;
  try {
    entry = { at: Date.now(), severity, event, details: clean(details) as Record<string, unknown> };
  } catch {
    entry = { at: Date.now(), severity, event, details: { note: "details could not be recorded" } };
  }
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  const line = `[bookmark-studio] ${severity.toUpperCase()} ${event}`;
  // Logging must never be the thing that throws.
  try {
    if (severity === "error") console.error(line, entry.details);
    else if (severity === "warn") console.warn(line, entry.details);
    else if (severity === "info") console.info(line, entry.details);
    else console.debug(line, entry.details);
  } catch {
    // Console unavailable.
  }
}

export const log = {
  debug: (event: string, details?: Record<string, unknown>) => write("debug", event, details),
  info: (event: string, details?: Record<string, unknown>) => write("info", event, details),
  warn: (event: string, details?: Record<string, unknown>) => write("warn", event, details),
  error: (event: string, details?: Record<string, unknown>) => write("error", event, details),
};

export function recentLog(): readonly LogEntry[] {
  return ring.slice();
}

/** Plain-text report for a bug report: environment plus the recent log, already redacted. */
export function diagnosticsReport(extra: Record<string, unknown> = {}): string {
  const lines = [
    "Bookmark Studio diagnostics",
    `version: ${import.meta.env.VITE_APP_VERSION ?? "unknown"}`,
    `time: ${new Date().toISOString()}`,
    `browser: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
    `online: ${typeof navigator !== "undefined" ? String(navigator.onLine) : "unknown"}`,
    ...Object.entries(clean(extra) as Record<string, unknown>).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "",
    "recent events (oldest first):",
    ...ring.map(
      (entry) =>
        `${new Date(entry.at).toISOString()} ${entry.severity.toUpperCase().padEnd(5)} ${entry.event} ${JSON.stringify(entry.details)}`,
    ),
  ];
  return lines.join("\n");
}

/** Test hook. */
export function clearLog(): void {
  ring.length = 0;
}
