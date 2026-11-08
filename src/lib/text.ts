/**
 * Text utilities backing search, tagging and similarity.
 * Deliberately small and deterministic — no embeddings, no network, no model calls.
 */

/** Words that carry no signal for ranking or tagging. */
export const STOPWORDS = new Set([
  "a","about","above","after","again","all","am","an","and","any","are","as","at",
  "be","because","been","before","being","below","best","between","both","but","by",
  "can","com","could","did","do","does","doing","down","during","each","few","for",
  "free","from","further","get","had","has","have","having","he","her","here","hers",
  "him","his","how","html","http","https","i","if","in","into","is","it","its","just",
  "me","more","most","my","new","no","nor","not","now","of","off","on","once","one",
  "only","or","other","our","ours","out","over","own","page","review","s","same","she",
  "should","site","so","some","such","t","than","that","the","their","them","then",
  "there","these","they","this","those","through","to","too","top","under","until",
  "up","use","using","very","via","was","we","were","what","when","where",
  "which","while","who","whom","why","will","with","without","www","you","your","yours",
]);

/** Suffix rules good enough for matching English tech vocabulary. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  for (const [suffix, min] of [
    ["ies", 4],
    ["ing", 5],
    ["ers", 5],
    ["ed", 5],
    ["es", 4],
    ["s", 4],
  ] as const) {
    if (word.length >= min && word.endsWith(suffix)) {
      return suffix === "ies" ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length);
    }
  }
  return word;
}

const COMBINING_MARKS = /[̀-ͯ]/g;

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "");
}

/** Splits text into meaningful, stemmed terms. */
export function tokenize(value: string): string[] {
  const tokens: string[] = [];
  for (const raw of normalize(value).split(/[^a-z0-9+#]+/)) {
    if (raw.length < 2 || raw.length > 30) continue;
    if (STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw) && raw.length !== 4) continue; // keep years, drop ids
    tokens.push(stem(raw));
  }
  return tokens;
}

/**
 * Like `tokenize`, but keeps the original spelling.
 * Stems are great for matching and terrible for display — nobody wants a tag
 * reading "vibecod" or "resourc" — so anything user-visible uses this instead,
 * de-duplicated by stem to avoid "design" and "designs" both showing up.
 */
export function tokenizeForDisplay(value: string): string[] {
  const bySteam = new Map<string, string>();
  for (const raw of normalize(value).split(/[^a-z0-9+#]+/)) {
    if (raw.length < 3 || raw.length > 24) continue;
    if (STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    const key = stem(raw);
    const existing = bySteam.get(key);
    // Prefer the shortest surface form ("design" over "designing").
    if (!existing || raw.length < existing.length) bySteam.set(key, raw);
  }
  return [...bySteam.values()];
}

/** Turns a hostname into searchable words: "ui.shadcn.com" -> ["ui", "shadcn"] */
export function tokenizeDomain(domain: string): string[] {
  return domain
    .replace(/^www\./, "")
    .split(/[.\-_]/)
    .filter((part) => part.length > 1 && !["com","org","net","io","co","dev","app","ai","www","gov","edu"].includes(part))
    .map(stem);
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function getDomain(input: string): string {
  try {
    return new URL(normalizeUrl(input)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return input.replace(/^https?:\/\//i, "").split("/")[0].replace(/^www\./, "").toLowerCase();
  }
}

/**
 * Canonical form used for duplicate detection: drops the scheme, "www.",
 * tracking parameters, trailing slashes and fragments.
 */
export function canonicalUrl(input: string): string {
  try {
    const url = new URL(normalizeUrl(input));
    const params = new URLSearchParams(url.search);
    for (const key of [...params.keys()]) {
      // Prefixed families (utm_source, utm_medium, mc_cid, …) plus standalone tags.
      const isTracking =
        /^(utm_|mc_|pk_|hsa_|vero_)/i.test(key) ||
        /^(fbclid|gclid|dclid|msclkid|igshid|twclid|ref|ref_src|referrer|source|si|yclid|_ga)$/i.test(key);
      if (isTracking) params.delete(key);
    }
    const query = params.toString();
    const path = url.pathname.replace(/\/+$/, "");
    /**
     * A routed fragment is part of the address; an anchor is not.
     *
     * Dropping every `#…` is right for `#introduction` — the same document, scrolled — and
     * badly wrong for `#/projects`, which in a single-page app is a different page
     * entirely. Collapsing those made two unrelated bookmarks look like one link saved
     * twice, and the duplicate merge does not merely *list* duplicates: it elects a
     * survivor and deletes the rest. So the bug did not show as a miscount, it showed as
     * a bookmark disappearing.
     *
     * The `#/` prefix is the convention every hash router uses (Angular, Vue Router in
     * hash mode, older React Router) and is what distinguishes the two cases without
     * having to guess at the site.
     */
    const route = url.hash.startsWith("#/") ? url.hash : "";
    return `${url.hostname.replace(/^www\./, "")}${path}${query ? `?${query}` : ""}${route}`.toLowerCase();
  } catch {
    return normalize(input);
  }
}

/**
 * Extractive summary: picks the leading sentences that fit a budget.
 * Nothing is generated — the words come straight from the page.
 */
export function extractSummary(text: string, maxChars = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let summary = "";
  for (const sentence of sentences) {
    if (summary.length + sentence.length > maxChars) break;
    summary += (summary ? " " : "") + sentence;
  }
  if (!summary) summary = `${clean.slice(0, maxChars).trimEnd()}…`;
  return summary;
}

/** Title-cases a term for display as a tag. */
export function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (character) => character.toUpperCase());
}
