/**
 * Reading configuration out of the environment, safely.
 *
 * ## Why this is not just `Number(process.env.X ?? default)`
 *
 * That idiom reads correctly and fails silently, and every one of its failures in this
 * server is worse than a crash would have been. `Number("")` is `0`, `Number("abc")` is
 * `NaN`, and both flow straight into places where they are catastrophic rather than merely
 * wrong:
 *
 *   - `SCREENSHOT_CONCURRENCY=auto` made the tab gate `createGate(NaN)`. Every comparison
 *     against `NaN` is false, so `active < max` never admitted anybody: the first capture
 *     request queued, and so did every one after it, permanently, with no error raised
 *     anywhere. Screenshots simply stopped working for the life of the process.
 *   - `SCREENSHOT_CACHE_MAX_BYTES=512MB` made the prune loop's `total <= MAX_CACHE_BYTES`
 *     false forever, so instead of trimming the cache to a budget it deleted every
 *     screenshot on disk, on every batch.
 *   - `PORT=` (set but empty) resolved to `0`, which tells Node to listen on a random free
 *     port. The server starts, logs a success line, and is not where anyone is looking.
 *
 * A misconfigured value is a mistake someone made in a shell profile or a compose file
 * hours earlier. The only useful behaviour is to say so, loudly and once, and carry on with
 * the default — refusing to start would turn a typo in an optional tuning knob into a dead
 * application, and silently accepting it produces the failures above.
 */

/** Written once per bad value, so a warning cannot become a log flood. */
const warned = new Set<string>();

function warnOnce(name: string, message: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[bookmark-studio] ${name}: ${message}`);
}

/**
 * Reads a positive integer setting, falling back to `fallback` when it is absent or unusable.
 *
 * Bounds are part of validation rather than a separate concern: a concurrency of 10,000 is
 * as unusable as a concurrency of `NaN`, and the person who typed it wants to be told.
 */
export function intFromEnv(
  name: string,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    warnOnce(name, `"${raw}" is not a number — using ${fallback}`);
    return fallback;
  }
  if (!Number.isInteger(value)) {
    warnOnce(name, `"${raw}" is not a whole number — using ${fallback}`);
    return fallback;
  }
  if (value < min || value > max) {
    warnOnce(name, `${value} is outside ${min}–${max} — using ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * Reads a TCP port.
 *
 * Zero is excluded deliberately even though it is a legal argument to `listen`: it means
 * "any free port", which for a server whose client is a browser tab pointed at a fixed
 * address is never what was intended.
 */
export function portFromEnv(name: string, fallback: number): number {
  return intFromEnv(name, fallback, { min: 1, max: 65_535 });
}

/** Test hook: warnings are once-per-process, which would otherwise leak between cases. */
export function resetConfigWarnings(): void {
  warned.clear();
}
