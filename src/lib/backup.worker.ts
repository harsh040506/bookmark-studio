/**
 * Parsing a backup file away from the main thread.
 *
 * ## The problem this solves
 *
 * `MAX_BACKUP_BYTES` is 150 MB and the restore path called `JSON.parse` on the whole
 * string. `JSON.parse` cannot be interrupted, so for however long that takes the tab is
 * frozen solid: no paint, no scroll, no Escape, no way to cancel and no way to tell
 * whether the app is working or has died. On a large backup that is tens of seconds of an
 * interface that looks crashed, at the end of a gesture the user cannot take back.
 *
 * Moving it here does not make it faster. It makes it *cancellable and observable*, which
 * is the property that was actually missing: the window keeps painting, the progress
 * copy keeps saying what is happening, and the user can close the dialog.
 *
 * ## Why the file is read here too
 *
 * The `File` handle is transferable, so the text never crosses the boundary — the worker
 * reads the blob itself. Reading it on the main thread and posting the string would copy
 * 150 MB twice for no benefit, and the copy is itself long enough to drop frames.
 *
 * ## Only pure imports
 *
 * As with the index worker: everything here must be free of DOM access, or the worker
 * fails at start-up and the fallback in `backup.ts` absorbs it silently.
 */
import { parseBackup, type RestoreResult } from "./backup";

export interface BackupRequest {
  id: number;
  file: File;
}

export type BackupResponse =
  | { id: number; ok: true; result: RestoreResult }
  | { id: number; ok: false; error: string; format: boolean };

/**
 * Guarded for the same reason `index.worker.ts` is.
 *
 * This module is only ever loaded as a worker today, but the guard costs three lines and
 * removes a whole class of failure: the moment anybody imports a helper from here — which
 * is exactly what happened to the index worker — an unguarded `self.addEventListener`
 * throws at import time and takes the importing module down with it.
 */
const isWorker =
  typeof self !== "undefined" &&
  typeof (globalThis as { DedicatedWorkerGlobalScope?: unknown }).DedicatedWorkerGlobalScope !==
    "undefined" &&
  self instanceof
    (globalThis as unknown as { DedicatedWorkerGlobalScope: new () => unknown })
      .DedicatedWorkerGlobalScope;

if (isWorker) self.addEventListener("message", async (event: MessageEvent<BackupRequest>) => {
  const { id, file } = event.data;
  try {
    const text = await file.text();
    const result = parseBackup(text);
    const response: BackupResponse = { id, ok: true, result };
    (self as unknown as Worker).postMessage(response);
  } catch (error) {
    /*
     * The distinction between "this file is not a backup" and "something went wrong" has
     * to survive the crossing, because they need different words in front of the user —
     * one is a file-picking mistake they can fix, the other is not their doing at all.
     * An `Error` subclass does not survive a structured clone, so the kind travels as a
     * flag and is reconstructed on the other side.
     */
    const message = error instanceof Error ? error.message : "That file could not be read.";
    const response: BackupResponse = {
      id,
      ok: false,
      error: message,
      format: error instanceof Error && error.name === "BackupFormatError",
    };
    (self as unknown as Worker).postMessage(response);
  }
});
