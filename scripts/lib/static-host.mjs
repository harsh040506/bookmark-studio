// A small stand-in for the static host, for checks and tests: serves dist/web the way
// vercel.json describes it (clean URLs, no trailing slashes, the listed headers, and 404.html
// with a real 404 status for anything missing).
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

/** vercel.json `source` patterns used here are plain regular expressions over the path. */
function headerRules(config) {
  return (config.headers ?? []).map((rule) => ({ pattern: new RegExp(`^${rule.source}$`), headers: rule.headers }));
}

export function createStaticHost(root, config) {
  const rules = headerRules(config);
  const fileAt = (relative) => {
    const full = path.join(root, relative);
    if (!full.startsWith(root)) return null;
    return existsSync(full) && statSync(full).isFile() ? full : null;
  };
  return createServer((req, res) => {
    const url = new URL(req.url, "http://host");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const redirect = (to) => {
      res.writeHead(308, { location: to + url.search });
      res.end();
    };
    if (config.trailingSlash === false && pathname.length > 1 && pathname.endsWith("/")) return redirect(pathname.replace(/\/+$/, ""));
    if (config.cleanUrls && pathname.endsWith(".html")) return redirect(pathname === "/index.html" ? "/" : pathname.slice(0, -5));

    let status = 200;
    let file = pathname === "/" ? fileAt("index.html") : fileAt(pathname.slice(1)) ?? (config.cleanUrls ? fileAt(`${pathname.slice(1)}.html`) : null);
    if (!file) {
      status = 404;
      file = fileAt("404.html");
    }
    const headers = { "content-type": TYPES[path.extname(file ?? "")] ?? "application/octet-stream" };
    for (const rule of rules) {
      if (rule.pattern.test(pathname)) for (const { key, value } of rule.headers) headers[key.toLowerCase()] = value;
    }
    // Text is compressed, as every production host does; measurements without it mislead.
    let body = req.method === "HEAD" || !file ? undefined : readFileSync(file);
    if (body && /text|javascript|json|xml|svg|manifest/.test(headers["content-type"]) && /gzip/.test(req.headers["accept-encoding"] ?? "")) {
      body = gzipSync(body);
      headers["content-encoding"] = "gzip";
      headers.vary = "Accept-Encoding";
    }
    res.writeHead(status, headers);
    res.end(body);
  });
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
