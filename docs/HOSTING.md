# Hosting the website

The website is a static build (`npm run build:web` → `dist/web`). Any static host works; `vercel.json` describes the setup this project uses, and other hosts need the same few rules.

## What the host must do

| Rule | Why |
| --- | --- |
| Serve `about.html` at `/about` and `privacy.html` at `/privacy`, and redirect `/about.html` and `/about/` to `/about` | One address per page, matching the canonical links and the sitemap |
| Answer missing paths with `404.html` and a **404 status** | Never redirect unknown addresses to the home page: crawlers treat that as a "soft 404" |
| `Cache-Control: no-cache` on `index.html`, `sw.js`, `theme-init.js`, `manifest.webmanifest` | A new deploy must reach people on their next visit |
| `Cache-Control: public, max-age=31536000, immutable` on `assets/*` | Those file names change whenever their content does |
| The headers in `vercel.json`: Content Security Policy, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` | The app keeps every library on the device; the policy keeps it that way |
| `text/markdown` and `X-Robots-Tag: noindex` on `*.md`, `llms.txt` and `llms-full.txt` | They copy the pages for readers and agents and should not compete with them in search |

HTTPS is required: the service worker, the clipboard and the extension bridge only work on a secure origin.

## Your own address

Set `SITE_URL` when building (for example `SITE_URL=https://bookmarks.example.org npm run build:web`). It is used for canonical links, link previews, the sitemap, `robots.txt`, `llms.txt` and `security.txt`. On Vercel, the project's production address is used automatically, and preview deployments are kept out of search by Vercel itself.

## Deploying and rolling back

Each deploy is atomic: the new `index.html` and its hashed assets arrive together. Tabs that were open before a deploy keep working, because the service worker keeps the previous version's files until the deploy after; they are told a new version is ready and offered a reload.

To roll back on Vercel, promote the previous deployment (**Deployments → … → Promote**, or Instant Rollback). Nothing else needs clearing: the service worker picks up whichever version is live on the next visit.

After the first deploy to a new address, submit `https://<your address>/sitemap.xml` in Google Search Console and Bing Webmaster Tools.

## Link previews

Each page names its own 1200×630 preview image in `site/content.mjs`, under `public/og/`. Platforms cache previews on their side, separately from your site, so fixing a page does not update a preview someone has already shared.

- **Changing a picture:** give the file a new name (`home-2.png`), update `site/content.mjs`, and deploy. The page address stays the same.
- **Facebook, Instagram, WhatsApp, Messenger:** paste the address into Meta's [Sharing Debugger](https://developers.facebook.com/tools/debug/) and choose **Scrape Again**. WhatsApp may keep an older preview in chats where the link was already sent.
- **LinkedIn:** paste the address into the [Post Inspector](https://www.linkedin.com/post-inspector/). Inspecting it fetches the page again.
- **Telegram:** send the address to the `@WebpageBot` bot, which refreshes its preview.
- **X, Slack, Discord:** there is no public refresh tool. They fetch the page again after their own cache expires (from minutes to about a week); a new image file name shows up as soon as they do.

No platform offers a guaranteed, universal way to clear its cache.

## Re-shooting the pictures

```bash
npm run build
npm i --no-save sharp
npm run media
```

This starts the local server, loads the sample library in a real Chrome, and writes the README screenshots and demo (`docs/media/`), the about page's screenshot (`public/media/`) and the link-preview images (`public/og/`). If a preview image changes, rename it as described above.
