/**
 * Import files saved in encodings other than UTF-8.
 *
 * Read as UTF-8, a UTF-16 export becomes text with a NUL between every character (so the
 * import finds nothing) and a Windows-1252 file turns accented letters into "�".
 */
import { describe, expect, it } from "vitest";
import { decodeText, detectEncoding } from "../import/read-text";
import { parseNetscapeBookmarks } from "../netscape";

const SAMPLE = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><A HREF="https://café.example/">Café crème</A>\n</DL>';

function utf16le(text: string, bom: boolean): Uint8Array {
  const out = new Uint8Array((bom ? 2 : 0) + text.length * 2);
  let offset = 0;
  if (bom) {
    out[0] = 0xff;
    out[1] = 0xfe;
    offset = 2;
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    out[offset + index * 2] = code & 0xff;
    out[offset + index * 2 + 1] = code >> 8;
  }
  return out;
}

function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    out[2 + index * 2] = code >> 8;
    out[3 + index * 2] = code & 0xff;
  }
  return out;
}

function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

describe("import file encodings", () => {
  it("reads UTF-8, with or without a byte-order mark, and drops the mark", () => {
    const plain = new TextEncoder().encode(SAMPLE);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...plain]);
    expect(decodeText(plain).text).toBe(SAMPLE);
    expect(decodeText(withBom).text).toBe(SAMPLE);
  });

  it("reads UTF-16 little-endian, with or without a byte-order mark", () => {
    expect(decodeText(utf16le(SAMPLE, true))).toEqual({ text: SAMPLE, encoding: "utf-16le" });
    expect(decodeText(utf16le(SAMPLE, false))).toEqual({ text: SAMPLE, encoding: "utf-16le" });
  });

  it("reads UTF-16 big-endian", () => {
    expect(decodeText(utf16be(SAMPLE)).text).toBe(SAMPLE);
  });

  it("reads a legacy Windows-1252 file without replacement characters", () => {
    const { text, encoding } = decodeText(latin1(SAMPLE));
    expect(encoding).toBe("windows-1252");
    expect(text).toContain("Café crème");
    expect(text).not.toContain("�");
  });

  it("produces bookmarks from a UTF-16 export end to end", () => {
    const parsed = parseNetscapeBookmarks(decodeText(utf16le(SAMPLE, true)).text);
    expect(parsed.bookmarks).toHaveLength(1);
    expect(parsed.bookmarks[0].title).toBe("Café crème");
  });

  it("does not mistake ordinary UTF-8 for UTF-16", () => {
    expect(detectEncoding(new TextEncoder().encode("a,b,c\n1,2,3\n".repeat(20)))).toBe("utf-8");
  });
});
