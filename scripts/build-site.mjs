// Writes the public, crawlable side of the website into dist/web, after Vite has built the app.
//
//   - index.html (the app) gets its search and social tags, structured data, and a real
//     text shell that shows while the app starts and stays readable without JavaScript.
//   - about.html, privacy.html and 404.html are plain static pages. Vercel serves them at
//     /about and /privacy (cleanUrls in vercel.json); the local server does the same.
//   - A Markdown copy of each page, llms.txt and llms-full.txt for readers and agents.
//   - robots.txt, sitemap.xml, .well-known/security.txt and favicon.ico.
//
// Everything comes from site/content.mjs, so the pages, the Markdown, llms.txt and the sitemap
// cannot disagree. Absolute addresses use SITE_URL, then Vercel's production address, then the
// project's own site.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NOT_FOUND, PAGES, SITE } from "../site/content.mjs";
import {
  absolute,
  blocksToHtml,
  escapeHtml,
  inlineHtml,
  llmsFullTxt,
  llmsTxt,
  pageToMarkdown,
  plainText,
  robotsTxt,
  sitemapXml,
} from "../site/render.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

export function resolveSiteUrl(env = process.env) {
  const raw =
    env.SITE_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    SITE.defaultUrl;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`SITE_URL must use https: ${raw}`);
  }
  return url.origin + url.pathname.replace(/\/?$/, "/");
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("base64url").slice(0, 10);

/** Writes `bytes` into assets/ under a content-hashed name, so it can be cached for a year. */
function hashedAsset(out, name, bytes) {
  const ext = path.extname(name);
  const file = `assets/${path.basename(name, ext)}-${hash(bytes)}${ext}`;
  mkdirSync(path.join(out, "assets"), { recursive: true });
  writeFileSync(path.join(out, file), bytes);
  return file;
}

/** favicon.ico holding PNGs, which every browser since IE has understood. */
export function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((png) => png.data)]);
}

