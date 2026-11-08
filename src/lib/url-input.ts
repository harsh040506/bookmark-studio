/**
 * Turning what a person typed or pasted into a bookmark address — or a reason it can't be one.
 *
 * Shared by the Add and Edit dialogs (so the error appears under the field as they type), the
 * paste handler, and `addBookmark` itself (so nothing that skips the UI can store a
 * `javascript:` link). The importers apply the same allow-list on their own path.
 */

const ALLOWED = new Set(["http:", "https:", "ftp:"]);
const MAX_URL_LENGTH = 2048;

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** "example.com/x" → "https://example.com/x"; "javascript:…" → an error. */
export function normalizeUserUrl(raw: string): UrlCheck {
  const value = raw.trim().replace(/^<|>$/g, "");
  if (!value) return { ok: false, error: "Enter a web address." };
  if (value.length > MAX_URL_LENGTH) return { ok: false, error: "That address is too long to be a real link." };
  if (/\s/.test(value)) return { ok: false, error: "A web address can't contain spaces." };

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  // "localhost:3000" and "example.com:8080" look like a scheme but are a host with a port.
  const looksLikeHostPort = /^[^/:]+:\d+(\/|$)/.test(value);
  const candidate = hasScheme && !looksLikeHostPort ? value : `https://${value.replace(/^\/\//, "")}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "That doesn't look like a web address." };
  }
  if (!ALLOWED.has(parsed.protocol)) {
    return { ok: false, error: `“${parsed.protocol}” links can't be saved. Use an http or https address.` };
  }
  const host = parsed.hostname;
  if (!host || (!host.includes(".") && host !== "localhost" && !/^\[.*\]$/.test(host))) {
    return { ok: false, error: "Add the full site name, for example example.com." };
  }
  return { ok: true, url: parsed.toString() };
}

/** Whether pasted text is a single link (and nothing else), for paste-to-add. */
export function pastedLink(text: string): string | null {
  const value = text.trim();
  if (!value || /\s/.test(value) || value.length > MAX_URL_LENGTH) return null;
  if (!/^(https?:\/\/|www\.)/i.test(value)) return null;
  const check = normalizeUserUrl(value);
  return check.ok ? check.url : null;
}
