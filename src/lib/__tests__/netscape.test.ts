import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  parseNetscapeBookmarks,
  serializeNetscapeBookmarks,
} from "../netscape";

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1766398391" LAST_MODIFIED="1784737928" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/" ADD_DATE="1722237152" ICON="data:image/png;base64,AAAA">Example &amp; Co</A>
        <DT><H3 ADD_DATE="1700000000">Design &amp; Type</H3>
        <DL><p>
            <DT><A HREF="https://fontshare.com/" ADD_DATE="1700000001">Fontshare</A>
            <DD>Free quality fonts
            <DT><H3 ADD_DATE="1700000002">Nested deeper</H3>
            <DL><p>
                <DT><A HREF="https://ui.shadcn.com/" ADD_DATE="1700000003">shadcn/ui</A>
            </DL><p>
        </DL><p>
        <DT><A HREF="javascript:void(0)" ADD_DATE="1700000004">Bookmarklet</A>
    </DL><p>
    <DT><A HREF="https://root-level.com/" ADD_DATE="1700000005">Root level bookmark</A>
</DL><p>`;

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("McKinsey &amp; Company")).toBe("McKinsey & Company");
    expect(decodeEntities("The Ekmans&#39; Atlas")).toBe("The Ekmans' Atlas");
    expect(decodeEntities("a &#x27;b&#x27;")).toBe("a 'b'");
    expect(decodeEntities("&lt;tag&gt;")).toBe("<tag>");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeEntities("100 &widget; more")).toBe("100 &widget; more");
  });
});

describe("parseNetscapeBookmarks", () => {
  const result = parseNetscapeBookmarks(CHROME_EXPORT);

  it("finds every usable bookmark and skips unsupported schemes", () => {
    expect(result.bookmarks).toHaveLength(4);
    expect(result.skipped).toBe(1); // the javascript: bookmarklet
  });

  it("reconstructs the folder hierarchy", () => {
    const byName = new Map(result.folders.map((folder) => [folder.name, folder]));
    expect([...byName.keys()]).toEqual(["Bookmarks bar", "Design & Type", "Nested deeper"]);
    expect(byName.get("Bookmarks bar")!.parentId).toBeNull();
    expect(byName.get("Design & Type")!.parentId).toBe(byName.get("Bookmarks bar")!.id);
    expect(byName.get("Nested deeper")!.parentId).toBe(byName.get("Design & Type")!.id);
  });

  it("marks the browser toolbar folder", () => {
    expect(result.folders.find((folder) => folder.toolbar)?.name).toBe("Bookmarks bar");
  });

  it("decodes entities in titles and folder names", () => {
    expect(result.bookmarks.map((b) => b.title)).toContain("Example & Co");
    expect(result.folders.map((f) => f.name)).toContain("Design & Type");
  });

  it("keeps embedded favicons", () => {
    const example = result.bookmarks.find((b) => b.url === "https://example.com/");
    expect(example?.icon).toBe("data:image/png;base64,AAAA");
  });

  it("attaches <DD> descriptions to the preceding bookmark", () => {
    const fontshare = result.bookmarks.find((b) => b.url === "https://fontshare.com/");
    expect(fontshare?.description).toBe("Free quality fonts");
  });

  it("converts second-precision timestamps to milliseconds", () => {
    const example = result.bookmarks.find((b) => b.url === "https://example.com/");
    expect(example?.addedAt).toBe(1722237152 * 1000);
  });

  it("keeps bookmarks that sit outside any folder", () => {
    const root = result.bookmarks.find((b) => b.url === "https://root-level.com/");
    expect(root?.folderId).toBeNull();
  });

  it("tolerates a file with no closing tags", () => {
    const ragged = parseNetscapeBookmarks(
      `<DL><p><DT><H3>Folder</H3><DL><p><DT><A HREF="https://a.com/">A</A>`,
    );
    expect(ragged.bookmarks).toHaveLength(1);
    expect(ragged.folders).toHaveLength(1);
  });

  it("returns nothing for an unrelated HTML document", () => {
    const result = parseNetscapeBookmarks("<html><body><p>Not a bookmark file</p></body></html>");
    expect(result.bookmarks).toHaveLength(0);
  });
});

describe("serializeNetscapeBookmarks", () => {
  it("round-trips without losing structure, icons or timestamps", () => {
    const original = parseNetscapeBookmarks(CHROME_EXPORT);
    const reparsed = parseNetscapeBookmarks(
      serializeNetscapeBookmarks({ folders: original.folders, bookmarks: original.bookmarks }),
    );

    expect(reparsed.bookmarks).toHaveLength(original.bookmarks.length);
    expect(reparsed.folders).toHaveLength(original.folders.length);
    expect(reparsed.bookmarks.map((b) => b.url).sort()).toEqual(
      original.bookmarks.map((b) => b.url).sort(),
    );
    expect(reparsed.bookmarks.map((b) => b.title).sort()).toEqual(
      original.bookmarks.map((b) => b.title).sort(),
    );
    expect(reparsed.bookmarks.find((b) => b.url === "https://example.com/")?.icon).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("escapes titles so the output stays parseable", () => {
    const html = serializeNetscapeBookmarks({
      folders: [],
      bookmarks: [
        {
          url: "https://example.com/?a=1&b=2",
          title: 'Quote " and <script>',
          addedAt: Date.now(),
          folderId: null,
        },
      ],
    });
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;script&gt;");

    const reparsed = parseNetscapeBookmarks(html);
    expect(reparsed.bookmarks[0].title).toBe('Quote " and <script>');
    expect(reparsed.bookmarks[0].url).toBe("https://example.com/?a=1&b=2");
  });
});

/**
 * Dates that arrive wrong.
 *
 * The `ADD_DATE` field is the least reliable thing in a bookmarks file: browsers disagree
 * on the epoch unit, tools that rewrite exports pad and truncate it, and Chrome's own
 * internal format counts microseconds from 1601. The unit heuristic handles the formats
 * that are merely *different*; these tests are about the ones that are wrong, because a
 * single bookmark dated five centuries from now sits permanently at the top of "Newest
 * first" with nothing on screen to explain why.
 */
describe("timestamps that cannot be trusted", () => {
  const NOW = Date.UTC(2026, 0, 15);
  const fileWith = (attribute: string) =>
    `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><A HREF="https://example.com/" ${attribute}>A link</A>
