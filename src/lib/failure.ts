/**
 * Turns whatever a failed request threw into a short sentence a person can act on.
 *
 * Errors arrive from fetch, the bridge, the server and remote sites, in their own
 * vocabulary: "TypeError: Failed to fetch", "connect ECONNREFUSED 10.0.0.4:443", a
 * stack trace. Shown as-is they mean nothing to the reader and can leak addresses from
 * their network. Stored on a bookmark, they would also be shown forever. So each one is
 * mapped to a fixed, plain message; the original goes to the log, cut down by `log.ts`.
 */
const RULES: [RegExp, string][] = [
  [/private address|local hostname|blocked/i, "Skipped: this address points inside your own network"],
  [/password/i, "Skipped: addresses with a password are not opened"],
  [/timed? ?out|timeout|abort/i, "The site took too long to answer"],
  [/too many redirects/i, "The site kept redirecting"],
  [/dns|enotfound|getaddrinfo|name not resolved/i, "This site's name could not be found"],
  [/econnrefused|econnreset|socket|network|failed to fetch|fetch failed/i, "Could not connect to the site"],
  [/too large|ceiling|exceeded/i, "The page is too large to read"],
  [/permission|not been allowed|allow/i, "Bookmark Studio needs permission to read pages"],
  [/\b(401|403)\b|forbidden|unauthori[sz]ed/i, "The site refused to share this page"],
  [/\b404\b|not found/i, "The page no longer exists"],
  [/\b429\b|rate/i, "The site asked us to slow down; it will be retried later"],
  [/\b5\d\d\b/, "The site had a problem answering"],
  [/unsupported protocol|malformed/i, "This is not a web address that can be opened"],
];

export function friendlyFailure(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  for (const [pattern, message] of RULES) if (pattern.test(text)) return message;
  return "This page could not be read";
}
