# Changelog

## Unreleased

### Large libraries
- Previews never load more than five pages at once. The local server runs one headless browser at most; a tab's slot is freed only once it has closed, and the browser is shut down completely before a new one starts. It restarts after a set number of captures, and whenever a tab will not close.
- The extension closes every capture window before starting another, and closes windows left behind if Chrome stops its background worker mid-capture. The page sends at most five capture requests at a time.
- Suggested tags now name real topics (`design`, `typography`, `ai`, …). Earlier versions split folder names and titles into words, so a folder called "Everything Else & Stuff" became the tags `everything`, `else` and `stuff`. Existing libraries are cleaned up once on first load; tags you added yourself are kept.

### Interface
- Import: the sources that match the file are listed first, the list is a keyboard-friendly radio group, the Import button stays visible however long the step is, and a loaded sample library can be removed as part of a real import.
- Light favicons (white logos) sit on a dark chip, so they no longer show as blank squares. Cards without a preview show a larger icon.
- Theme menu icons sit beside their labels. Long titles wrap inside their cards. The list view's folder column lines up and shows the folder's own name.
- The sidebar says "Add the extension for previews" rather than "Offline" when the network is fine. Cards have short, accurate screen-reader names.

## 5.0.0

First public release.

### Ways to run it
- **Website.** Works in any modern browser with nothing installed. It can be installed as an app and works offline.
- **Chrome extension.** Syncs both ways with the browser's bookmarks. Reads pages, checks links and captures previews.
- **Website + extension.** The extension gives the website the same capabilities. Optional two-way bookmark sync.
- **Local server.** Every capability in any browser (`npm start` or Docker), with previews rendered in headless Chrome or Edge.

### Features
- Import from 28 sources, including every major browser, Pocket, Instapaper, Raindrop, Pinboard, Notion, Evernote, CSV, JSON and plain link lists. Source detection, a preview before writing, merge or replace, and backup restore.
- A sample library to explore before importing.
- Search with typo correction, operators (`tag:`, `site:`, `is:`, `has:`, `kind:`, `color:`) and plain-English dates.
- Grid, masonry and list layouts, windowed for libraries of 100,000 items.
- Folders, boards, tags, favourites, archive, trash, and smart collections that fill themselves from a saved search.
- Page previews, link health with archive fallbacks, offline copies, duplicate detection and merging, look-alike and colour search.
- Notes and highlights, a detail panel with keyboard stepping, a command palette, keyboard shortcuts for everything.
- Export to browser HTML, a full JSON backup or CSV, and "share as a page": one self-contained HTML file.
- Paste a link or picture anywhere to save it.
- Undo for every destructive action, and an activity log.
- System, light and dark themes. Works on phones.