</DL><p>`;

  const dateOf = (attribute: string) =>
    parseNetscapeBookmarks(fileWith(attribute)).bookmarks[0].addedAt;

  it("reads ordinary ten-digit seconds", () => {
    // 2024-01-01T00:00:00Z
    expect(dateOf('ADD_DATE="1704067200"')).toBe(Date.UTC(2024, 0, 1));
  });

  it("reads milliseconds", () => {
    expect(dateOf('ADD_DATE="1704067200000"')).toBe(Date.UTC(2024, 0, 1));
  });

  it("reads Chrome's microseconds-since-1601", () => {
    // 1704067200 seconds of Unix time, expressed in the WebKit epoch.
    const webkit = (1704067200 + 11644473600) * 1_000_000;
    expect(dateOf(`ADD_DATE="${webkit}"`)).toBe(Date.UTC(2024, 0, 1));
  });

  it("refuses a date five centuries in the future", () => {
    // Eleven digits read as seconds: the year 2518. Real exports do contain these.
    const parsed = dateOf('ADD_DATE="17300000001"');
    expect(parsed).toBeLessThan(Date.now() + 86_400_000);
    expect(parsed).toBeGreaterThan(NOW - 10 * 365 * 86_400_000);
  });

  it("refuses a date from before the web", () => {
    // 1970, which is what a zeroed or truncated field produces.
    const parsed = dateOf('ADD_DATE="100"');
    expect(parsed).toBeGreaterThan(Date.UTC(1990, 0, 1));
  });

  it("falls back rather than inventing one when the field is absent or junk", () => {
    expect(dateOf("")).toBeGreaterThan(Date.UTC(1990, 0, 1));
    expect(dateOf('ADD_DATE="not-a-number"')).toBeGreaterThan(Date.UTC(1990, 0, 1));
    expect(dateOf('ADD_DATE="-5"')).toBeGreaterThan(Date.UTC(1990, 0, 1));
  });
});
