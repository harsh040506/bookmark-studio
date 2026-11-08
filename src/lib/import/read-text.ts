/**
 * Reads an import file as text, in whatever encoding it was actually saved in.
 *
 * `File.text()` always decodes as UTF-8. That is right for nearly every modern export, and
 * badly wrong for the rest:
 *
 *  - **UTF-16** (Excel's "Unicode Text", PowerShell's default `Out-File`, some Windows tools)
 *    decodes to text with a NUL between every character, which no parser recognises, so
 *    the import reports "nothing found" for a perfectly good file.
 *  - **Windows-1252 / Latin-1** (old IE and Netscape exports, hand-saved CSVs) turns every
 *    accented letter into "�", silently corrupting titles in hundreds of rows.
 *
 * Detection, in order of certainty: a byte-order mark; the NUL pattern UTF-16 leaves in
 * mostly-ASCII text; then a strict UTF-8 decode, falling back to Windows-1252 only when the
 * bytes are not valid UTF-8 at all. A leading BOM is never left in the text.
 */
export type DetectedEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";

  // No BOM: mostly-ASCII UTF-16 has a zero in every other byte.
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) {
      if (index % 2 === 0) evenZeros += 1;
      else oddZeros += 1;
    }
  }
  const pairs = sample.length / 2;
  if (pairs >= 8 && oddZeros > pairs * 0.3 && evenZeros < pairs * 0.05) return "utf-16le";
  if (pairs >= 8 && evenZeros > pairs * 0.3 && oddZeros < pairs * 0.05) return "utf-16be";

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: DetectedEncoding } {
  const encoding = detectEncoding(bytes);
  // `ignoreBOM: false` (the default) strips a matching BOM; the replace catches any other.
  const text = new TextDecoder(encoding).decode(bytes).replace(/^﻿/, "");
  return { text, encoding };
}

export async function readImportText(file: Blob): Promise<{ text: string; encoding: DetectedEncoding }> {
  const buffer = await file.arrayBuffer();
  return decodeText(new Uint8Array(buffer));
}
