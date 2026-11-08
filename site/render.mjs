// Renders the content in site/content.mjs to HTML and to Markdown. Pure functions, so the
// build and the tests share them.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** Absolute URL for a site path ("/about") against the site's origin. */
export function absolute(siteUrl, sitePath) {
  return new URL(sitePath.replace(/^\//, ""), siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`).href;
}

/**
 * Inline markup: **bold**, `code`, [text](url). Everything else is escaped. Links to this
 * site ("/about") stay root-relative in HTML; external links open normally (no new tab, so
 * the back button works) and carry no referrer.
 */
export function inlineHtml(text) {
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    out += escapeHtml(text.slice(last, match.index));
    if (match[1] !== undefined) out += `<strong>${inlineHtml(match[1])}</strong>`;
    else if (match[2] !== undefined) out += `<code>${escapeHtml(match[2])}</code>`;
    else {
      const href = match[4];
      if (!/^(https:\/\/|\/)/.test(href)) throw new Error(`Link must be https:// or a site path: ${href}`);
      const external = href.startsWith("https://");
      out += `<a href="${escapeHtml(href)}"${external ? ' rel="noreferrer"' : ""}>${inlineHtml(match[3])}</a>`;
    }
    last = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/** Markdown keeps the same syntax; site paths become absolute so the file stands alone. */
export function inlineMarkdown(text, siteUrl) {
  return text.replace(/\]\((\/[^)\s]*)\)/g, (_, sitePath) => `](${absolute(siteUrl, sitePath)})`);
}

const plain = (text) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
export const plainText = plain;

export function blocksToHtml(blocks) {
  return blocks
    .map((block) => {
      if (block.p) return `<p>${inlineHtml(block.p)}</p>`;
      if (block.h3) return `<h3>${inlineHtml(block.h3)}</h3>`;
      if (block.ul) return `<ul>${block.ul.map((item) => `<li>${inlineHtml(item)}</li>`).join("")}</ul>`;
      if (block.ol) return `<ol>${block.ol.map((item) => `<li>${inlineHtml(item)}</li>`).join("")}</ol>`;
      if (block.table) {
        const head = block.table.head.map((cell) => `<th scope="col">${inlineHtml(cell)}</th>`).join("");
        const rows = block.table.rows
          .map((row) => `<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${inlineHtml(cell)}</th>` : `<td>${inlineHtml(cell)}</td>`)).join("")}</tr>`)
          .join("");
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
      }
      throw new Error(`Unknown block: ${JSON.stringify(block)}`);
    })
    .join("\n");
}

export function blocksToMarkdown(blocks, siteUrl) {
  const md = (text) => inlineMarkdown(text, siteUrl);
  return blocks
    .map((block) => {
      if (block.p) return md(block.p);
      if (block.h3) return `### ${md(block.h3)}`;
      if (block.ul) return block.ul.map((item) => `- ${md(item)}`).join("\n");
      if (block.ol) return block.ol.map((item, index) => `${index + 1}. ${md(item)}`).join("\n");
      if (block.table) {
        const row = (cells) => `| ${cells.map((cell) => md(cell).replace(/\|/g, "\\|")).join(" | ")} |`;
        return [row(block.table.head), row(block.table.head.map(() => "---")), ...block.table.rows.map(row)].join("\n");
      }
      throw new Error(`Unknown block: ${JSON.stringify(block)}`);
    })
    .join("\n\n");
}

/** A page as one Markdown document: the copy served beside the HTML for readers and agents. */
export function pageToMarkdown(page, site, siteUrl) {
  const parts = [`# ${page.heading ?? site.name}`, `> ${page.description}`];
  if (page.lede) parts.push(page.lede);
  if (page.markdownIntro) parts.push(blocksToMarkdown(page.markdownIntro, siteUrl));
  if (page.updated) parts.push(`Last updated: ${page.updated}`);
  for (const section of page.sections ?? []) {
    parts.push(`## ${section.heading}`, blocksToMarkdown(section.blocks, siteUrl));
  }
  parts.push(`---\n\nSource: ${absolute(siteUrl, page.path)}`);
  return `${parts.join("\n\n")}\n`;
}

/** llms.txt, following https://llmstxt.org: H1, summary quote, notes, then H2 link lists. */
export function llmsTxt(site, pages, siteUrl) {
  const markdownUrl = (page) => absolute(siteUrl, page.path === "/" ? "/index.md" : `${page.path}.md`);
  const lines = [
    `# ${site.name}`,
    "",
    `> ${site.summary}`,
    "",
    "The app runs entirely in the browser and stores the library on the user's device, so there is no public API and no account. Every page below is also available as Markdown at the linked address.",
    "",
    "## Pages",
    "",
    ...pages.map((page) => `- [${page.nav === "App" ? `${site.name} (the app)` : page.nav}](${markdownUrl(page)}): ${page.description}`),
    "",
    "## Source and documentation",
    "",
    `- [README](${site.repository}/blob/main/README.md): what it does, the three ways to run it, configuration`,
    `- [Architecture](${site.repository}/blob/main/docs/ARCHITECTURE.md): how one codebase runs as a website, an extension and a local server`,
    `- [Security](${site.repository}/blob/main/SECURITY.md): the threat model and how outbound requests are guarded`,
    `- [Changelog](${site.repository}/blob/main/CHANGELOG.md): what changed in each release`,
    "",
    "## Optional",
    "",
    `- [Full text of every page](${absolute(siteUrl, "/llms-full.txt")}): all the pages above in one file`,
    `- [Contributing](${site.repository}/blob/main/CONTRIBUTING.md): how to build, test and propose changes`,
    "",
  ];
  return lines.join("\n");
}

export function llmsFullTxt(site, pages, siteUrl) {
  // Each page drops one heading level so the whole file keeps a single H1.
  const demote = (markdown) => markdown.replace(/^(#{1,5}) /gm, "#$1 ");
  return [`# ${site.name}`, "", `> ${site.summary}`, "", ...pages.map((page) => demote(pageToMarkdown(page, site, siteUrl)))].join("\n");
}

export function sitemapXml(pages, siteUrl, lastmod) {
  const urls = pages
    .filter((page) => !page.noindex)
    .map((page) => `  <url>\n    <loc>${escapeHtml(absolute(siteUrl, page.path))}</loc>\n    <lastmod>${page.updated ?? lastmod}</lastmod>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(siteUrl) {
  return [
    "# Everything on this site is public. The app keeps each person's library in their own browser,",
    "# so there is nothing private here to crawl.",
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${absolute(siteUrl, "/sitemap.xml")}`,
    "",
  ].join("\n");
}
