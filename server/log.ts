/**
 * Structured server logging: one JSON object per line, with a severity and a stable event
 * name, so `npm start | grep '"error"'` or any log tool can filter it.
 *
 * Addresses are reduced to their origin before logging. This server reads the pages in
 * someone's library, and a log file shared in a bug report must not list them.
 * `LOG_LEVEL` (debug, info, warn, error; default info) sets the threshold.
 */
export type Severity = "debug" | "info" | "warn" | "error";

const ORDER: Record<Severity, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Severity;
const threshold = ORDER[configured] ?? ORDER.info;

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

export function redact(value: string): string {
  return value.replace(URL_PATTERN, (match) => {
    try {
      const parsed = new URL(match);
      return `${parsed.protocol}//${parsed.host}/…`;
    } catch {
      return "[address]";
    }
  });
}

function clean(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message).slice(0, 500),
      code: (value as { code?: unknown }).code,
      stack: value.stack ? redact(value.stack.split("\n").slice(0, 6).join("\n")) : undefined,
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

export function logEvent(severity: Severity, event: string, details: Record<string, unknown> = {}): void {
  if (ORDER[severity] < threshold) return;
  let line: string;
  try {
    line = JSON.stringify({ time: new Date().toISOString(), severity, event, ...(clean(details) as object) });
  } catch {
    line = JSON.stringify({ time: new Date().toISOString(), severity, event, note: "details could not be serialised" });
  }
  // stderr for problems, stdout for the rest, so a supervisor can split them.
  if (severity === "error" || severity === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** A short, unguessable reference that ties an error shown to a person to its log line. */
export function newReference(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
