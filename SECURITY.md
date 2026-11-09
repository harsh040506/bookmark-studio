# Security

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting). Include steps to reproduce and the runtime affected: website, extension, or local server.

You'll get an acknowledgement within a few days.

## What the app does and doesn't do

- **The library never leaves the browser.** Bookmarks, notes, tags, screenshots and settings live in IndexedDB on the user's device. No account, sync service or analytics exists to send them to. The website and the extension each keep a copy and swap changes through the bridge, inside the same browser profile.
- **Network requests go only to the sites in the user's library**, and only when the user has a backend connected (the extension or the local server). They are sent without cookies (`credentials: "omit"`) and without a referrer.
- **Bookmark files are untrusted input.** Every importer allows only `http`, `https` and `ftp` URLs, so `javascript:` and `data:` links never reach the database. Titles are stripped of control, zero-width and bidirectional-override characters.
- **Offline copies** are stored only after scripts, event handlers and frames are removed and a `default-src 'none'` policy is added. They open from a `blob:` URL, which keeps the app's origin, so the app's own policy (no inline script) applies as a second barrier.
- **Private network addresses** are recognised in every form a URL parser produces, including IPv4 written inside IPv6 (`[::ffff:7f00:1]`, NAT64, 6to4, Teredo) and `localhost.` with a trailing dot (`shared/ip.ts`, one classifier for the client and the server). Addresses with a username or password are refused.

## The three backends

| Backend | SSRF protection |
| --- | --- |
| **Local server** (`npm start`, Docker) | Every outbound request goes through `server/safe-fetch.ts`. It refuses private, loopback, link-local and carrier-grade-NAT addresses, re-checking every redirect hop, and connects only to an address it has just checked (`server/pinned-fetch.ts`), so a DNS answer that changes between the check and the connection (DNS rebinding) is caught. The headless browser filters its own subresource requests the same way, and a screenshot of a page that was served from a private address is thrown away. Rate limits sit in front of every fetching route. The API refuses cross-site browser requests and any `Host` that isn't a loopback name (or listed in `ALLOWED_HOSTS`), which blocks DNS-rebinding attacks from web pages you visit. The server binds to `127.0.0.1` by default. **Setting `HOST=0.0.0.0` exposes a fetch proxy to your network**; only do that behind your own access control. |
| **Extension** | Requests are checked by `src/lib/net-guard.ts` before they go out, and again where their redirects end. It refuses literal private and loopback addresses and local hostnames (`localhost`, `*.local`, `*.internal`). A browser extension cannot resolve DNS, so a public hostname that *resolves* to a private address (DNS rebinding) is not caught. Those requests come from the user's own browser, exactly as if they had typed the URL, so they carry no more reach than the user already has. |
| **Website + extension bridge** | The bridge content script is injected only into the sites listed in `extension/sites.json` (plus the deployed site the release was built for). A local address (localhost, 127.0.0.1) is shared by every project a developer runs, so it is served only after the person allows that exact origin once, in a window the extension opens itself. It relays a fixed set of operations: guarded fetch, screenshot, `chrome.bookmarks`, and swapping library changes. The service worker re-checks the sender's URL on every message, validates every payload (fetch limits are clamped, bookmarks can only be written with `http`, `https` or `ftp` addresses, and library rows are repaired and checked the same way before they are stored), and applies the same guard as above. |

## Permissions the extension asks for

| Permission | Why |
| --- | --- |
| `bookmarks` | Two-way sync with the browser's bookmarks |
| `host_permissions` for Bookmark Studio's own sites only | Connecting the bridge to the website (localhost, 127.0.0.1 and the deployed site) |
| `optional_host_permissions: <all_urls>`, asked for on first use | Reading pages, checking links, capturing screenshots and fetching favicons for the sites in the user's library. Not granted at install; the user allows it from a button in the app, and can revoke it in the browser's extension settings |
| `tabs`, `scripting` | Opening and reading the brief screenshot window, and injecting the bridge into already-open app tabs after install |
| `storage`, `unlimitedStorage` | The library and its images in IndexedDB, without the default quota |

Background capture windows are off by default; the extension opens one only when the user asks for a screenshot, or after they switch background captures on.
