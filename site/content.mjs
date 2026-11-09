// The public pages, written once.
//
// `scripts/build-site.mjs` turns this file into the HTML pages, their Markdown copies,
// llms.txt, llms-full.txt, the sitemap and the social preview tags, so none of those can
// drift apart. Inline text understands **bold**, `code` and [links](url); a link that starts
// with "/" is a page on this site.

export const SITE = {
  name: "Bookmark Studio",
  /** Used when SITE_URL is not set and Vercel does not say where production lives. */
  defaultUrl: "https://bookmark-studio-app.vercel.app",
  repository: "https://github.com/harsh040506/bookmark-studio",
  author: { name: "harsh040506", url: "https://github.com/harsh040506" },
  language: "en",
  locale: "en_US",
  tagline: "A calm home for everything you save.",
  summary:
    "Bookmark Studio is a free, open-source bookmark manager that runs in your browser. It imports bookmarks from any browser or service, searches them properly, finds dead links and duplicates, and shows every page as a preview. Your library stays on your device: there is no account, no tracking and no AI.",
};

/**
 * Each page: `path` is its public address, `file` is what the build writes. `og` names an
 * image in public/og; when a picture changes, give it a new file name so platforms that cache
 * previews fetch the new one.
 */
export const PAGES = [
  {
    id: "home",
    path: "/",
    file: "index.html",
    app: true,
    nav: "App",
    title: "Bookmark Studio: a private bookmark manager in your browser",
    description:
      "Import bookmarks from any browser or service, search them properly, find dead links and duplicates, and see every page at a glance. Free, open source, no account.",
    og: { image: "og/home-2.png", alt: "Bookmark Studio: a calm home for everything you save. A grid of page previews." },
    markdownIntro: [
      { p: "Bookmark Studio is the app itself. Open it, drop in a bookmarks file (or load the sample library), and start searching. Everything is stored in your browser." },
    ],
  },
  {
    id: "about",
    path: "/about",
    file: "about.html",
    nav: "About",
    title: "About Bookmark Studio: find the things you saved",
    description:
      "Years of bookmarks across browsers and services, and you still cannot find the one you need. What Bookmark Studio does about it, and how it stays private.",
    og: { image: "og/about-2.png", alt: "You saved it for a reason. Bookmark Studio helps you find it again." },
    eyebrow: "About",
    heading: "You saved it for a reason. Now you can find it.",
    lede:
      "Bookmark Studio is a free, open-source bookmark manager that runs in your browser. It brings in everything you have saved, from any browser or service, and makes it searchable, visible and tidy, without an account and without sending your library anywhere.",
    hero: { image: "media/library-light.webp", fallback: "media/library-light.png", width: 1440, height: 900, alt: "Bookmark Studio showing a library as a grid of page previews, with folders in the sidebar." },
    sections: [
      {
        id: "problem",
        heading: "The problem with bookmarks",
        blocks: [
          { p: "Saving a page takes one click. Finding it again takes much longer." },
          {
            ul: [
              "**They are scattered.** Some are in Chrome, some in Firefox from an old laptop, some in Pocket, Raindrop or a notes app.",
              "**Search only reads titles.** You remember what the page was about, not what it was called, so the browser finds nothing.",
              "**Links quietly die.** Pages move or disappear, and you only find out when you need one.",
              "**Duplicates pile up.** The same article saved three times, in three folders, under three titles.",
              "**You cannot see them.** A wall of identical blue links and favicons gives your memory nothing to hold on to.",
            ],
          },
          { p: "So the bookmarks bar becomes a junk drawer, and people stop trusting it. Bookmark Studio is built to make that drawer useful again." },
        ],
      },
      {
        id: "features",
        heading: "What it does",
        blocks: [
          { h3: "Bring everything in" },
          { p: "Import from **28 sources**: Chrome, Edge, Brave, Opera, Vivaldi, Arc, Firefox, Safari and other browsers; Pocket, Instapaper and Readwise Reader; Raindrop.io, Pinboard, Diigo and other bookmarking services; Notion and Evernote exports; and plain HTML, CSV, JSON or a list of links. The source is detected, you preview exactly what will arrive, and any import can be undone later. Folders, dates, tags and your own ordering carry over." },
          { h3: "Find anything" },
          {
            ul: [
              "Search that forgives typos and reads the page itself, not only its title.",
              "Filters you can type: `tag:design`, `site:github.com`, `is:dead`, `kind:video`, `before:2024`.",
              "Plain English works too: \"saved last month\", \"never opened\", \"older than a year\".",
              "A command palette (`Ctrl K` or `⌘ K`) for every bookmark, folder and command.",
            ],
          },
          { h3: "See every page" },
          { p: "Every bookmark gets a preview: a screenshot or the page's own image, in a grid, masonry or compact list. Only what is on screen is drawn, so even a very large library scrolls smoothly. You can even search by colour, or find pages that look alike." },
          { h3: "Keep it healthy" },
          {
            ul: [
              "Link checks flag dead, moved and blocked pages, and offer the Wayback Machine's copy.",
              "Duplicates are found and merged in one step, and the merge can be undone.",
              "Offline copies keep the page itself, readable with the network off.",
            ],
          },
          { h3: "Organise your way" },
          { p: "Folders, boards and tags, smart collections that fill themselves from a saved search, notes and highlights. Every destructive action can be undone, and an activity log shows what changed." },
          { h3: "Take it with you" },
          { p: "Export to the standard bookmarks file every browser imports, a complete JSON backup or CSV, or share a view as a single web page with the pictures inside. Your library is never locked in." },
        ],
      },
      {
        id: "privacy",
        heading: "Private by design",
        blocks: [
          { p: "Your library is stored in your browser, on your device. There is no account to create, no server that holds your bookmarks, and no analytics. The app makes network requests only to the sites in your library, and only when you have connected the extension or the local server to read pages and check links. Those requests carry no cookies and no referrer." },
          { p: "There is no AI either. Categories come from rules, tags from a list of topics, \"similar\" from word statistics and \"looks like\" from image fingerprints. Nothing you save is sent to a model. The [privacy page](/privacy) has the details." },
        ],
      },
      {
        id: "ways-to-use",
        heading: "Three ways to use it",
        blocks: [
          {
            table: {
              head: ["", "What you get"],
              rows: [
                ["**The website**", "Nothing to install. Import, search, organise and export. Install it as an app from the address bar and it works offline."],
                ["**The browser extension**", "For Chrome, Edge, Brave, Arc, Opera, Vivaldi and Firefox 128 or newer. Adds page previews, link checks and full-text search, keeps your browser's bookmarks in sync both ways, and shares one library with the website."],
                ["**On your own computer**", "Every capability in any browser, with previews rendered by headless Chrome. Needs Node.js 22.12 or newer, or Docker."],
              ],
            },
          },
          { p: "A web page cannot read other websites by itself, so previews and link checks need the extension or the local server. The app tells you plainly which one you are using and what each adds." },
        ],
      },
      {
        id: "get-started",
        heading: "Get started in a minute",
        blocks: [
          {
            ol: [
              "Export your bookmarks. In Chrome, open the bookmark manager (`Ctrl Shift O`), click the ⋮ menu and choose **Export bookmarks**. Other browsers have the same option in their bookmark manager.",
              "[Open Bookmark Studio](/) and drop the file anywhere on the page.",
              "Check the preview, import, and start searching.",
            ],
          },
          { p: "Not ready to import? Load the sample library from the welcome screen. It is a set of real links you can explore and remove in one step." },
        ],
      },
      {
        id: "faq",
        heading: "Questions people ask",
        blocks: [
          { h3: "Is it free?" },
          { p: "Yes. Bookmark Studio is open source under the MIT licence. There is no paid tier." },
          { h3: "Do I need an account?" },
          { p: "No. There is nothing to sign up for." },
          { h3: "Where are my bookmarks stored?" },
          { p: "In your browser's own storage (IndexedDB), on your device. Clearing this site's data in your browser deletes the library, so export a backup from **Settings** now and then." },
          { h3: "Can I use it on more than one device?" },
          { p: "Each browser keeps its own library. To move a library, export a backup on one device and import it on the other. With the extension, each browser's own bookmark sync (such as Chrome sync) carries your bookmarks between devices. Within one browser, the website and the extension share a library." },
          { h3: "Does it work offline?" },
          { p: "Yes. After the first visit the app opens without a connection, and offline copies of pages stay readable." },
          { h3: "Which browsers does it support?" },
          { p: "The website works in current versions of Chrome, Edge, Firefox and Safari. The extension supports Chromium-based browsers (Chrome, Edge, Brave, Arc, Opera and Vivaldi) and Firefox 128 or newer." },
          { h3: "Can I get my bookmarks out again?" },
          { p: "Always. Export to the standard bookmarks HTML file, JSON or CSV at any time." },
        ],
      },
      {
        id: "project",
        heading: "The project",
        blocks: [
          { p: "Bookmark Studio is built in the open by [harsh040506](https://github.com/harsh040506). The [source code](https://github.com/harsh040506/bookmark-studio) is on GitHub, along with the [changelog](https://github.com/harsh040506/bookmark-studio/blob/main/CHANGELOG.md) and a guide to [how it works](https://github.com/harsh040506/bookmark-studio/blob/main/docs/ARCHITECTURE.md). Bug reports and ideas are welcome as [issues](https://github.com/harsh040506/bookmark-studio/issues)." },
        ],
      },
    ],
    share: true,
  },
  {
    id: "privacy",
    path: "/privacy",
    file: "privacy.html",
    nav: "Privacy",
    title: "Privacy: Bookmark Studio",
    description:
      "Bookmark Studio keeps your library in your browser. No account, no analytics, no cookies, no AI. What is stored, what the network sees, and how to delete everything.",
    og: { image: "og/privacy-2.png", alt: "Your library never leaves your browser. Bookmark Studio privacy." },
    eyebrow: "Privacy",
    heading: "Your library never leaves your browser",
    lede: "This page explains, in plain language, what Bookmark Studio stores, what it sends over the network, and how you stay in control. It covers the website, the Chrome extension and the local server.",
    updated: "2026-11-09",
    sections: [
      {
        id: "summary",
        heading: "The short version",
        blocks: [
          {
            ul: [
              "Bookmark Studio does not collect personal data. There is no account, no analytics and no advertising.",
              "Your bookmarks, notes, tags, previews and settings are stored on your device and nowhere else.",
              "The app sets no cookies and loads nothing from third-party services.",
              "Nothing you save is sent to an AI model.",
            ],
          },
        ],
      },
      {
        id: "storage",
        heading: "What is stored, and where",
        blocks: [
          { p: "Your library lives in your browser's IndexedDB storage, and a few preferences (such as the theme) live in its local storage. Both belong to this site in your browser only. They are needed for the app to do what you ask, so the app does not show a cookie banner." },
          { p: "If you use the extension, it keeps its copy of the library in the extension's own storage, in the same browser profile. While the extension is connected to this site, the two copies swap changes so they stay the same (you can switch this off in **Settings → Background**). That exchange happens inside your browser and never touches the network. Screenshots and offline copies stay in the copy that made them. If you run the local server, rendered previews are cached on your own disk, in a folder you can delete." },
        ],
      },
      {
        id: "network",
        heading: "What goes over the network",
        blocks: [
          {
            ul: [
              "**Loading the website.** Your browser downloads the app from the host, Vercel. Like any web host, Vercel processes standard request information such as your IP address to deliver the page and protect the service. Bookmark Studio adds no tracking of its own. See [Vercel's privacy policy](https://vercel.com/legal/privacy-policy).",
              "**Reading pages and checking links.** Only when you connect the extension or the local server, the app fetches the pages in your library to make previews, read their text and check whether they still work. Those requests go straight to each site, without cookies and without a referrer, the same as if you had opened the page yourself.",
              "**Archived copies.** When a link is dead, the app can ask the Internet Archive's Wayback Machine whether it has a copy of that address.",
            ],
          },
          { p: "No bookmark, note or search ever goes to a Bookmark Studio server, because there isn't one." },
        ],
      },
      {
        id: "extension",
        heading: "The extension's permissions",
        blocks: [
          {
            ul: [
              "**Bookmarks**, to keep your browser's bookmarks and Bookmark Studio in step.",
              "**Access to websites**, asked for the first time it is needed rather than at install, to read pages, check links and capture previews of the sites in your library. It does not read the pages you browse.",
              "**Tabs and scripting**, to capture a preview in a short-lived window when you ask for one (background capture windows are off unless you switch them on) and to connect to the Bookmark Studio website when it is open.",
              "**Storage**, so the library and its pictures are not cut off by the browser's default storage limit.",
              "**Offscreen pages and alarms**, to finish reading and checking the pages in your library in a hidden page while no Bookmark Studio window is open, including after the browser restarts. It stops once everything is done, and follows the switches in **Settings → Background**.",
            ],
          },
        ],
      },
      {
        id: "control",
        heading: "Your control",
        blocks: [
          {
            ul: [
              "**Export** everything at any time from **Settings** as HTML, JSON or CSV.",
              "**Delete** everything with **Settings → Clear library**, or by clearing this site's data in your browser. While the website and the extension share a library, clearing it in one clears both. Removing the extension deletes its copy.",
              "**Copy diagnostics** in **Settings → About** copies recent errors for a bug report. It stays on your clipboard until you choose to paste it somewhere, and web addresses in it are cut to the site name.",
            ],
          },
        ],
      },
      {
        id: "terms",
        heading: "Using the software",
        blocks: [
          { p: "Bookmark Studio is open-source software under the [MIT licence](https://github.com/harsh040506/bookmark-studio/blob/main/LICENSE). You may use, copy, change and share it. It is provided as it is, without warranty, so keep a backup of anything you cannot lose." },
        ],
      },
      {
        id: "contact",
        heading: "Questions and security reports",
        blocks: [
          { p: "Ask a question or report a problem in the project's [issues](https://github.com/harsh040506/bookmark-studio/issues). Report a security problem privately, as described in the [security policy](https://github.com/harsh040506/bookmark-studio/security/policy). If this page changes, the date above changes with it, and the history is public on GitHub." },
        ],
      },
    ],
  },
];

/** The page that answers "not found". Never indexed or listed. */
export const NOT_FOUND = {
  id: "404",
  file: "404.html",
  title: "Page not found: Bookmark Studio",
  description: "This address does not exist on Bookmark Studio.",
  heading: "This page isn't here",
  lede: "The address may be mistyped, or the page may have moved. Your library is safe: it lives in your browser, not on this site.",
};
