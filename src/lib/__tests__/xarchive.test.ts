/**
 * Reading an X data archive.
 *
 * The archive's files are JavaScript assignments rather than JSON, and their envelope key
 * has changed across vintages — so the parser's real job is tolerating a format nobody
 * documents. Every test here is a shape a real archive has actually shipped.
 */
import { describe, expect, it } from "vitest";
import { looksLikeXArchive, parseXArchive, stripArchiveAssignment } from "../xarchive";

const BOOKMARK_FILE = `window.YTD.bookmark.part0 = [
  {
    "tweet" : {
      "id_str" : "1234567890",
      "full_text" : "New Nebula effect just dropped\\nSpace nebula clouds trapped inside glass. https://t.co/abc",
      "created_at" : "Mon Sep 01 12:00:00 +0000 2025",
      "favorite_count" : "42",
      "user" : { "screen_name" : "npm_i_shaders", "name" : "Shaders" },
      "entities" : {
        "hashtags" : [ { "text" : "WebGL" } ],
        "urls" : [ { "url" : "https://t.co/abc", "expanded_url" : "https://shaders.dev/nebula" } ]
      },
      "extended_entities" : {
        "media" : [
          {
            "type" : "video",
            "media_url_https" : "https://pbs.twimg.com/thumb.jpg",
            "video_info" : {
              "duration_millis" : 49000,
              "variants" : [
                { "bitrate" : 320000, "content_type" : "video/mp4", "url" : "https://video.twimg.com/low.mp4" },
                { "bitrate" : 2176000, "content_type" : "video/mp4", "url" : "https://video.twimg.com/high.mp4" },
                { "content_type" : "application/x-mpegURL", "url" : "https://video.twimg.com/playlist.m3u8" }
              ]
            }
          }
        ]
      }
    }
  }
];`;