/** Width and height from a PNG's header, to check preview images are the size we claim. */
export function pngSize(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const LOGO = readFileSync(path.join(ROOT, "public", "favicon.svg"), "utf8").replace("<svg ", '<svg aria-hidden="true" focusable="false" ');

/** Links inside the site are written "/about"; on the page they are relative, so a sub-path host works too. */
const rel = (sitePath) => (sitePath === "/" ? "./" : sitePath.replace(/^\//, ""));

function structuredData(page, siteUrl) {
  const home = absolute(siteUrl, "/");
  const url = absolute(siteUrl, page.path);
  const author = { "@type": "Person", "@id": `${SITE.author.url}#person`, name: SITE.author.name, url: SITE.author.url };
  const website = {
    "@type": "WebSite",
    "@id": `${home}#website`,
    url: home,
    name: SITE.name,
    description: SITE.summary,
    inLanguage: SITE.language,
    publisher: { "@id": author["@id"] },
  };
  const app = {
    "@type": "WebApplication",
    "@id": `${home}#app`,
    name: SITE.name,
    url: home,
    description: SITE.summary,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Any",
    browserRequirements: "Requires JavaScript and a current version of Chrome, Edge, Firefox or Safari.",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    license: `${SITE.repository}/blob/main/LICENSE`,
    image: absolute(siteUrl, `/${PAGES[0].og.image}`),
    screenshot: absolute(siteUrl, "/media/library-light.png"),
    author: { "@id": author["@id"] },
    featureList: [
      "Import bookmarks from 28 browsers, services and file formats",
      "Typo-tolerant full-text search with filters",
      "Page previews in grid, masonry and list views",
      "Dead link and duplicate detection",
      "Offline copies of pages",
      "Folders, boards, tags and smart collections",
      "Export to HTML, JSON and CSV",
    ],
  };
  const source = {
    "@type": "SoftwareSourceCode",
    "@id": `${SITE.repository}#code`,
    name: SITE.name,
    codeRepository: SITE.repository,
    programmingLanguage: "TypeScript",
    license: `${SITE.repository}/blob/main/LICENSE`,
    author: { "@id": author["@id"] },
    targetProduct: { "@id": app["@id"] },
  };
  const graph = [website, author];
  if (page.app) {
    graph.push(app, source);
  } else {
    const breadcrumb = {
      "@type": "BreadcrumbList",
      "@id": `${url}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE.name, item: home },
        { "@type": "ListItem", position: 2, name: page.nav, item: url },
      ],
    };
    graph.push(breadcrumb, {
      "@type": page.id === "about" ? "AboutPage" : "WebPage",
      "@id": `${url}#webpage`,
      url,
      name: page.title,
      description: page.description,
      inLanguage: SITE.language,
      isPartOf: { "@id": website["@id"] },
      about: { "@id": app["@id"] },
      breadcrumb: { "@id": breadcrumb["@id"] },
      primaryImageOfPage: { "@type": "ImageObject", url: absolute(siteUrl, `/${page.og.image}`), width: 1200, height: 630 },
      ...(page.updated ? { dateModified: page.updated } : {}),
    });
    if (page.id === "about") graph.push(app);
  }
  // "<" escaped so text can never close the script element early.
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

function headTags(page, siteUrl, assets, { noindex = false } = {}) {
  const url = page.path ? absolute(siteUrl, page.path) : null;
  const image = page.og ? absolute(siteUrl, `/${page.og.image}`) : null;
  const markdown = page.path ? (page.path === "/" ? "index.md" : `${rel(page.path)}.md`) : null;
  const tags = [
    `<title>${escapeHtml(page.title)}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}" />`,
    noindex ? `<meta name="robots" content="noindex" />` : `<meta name="robots" content="index, follow, max-image-preview:large" />`,
    url && `<link rel="canonical" href="${escapeHtml(url)}" />`,
    `<meta name="theme-color" content="#faf9f5" media="(prefers-color-scheme: light)" />`,
    `<meta name="theme-color" content="#0b0b0b" media="(prefers-color-scheme: dark)" />`,
    `<meta name="color-scheme" content="light dark" />`,
    `<meta name="author" content="${escapeHtml(SITE.author.name)}" />`,
    `<link rel="icon" href="${assets.prefix}favicon.ico" sizes="32x32" />`,
    `<link rel="icon" href="${assets.prefix}favicon.svg" type="image/svg+xml" />`,
    `<link rel="apple-touch-icon" href="${assets.prefix}icons/apple-touch-icon.png" />`,
    `<link rel="manifest" href="${assets.prefix}manifest.webmanifest" />`,
  ];
  if (url && image) {
    tags.push(
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="${escapeHtml(SITE.name)}" />`,
      `<meta property="og:locale" content="${SITE.locale}" />`,
      `<meta property="og:url" content="${escapeHtml(url)}" />`,
      `<meta property="og:title" content="${escapeHtml(page.title)}" />`,
      `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
      `<meta property="og:image" content="${escapeHtml(image)}" />`,
      `<meta property="og:image:type" content="image/png" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="${escapeHtml(page.og.alt)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${escapeHtml(page.title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(page.description)}" />`,
      `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
      `<meta name="twitter:image:alt" content="${escapeHtml(page.og.alt)}" />`,
      `<link rel="alternate" type="text/markdown" href="${escapeHtml(markdown)}" title="This page as Markdown" />`,
      `<link rel="describedby" type="text/markdown" href="${assets.prefix}llms.txt" />`,
      `<script type="application/ld+json">${structuredData(page, siteUrl)}</script>`,
    );
  }
  return tags.filter(Boolean).map((tag) => `    ${tag}`).join("\n");
}

function siteHeader(current, assets) {
  const links = PAGES.filter((page) => !page.app)
    .map((page) => `<a href="${assets.prefix}${rel(page.path)}"${page.id === current ? ' aria-current="page"' : ""}>${escapeHtml(page.nav)}</a>`)
    .join("");
  return `<a class="skip" href="#main">Skip to content</a>
    <header class="site-header">
      <div class="wrap header-row">
        <a class="brand" href="${assets.prefix || "./"}">${LOGO}<span>${escapeHtml(SITE.name)}</span></a>
        <nav class="site-nav" aria-label="Site">${links}<a href="${SITE.repository}" rel="noreferrer">GitHub</a></nav>
        <a class="btn btn-primary btn-sm" href="${assets.prefix || "./"}">Open the app</a>
      </div>
    </header>`;
}

function siteFooter(page, assets) {
  const markdown = page.path ? `<a href="${page.path === "/" ? "index.md" : `${rel(page.path)}.md`}">This page as Markdown</a>` : "";
  return `<footer class="site-footer">
      <div class="wrap footer-row">
        <p>${escapeHtml(SITE.name)} is free and open source under the <a href="${SITE.repository}/blob/main/LICENSE" rel="noreferrer">MIT licence</a>.</p>
        <nav aria-label="Footer"><a href="${assets.prefix || "./"}">Open the app</a><a href="${assets.prefix}about">About</a><a href="${assets.prefix}privacy">Privacy</a><a href="${SITE.repository}" rel="noreferrer">Source code</a><a href="${SITE.repository}/issues" rel="noreferrer">Report a problem</a>${markdown}</nav>
      </div>
    </footer>`;
}

function shareBlock(page, siteUrl) {
  const url = absolute(siteUrl, page.path);
  const text = "Bookmark Studio: a free, private bookmark manager that makes years of saved links searchable again.";
  const enc = encodeURIComponent;
  const targets = [
    ["X", `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`],
    ["LinkedIn", `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`],
    ["Facebook", `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`],
    ["WhatsApp", `https://wa.me/?text=${enc(`${text} ${url}`)}`],
    ["Telegram", `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`],
    ["Reddit", `https://www.reddit.com/submit?url=${enc(url)}&title=${enc("Bookmark Studio: a private bookmark manager in your browser")}`],
    ["Email", `mailto:?subject=${enc("Bookmark Studio")}&body=${enc(`${text}\n\n${url}`)}`],
  ];
  return `<section class="share" id="share" aria-labelledby="share-h" data-share-root data-url="${escapeHtml(url)}" data-title="${escapeHtml(page.title)}" data-text="${escapeHtml(text)}">
          <h2 id="share-h">Know someone with a messy bookmarks bar?</h2>
          <p>Send them this page.</p>
          <div class="share-row">
            <label class="share-link"><span class="visually-hidden">Link to this page</span><input type="text" readonly value="${escapeHtml(url)}" /></label>
            <button type="button" class="btn btn-primary" data-copy hidden>Copy link</button>
            <button type="button" class="btn" data-share hidden>Share…</button>
          </div>
          <ul class="share-targets" aria-label="Share on">
            ${targets.map(([name, href]) => `<li><a class="btn btn-sm" href="${escapeHtml(href)}" rel="noreferrer">${name}</a></li>`).join("\n            ")}
          </ul>
          <p class="share-status" role="status" aria-live="polite" data-share-status></p>
        </section>`;
}

function documentShell({ head, body, assets }) {
  return `<!doctype html>
<html lang="${SITE.language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
${head}
    <link rel="preload" href="${assets.prefix}${assets.fontSerif}" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="${assets.prefix}${assets.fontSans}" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="${assets.prefix}${assets.css}" />
    <script src="${assets.prefix}theme-init.js"></script>
    <script src="${assets.prefix}${assets.js}" defer></script>
  </head>
  <body class="site">
    ${body}
  </body>
</html>
`;
}

function contentPage(page, siteUrl, assets) {
  const toc =
    page.sections.length > 3
      ? `<nav class="toc" aria-labelledby="toc-h"><h2 id="toc-h">On this page</h2><ol>${page.sections
          .map((section) => `<li><a href="#${section.id}">${escapeHtml(plainText(section.heading))}</a></li>`)
          .join("")}</ol></nav>`
      : "";
  const hero = page.hero
    ? `<figure class="hero-shot">
            <picture>
              <source type="image/webp" srcset="${page.hero.image}" />
              <img src="${page.hero.fallback}" width="${page.hero.width}" height="${page.hero.height}" alt="${escapeHtml(page.hero.alt)}" fetchpriority="high" decoding="async" />
            </picture>
          </figure>`
    : "";
  const sections = page.sections
    .map(
      (section) => `<section id="${section.id}" aria-labelledby="${section.id}-h">
          <h2 id="${section.id}-h">${inlineHtml(section.heading)}</h2>
          ${blocksToHtml(section.blocks).replace(/<a href="\/([^"]*)"/g, (_, sitePath) => `<a href="${rel(`/${sitePath}`)}"`)}
        </section>`,
    )
    .join("\n        ");
  const body = `${siteHeader(page.id, assets)}
    <main id="main">
      <article class="wrap doc">
        <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="./">${escapeHtml(SITE.name)}</a></li><li><span aria-current="page">${escapeHtml(page.nav)}</span></li></ol></nav>
        <header class="page-head">
          <h1>${inlineHtml(page.heading)}</h1>
          <p class="lede">${inlineHtml(page.lede)}</p>
          ${page.updated ? `<p class="meta">Last updated <time datetime="${page.updated}">${new Date(`${page.updated}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}</time></p>` : ""}
          ${page.id === "about" ? `<p class="cta"><a class="btn btn-primary" href="./">Open Bookmark Studio</a><a class="btn" href="${SITE.repository}" rel="noreferrer">See the source</a></p>` : ""}
        </header>
        ${hero}
        ${toc}
        ${sections}
        ${page.share ? shareBlock(page, siteUrl) : ""}
      </article>
    </main>
    ${siteFooter(page, assets)}`;
  return documentShell({ head: headTags(page, siteUrl, assets), body, assets });
}

function notFoundPage(siteUrl, assets) {
  // Served for any missing path, at any depth, so every address here is root-relative.
  const abs = { ...assets, prefix: "/" };
  const body = `${siteHeader("404", abs)}
    <main id="main">
      <article class="wrap doc not-found">
        <header class="page-head">
          <p class="eyebrow">404</p>
          <h1>${escapeHtml(NOT_FOUND.heading)}</h1>
          <p class="lede">${escapeHtml(NOT_FOUND.lede)}</p>
          <p class="cta"><a class="btn btn-primary" href="/">Open Bookmark Studio</a><a class="btn" href="/about">What is Bookmark Studio?</a></p>
        </header>
      </article>
    </main>
    ${siteFooter({}, abs)}`;
  return documentShell({ head: headTags(NOT_FOUND, siteUrl, abs, { noindex: true }), body, assets: abs });
}

/** The app's index.html: tags in the head, and a text shell that React replaces when it starts. */
function decorateAppShell(html, page, siteUrl, assets) {
  const head = headTags(page, siteUrl, assets);
  const shell = `<div class="boot">
        <div class="boot-card">
          ${LOGO.replace("<svg ", '<svg class="boot-logo" ')}
          <h1>${escapeHtml(SITE.name)}</h1>
          <p>${escapeHtml(SITE.tagline)} Import bookmarks from any browser or service, search them properly, find dead links and duplicates, and see every page at a glance. Free, open source, and private: your library stays in this browser.</p>
          <p class="boot-status" role="status">Opening your library…</p>
          <noscript>
            <p class="boot-noscript">Bookmark Studio needs JavaScript: your library is stored in this browser and drawn on the fly. You can still read <a href="about">what it does</a> and <a href="privacy">how it treats your data</a>.</p>
          </noscript>
          <nav aria-label="About Bookmark Studio"><a href="about">What it is</a><a href="privacy">Privacy</a><a href="${SITE.repository}" rel="noreferrer">Source code</a></nav>
        </div>
      </div>`;
  const style = `<style>
      /* The text shell that shows while the app starts; React replaces it. The body margin
         matches the app's, so nothing moves when the app's stylesheet arrives. */
      body{margin:0}
      .boot{box-sizing:border-box;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:#faf9f5;color:#1f1e1d;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      .boot-card{max-width:30rem;text-align:center}
      .boot-logo{width:44px;height:44px;margin:0 auto 14px;display:block}
      .boot h1{font:400 30px/1.15 ui-serif,Georgia,"Times New Roman",serif;margin:0 0 10px;letter-spacing:-.01em}
      .boot p{margin:0 0 12px;color:#52514e}
      .boot .boot-status{color:#6b6a65;font-size:13px}
      .boot .boot-noscript{color:#1f1e1d;background:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 0 0 1px rgba(11,11,11,.1)}
      [data-theme="dark"] .boot .boot-noscript{color:#f0efec;background:#1a1a19;box-shadow:0 0 0 1px rgba(255,255,255,.1)}
      .boot nav{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;font-size:13px}
      .boot a{color:#184f95}
      [data-theme="dark"] .boot{background:#0b0b0b;color:#f0efec}
      [data-theme="dark"] .boot p{color:#c3c2b7}
      [data-theme="dark"] .boot .boot-status{color:#a3a29b}
      [data-theme="dark"] .boot a{color:#6da7ec}
      @media (prefers-reduced-motion: no-preference){.boot-status{animation:boot-pulse 1.6s ease-in-out infinite}}
      @keyframes boot-pulse{50%{opacity:.55}}
    </style>`;
  const noscript = `<noscript><style>.boot-status{display:none}</style></noscript>`;
  let out = html;
  const replace = (marker, value) => {
    if (!out.includes(marker)) throw new Error(`index.html is missing ${marker}`);
    out = out.replace(marker, value);
  };
  out = out.replace(/<title>[^<]*<\/title>\s*/, "");
  out = out.replace(/\s*<meta\s+name="description"[\s\S]*?\/>/, "");
  out = out.replace(/\s*<meta name="theme-color"[^>]*\/>/g, "").replace(/\s*<meta name="color-scheme"[^>]*\/>/, "");
  out = out.replace(/\s*<link rel="(icon|apple-touch-icon|manifest)"[^>]*\/>/g, "");
  replace("<!-- site:head -->", `${head.trimStart()}\n    ${style}`);
  // The app's stylesheet stops blocking the first paint, so the text shell shows at once.
  // main.tsx switches it on (and waits for it) before the app draws, so the app never
  // appears unstyled. Done in the module script because the CSP allows no inline handlers.
  const css = /<link rel="stylesheet"([^>]*?)href="([^"]+\.css)">/;
  if (!css.test(out)) throw new Error("index.html has no app stylesheet");
  out = out.replace(css, '<link rel="stylesheet"$1href="$2" media="print" data-app-css>');
  replace("<!-- site:shell -->", shell);
  replace("<!-- site:noscript -->", noscript);
  return out;
}

/**
 * Builds the site into `out`. Returns the files it wrote that are not part of the app shell,
 * so the service worker can leave them out of its offline cache.
 */
export function buildSite(out, { siteUrl = resolveSiteUrl(), now = new Date() } = {}) {
  const written = [];
  const write = (file, contents) => {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    writeFileSync(path.join(out, file), contents);
    written.push(file);
  };

  // Stylesheet, script and the two fonts the pages use, under content-hashed names.
  const fontDir = (pkg) => path.join(ROOT, "node_modules", "@fontsource-variable", pkg, "files");
  const fontSans = hashedAsset(out, "site-dm-sans.woff2", readFileSync(path.join(fontDir("dm-sans"), "dm-sans-latin-wght-normal.woff2")));
  const fontSerif = hashedAsset(out, "site-newsreader.woff2", readFileSync(path.join(fontDir("newsreader"), "newsreader-latin-wght-normal.woff2")));
  const css = readFileSync(path.join(ROOT, "site", "site.css"), "utf8")
    .replace("url(FONT_SANS)", `url(${path.basename(fontSans)})`)
    .replace("url(FONT_SERIF)", `url(${path.basename(fontSerif)})`);
  const cssFile = hashedAsset(out, "site.css", Buffer.from(css));
  const jsFile = hashedAsset(out, "site.js", readFileSync(path.join(ROOT, "site", "site.js")));
  written.push(fontSans, fontSerif, cssFile, jsFile);
  const assets = { prefix: "", css: cssFile, js: jsFile, fontSans, fontSerif };

  const [home, ...pages] = PAGES;
  const indexPath = path.join(out, "index.html");
  writeFileSync(indexPath, decorateAppShell(readFileSync(indexPath, "utf8"), home, siteUrl, assets));

  for (const page of pages) write(page.file, contentPage(page, siteUrl, assets));
  write(NOT_FOUND.file, notFoundPage(siteUrl, assets));

  // Markdown copies at the same address plus ".md" (index.md for the root), per llmstxt.org.
  for (const page of PAGES) write(page.path === "/" ? "index.md" : `${page.path.slice(1)}.md`, pageToMarkdown(page, SITE, siteUrl));
  write("llms.txt", llmsTxt(SITE, PAGES, siteUrl));
  write("llms-full.txt", llmsFullTxt(SITE, PAGES, siteUrl));

  const lastmod = now.toISOString().slice(0, 10);
  write("sitemap.xml", sitemapXml(PAGES, siteUrl, lastmod));
  write("robots.txt", robotsTxt(siteUrl));

  const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  write(
    ".well-known/security.txt",
    [
      `Contact: ${SITE.repository}/security/advisories/new`,
      `Expires: ${expires}`,
      `Policy: ${SITE.repository}/security/policy`,
      "Preferred-Languages: en",
      `Canonical: ${absolute(siteUrl, "/.well-known/security.txt")}`,
      "",
    ].join("\n"),
  );

  const icons = path.join(ROOT, "public", "icons");
  write("favicon.ico", buildIco([16, 32, 48].map((size) => ({ size, data: readFileSync(path.join(icons, `icon${size}.png`)) }))));

  // Social images and page media are committed in public/ and copied by Vite; check they exist.
  // MEDIA_BOOTSTRAP=1 lets the very first build through, so npm run media can create them.
  const missing = (file) => {
    if (process.env.MEDIA_BOOTSTRAP) console.warn(`[build-site] missing ${file}; run npm run media`);
    else throw new Error(`Missing ${file}. Run npm run media.`);
  };
  for (const page of PAGES) {
    const file = path.join(out, page.og.image);
    if (!existsSync(file)) {
      missing(page.og.image);
      continue;
    }
    const { width, height } = pngSize(readFileSync(file));
    if (width !== 1200 || height !== 630) throw new Error(`${page.og.image} is ${width}×${height}, expected 1200×630`);
  }
  for (const page of PAGES) {
    if (page.hero) for (const file of [page.hero.image, page.hero.fallback]) if (!existsSync(path.join(out, file))) missing(file);
  }
  return { siteUrl, written };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const out = path.join(ROOT, "dist", "web");
  const { siteUrl, written } = buildSite(out);
  console.log(`[build-site] ${written.length} files for ${siteUrl}`);
}