describe("stripArchiveAssignment", () => {
  it("finds the JSON after the assignment prefix", () => {
    expect(stripArchiveAssignment('window.YTD.bookmark.part0 = [{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it("reads a bare JSON file too, for vintages with no prefix", () => {
    expect(stripArchiveAssignment('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it("tolerates a trailing semicolon", () => {
    expect(stripArchiveAssignment("window.YTD.tweets.part0 = [];")).toEqual([]);
  });

  it("throws on a file with no payload at all", () => {
    expect(() => stripArchiveAssignment("not an archive")).toThrow();
  });
});

describe("parseXArchive", () => {
  it("reads a bookmark file into posts", () => {
    const result = parseXArchive(BOOKMARK_FILE, "bookmark.js");
    expect(result.kind).toBe("bookmarks");
    expect(result.posts).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });

  it("builds the canonical post URL from the handle and id", () => {
    const [post] = parseXArchive(BOOKMARK_FILE, "bookmark.js").posts;
    expect(post.url).toBe("https://x.com/npm_i_shaders/status/1234567890");
    expect(post.author).toBe("@npm_i_shaders");
  });

  it("takes the first line as the title, since a post has none", () => {
    const [post] = parseXArchive(BOOKMARK_FILE, "bookmark.js").posts;
    expect(post.title).toBe("New Nebula effect just dropped");
    // …while the whole text is kept, because for a post the text *is* the item.
    expect(post.text).toContain("Space nebula clouds");
  });

  it("picks the highest-bitrate MP4 and ignores the HLS playlist", () => {
    const [post] = parseXArchive(BOOKMARK_FILE, "bookmark.js").posts;
    expect(post.media).toHaveLength(1);
    expect(post.media[0].url).toBe("https://video.twimg.com/high.mp4");
    expect(post.media[0].kind).toBe("video");
    expect(post.media[0].durationMs).toBe(49000);
  });

  it("classifies a post carrying video as a video", () => {
    const [post] = parseXArchive(BOOKMARK_FILE, "bookmark.js").posts;
    expect(post.kind).toBe("video");
  });

  it("resolves the t.co wrapper to the real link it points at", () => {
    const [post] = parseXArchive(BOOKMARK_FILE, "bookmark.js").posts;
    expect(post.linkedUrl).toBe("https://shaders.dev/nebula");
  });

  it("keeps hashtags as tags, lower-cased", () => {
    const [post] = parseXArchive(BOOKMARK_FILE, "bookmark.js").posts;
    expect(post.tags).toEqual(["webgl"]);
  });

  it("asks the CDN for the original rather than the timeline crop", () => {
    const file = `window.YTD.bookmark.part0 = [{"tweet":{"id_str":"1","full_text":"hi","entities":{"media":[{"type":"photo","media_url_https":"https://pbs.twimg.com/media/x.jpg"}]}}}]`;
    const [post] = parseXArchive(file, "bookmark.js").posts;
    expect(post.media[0].url).toContain("name=orig");
    expect(post.kind).toBe("image");
  });

  it("treats a post with no media as a note", () => {
    const file = `window.YTD.bookmark.part0 = [{"tweet":{"id_str":"2","full_text":"just words"}}]`;
    const [post] = parseXArchive(file, "bookmark.js").posts;
    expect(post.kind).toBe("note");
    expect(post.media).toEqual([]);
  });

  it("leaves the link unset when a post points at several", () => {
    // Picking one of them arbitrarily would mislabel what the post is about.
    const file = `window.YTD.bookmark.part0 = [{"tweet":{"id_str":"3","full_text":"two","entities":{"urls":[{"expanded_url":"https://a.com"},{"expanded_url":"https://b.com"}]}}}]`;
    const [post] = parseXArchive(file, "bookmark.js").posts;
    expect(post.linkedUrl).toBeUndefined();
  });

  it("unwraps the older envelope keys as well as the current one", () => {
    for (const key of ["tweet", "bookmark", "like"]) {
      const file = `window.YTD.x.part0 = [{"${key}":{"id_str":"9","full_text":"hi"}}]`;
      expect(parseXArchive(file, "bookmark.js").posts).toHaveLength(1);
    }
  });

  it("reads a bare record with no envelope at all", () => {
    const file = `window.YTD.x.part0 = [{"id_str":"9","full_text":"hi"}]`;
    expect(parseXArchive(file, "bookmark.js").posts).toHaveLength(1);
  });

  it("counts records it could not read rather than failing the import", () => {
    const file = `window.YTD.bookmark.part0 = [{"tweet":{"full_text":"no id"}}, null, {"tweet":{"id_str":"4","full_text":"fine"}}]`;
    const result = parseXArchive(file, "bookmark.js");
    expect(result.posts).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it("returns nothing for a file that is not an archive", () => {
    expect(parseXArchive("<html></html>", "index.html").posts).toEqual([]);
  });

  it("falls back to an anonymous URL when the archive omits the author", () => {
    // The archive leaves the user off the account's own posts, since it is implied.
    const file = `window.YTD.tweets.part0 = [{"tweet":{"id_str":"5","full_text":"mine"}}]`;
    const [post] = parseXArchive(file, "tweets.js").posts;
    expect(post.url).toBe("https://x.com/i/status/5");
  });
});

describe("looksLikeXArchive", () => {
  it("recognises the archive's file names", () => {
    expect(looksLikeXArchive("bookmark.js", "")).toBe(true);
    expect(looksLikeXArchive("tweets.js", "")).toBe(true);
    expect(looksLikeXArchive("tweets-part0.js", "")).toBe(true);
  });

  it("recognises the assignment prefix whatever the file is called", () => {
    expect(looksLikeXArchive("export.js", "window.YTD.bookmark.part0 = [")).toBe(true);
  });

  it("does not mistake an ordinary JSON backup for an archive", () => {
    expect(looksLikeXArchive("bookmarks-2026-01-01.json", '{"bookmarks":[]}')).toBe(false);
  });
});
