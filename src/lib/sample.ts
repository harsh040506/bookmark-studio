/**
 * A sample library, for trying the app before trusting it with your own bookmarks.
 *
 * Written out as an ordinary Netscape bookmarks file and imported through the *same* pipeline
 * as a real export — same parser, same normaliser, same duplicate check — so what a visitor
 * sees is exactly what their own file would produce. It is labelled as its own import batch
 * ("Sample library") and can be removed in one step from the sidebar.
 *
 * Every link is a real, long-lived public site. Dates are spread over the last three years so
 * the date filters ("saved last month", "older than a year") have something to find.
 */

interface SampleLink {
  title: string;
  url: string;
  tags?: string[];
  description?: string;
}

interface SampleFolder {
  name: string;
  links: SampleLink[];
  folders?: SampleFolder[];
}

const LIBRARY: SampleFolder[] = [
  {
    name: "Bookmarks bar",
    links: [
      { title: "Hacker News", url: "https://news.ycombinator.com/", tags: ["news", "tech"] },
      { title: "GitHub", url: "https://github.com/", tags: ["code"] },
      { title: "MDN Web Docs", url: "https://developer.mozilla.org/en-US/", tags: ["reference", "web"] },
      { title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page", tags: ["reference"] },
    ],
  },
  {
    name: "Design",
    links: [
      { title: "Figma", url: "https://www.figma.com/", tags: ["design", "tools"] },
      { title: "Dribbble — Discover the world's top designers", url: "https://dribbble.com/", tags: ["design", "inspiration"] },
      { title: "Awwwards", url: "https://www.awwwards.com/", tags: ["design", "inspiration", "web"] },
      { title: "Refactoring UI", url: "https://www.refactoringui.com/", tags: ["design", "book"] },
      { title: "Laws of UX", url: "https://lawsofux.com/", tags: ["design", "ux"] },
      { title: "Coolors — The super fast color palettes generator", url: "https://coolors.co/", tags: ["design", "color", "tools"] },
      { title: "Google Fonts", url: "https://fonts.google.com/", tags: ["design", "typography"] },
      { title: "Typewolf", url: "https://www.typewolf.com/", tags: ["typography", "inspiration"] },
      { title: "Material Design", url: "https://m3.material.io/", tags: ["design", "design-system"] },
      { title: "Apple Human Interface Guidelines", url: "https://developer.apple.com/design/human-interface-guidelines", tags: ["design", "design-system"] },
      { title: "Nielsen Norman Group", url: "https://www.nngroup.com/articles/", tags: ["ux", "research"] },
    ],
    folders: [
      {
        name: "Icons & illustration",
        links: [
          { title: "Hugeicons", url: "https://hugeicons.com/", tags: ["icons"] },
          { title: "unDraw — open-source illustrations", url: "https://undraw.co/", tags: ["illustration"] },
          { title: "The Noun Project", url: "https://thenounproject.com/", tags: ["icons"] },
          { title: "Unsplash", url: "https://unsplash.com/", tags: ["photos"] },
        ],
      },
    ],
  },
  {
    name: "Development",
    links: [
      { title: "React", url: "https://react.dev/", tags: ["javascript", "react"] },
      { title: "TypeScript: Documentation", url: "https://www.typescriptlang.org/docs/", tags: ["typescript", "reference"] },
      { title: "Vite", url: "https://vite.dev/", tags: ["javascript", "tools"] },
      { title: "Tailwind CSS", url: "https://tailwindcss.com/", tags: ["css"] },
      { title: "Can I use…", url: "https://caniuse.com/", tags: ["web", "reference"] },
      { title: "web.dev", url: "https://web.dev/", tags: ["web", "performance"] },
      { title: "Node.js", url: "https://nodejs.org/en", tags: ["javascript", "backend"] },
      { title: "The Rust Programming Language", url: "https://doc.rust-lang.org/book/", tags: ["rust", "book"] },
      { title: "Python 3 documentation", url: "https://docs.python.org/3/", tags: ["python", "reference"] },
      { title: "Go by Example", url: "https://gobyexample.com/", tags: ["go", "learning"] },
      { title: "Stack Overflow", url: "https://stackoverflow.com/", tags: ["code", "q&a"] },
      { title: "regex101", url: "https://regex101.com/", tags: ["tools", "regex"] },
      { title: "JSON Crack", url: "https://jsoncrack.com/", tags: ["tools"] },
      { title: "Excalidraw", url: "https://excalidraw.com/", tags: ["tools", "diagrams"] },
      { title: "SQLite", url: "https://www.sqlite.org/index.html", tags: ["database"] },
      { title: "PostgreSQL Documentation", url: "https://www.postgresql.org/docs/", tags: ["database", "reference"] },
      { title: "Docker Docs", url: "https://docs.docker.com/", tags: ["devops"] },
      { title: "Kubernetes", url: "https://kubernetes.io/", tags: ["devops"] },
      { title: "Git — Book", url: "https://git-scm.com/book/en/v2", tags: ["git", "book"] },
      { title: "Oh Shit, Git!?!", url: "https://ohshitgit.com/", tags: ["git"] },
    ],
    folders: [
      {
        name: "Articles",
        links: [
          { title: "The Twelve-Factor App", url: "https://12factor.net/", tags: ["architecture"] },
          { title: "Local-first software", url: "https://www.inkandswitch.com/local-first/", tags: ["local-first", "essay"] },
          { title: "Things You Should Never Do, Part I — Joel on Software", url: "https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/", tags: ["essay"] },
          { title: "Choose Boring Technology", url: "https://boringtechnology.club/", tags: ["architecture", "essay"] },
          { title: "Falsehoods Programmers Believe About Names", url: "https://www.kalzumeus.com/2010/06/17/falsehoods-programmers-believe-about-names/", tags: ["essay"] },
        ],
      },
    ],
  },
  {
    name: "Reading",
    links: [
      { title: "Paul Graham — Essays", url: "https://paulgraham.com/articles.html", tags: ["essay", "startups"] },
      { title: "Aeon", url: "https://aeon.co/", tags: ["essay", "philosophy"] },
      { title: "The Marginalian", url: "https://www.themarginalian.org/", tags: ["essay", "books"] },
      { title: "Quanta Magazine", url: "https://www.quantamagazine.org/", tags: ["science"] },
      { title: "Nautilus", url: "https://nautil.us/", tags: ["science"] },
      { title: "Longreads", url: "https://longreads.com/", tags: ["longform"] },
      { title: "Project Gutenberg", url: "https://www.gutenberg.org/", tags: ["books", "free"] },
      { title: "Stratechery", url: "https://stratechery.com/", tags: ["business", "tech"] },
      { title: "Wait But Why", url: "https://waitbutwhy.com/", tags: ["essay"] },
    ],
  },
  {
    name: "News",
    links: [
      { title: "BBC News", url: "https://www.bbc.com/news", tags: ["news"] },
      { title: "Reuters", url: "https://www.reuters.com/", tags: ["news"] },
      { title: "The Verge", url: "https://www.theverge.com/", tags: ["tech", "news"] },
      { title: "Ars Technica", url: "https://arstechnica.com/", tags: ["tech", "news"] },
      { title: "The Guardian", url: "https://www.theguardian.com/international", tags: ["news"] },
      { title: "Hacker News", url: "https://news.ycombinator.com/", tags: ["news", "tech"] },
    ],
  },
  {
    name: "Learning",
    links: [
      { title: "Khan Academy", url: "https://www.khanacademy.org/", tags: ["learning", "free"] },
      { title: "MIT OpenCourseWare", url: "https://ocw.mit.edu/", tags: ["learning", "free"] },
      { title: "freeCodeCamp", url: "https://www.freecodecamp.org/", tags: ["learning", "code"] },
      { title: "The Odin Project", url: "https://www.theodinproject.com/", tags: ["learning", "web"] },
      { title: "3Blue1Brown", url: "https://www.3blue1brown.com/", tags: ["math", "video"] },
      { title: "Brilliant", url: "https://brilliant.org/", tags: ["math", "learning"] },
      { title: "Duolingo", url: "https://www.duolingo.com/", tags: ["languages"] },
      { title: "CS50", url: "https://cs50.harvard.edu/x/", tags: ["learning", "code"] },
    ],
  },
  {
    name: "Tools",
    links: [
      { title: "Notion", url: "https://www.notion.so/", tags: ["productivity"] },
      { title: "Obsidian", url: "https://obsidian.md/", tags: ["notes", "local-first"] },
      { title: "Linear", url: "https://linear.app/", tags: ["productivity"] },
      { title: "Raycast", url: "https://www.raycast.com/", tags: ["productivity", "mac"] },
      { title: "Squoosh", url: "https://squoosh.app/", tags: ["images", "tools"] },
      { title: "TinyPNG", url: "https://tinypng.com/", tags: ["images", "tools"] },
      { title: "DeepL Translate", url: "https://www.deepl.com/translator", tags: ["languages", "tools"] },
      { title: "Wayback Machine", url: "https://web.archive.org/", tags: ["archive"] },
      { title: "Calendly", url: "https://calendly.com/", tags: ["productivity"] },
      { title: "1Password", url: "https://1password.com/", tags: ["security"] },
      { title: "Have I Been Pwned", url: "https://haveibeenpwned.com/", tags: ["security"] },
    ],
  },
  {
    name: "Video & music",
    links: [
      { title: "YouTube", url: "https://www.youtube.com/", tags: ["video"] },
      { title: "Vimeo", url: "https://vimeo.com/", tags: ["video"] },
      { title: "Bandcamp", url: "https://bandcamp.com/", tags: ["music"] },
      { title: "Radio Garden", url: "https://radio.garden/", tags: ["music", "fun"] },
      { title: "Spotify", url: "https://open.spotify.com/", tags: ["music"] },
    ],
  },
  {
    name: "Travel & food",
    links: [
      { title: "Google Maps", url: "https://www.google.com/maps", tags: ["maps"] },
      { title: "OpenStreetMap", url: "https://www.openstreetmap.org/", tags: ["maps", "open-data"] },
      { title: "Atlas Obscura", url: "https://www.atlasobscura.com/", tags: ["travel"] },
      { title: "Serious Eats", url: "https://www.seriouseats.com/", tags: ["cooking"] },
      { title: "NYT Cooking", url: "https://cooking.nytimes.com/", tags: ["cooking"] },
      { title: "Budget Bytes", url: "https://www.budgetbytes.com/", tags: ["cooking"] },
    ],
  },
];

const DAY = 86_400;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A deterministic spread of dates over the last ~3 years, newest near the top. */
function dateFor(index: number, total: number, now: number): number {
  const ageDays = Math.round(((index * 7919) % total) / total * 1100) + (index % 5);
  return Math.floor(now / 1000) - ageDays * DAY - (index % 17) * 3600;
}

export function buildSampleBookmarksHtml(now = Date.now()): string {
  let counter = 0;
  const total = LIBRARY.reduce(function count(sum: number, folder: SampleFolder): number {
    return sum + folder.links.length + (folder.folders ?? []).reduce(count, 0);
  }, 0);

  const renderFolder = (folder: SampleFolder, depth: number): string => {
    const pad = "    ".repeat(depth);
    const toolbar = folder.name === "Bookmarks bar" ? ' PERSONAL_TOOLBAR_FOLDER="true"' : "";
    const created = Math.floor(now / 1000) - 1200 * DAY;
    const lines = [`${pad}<DT><H3 ADD_DATE="${created}"${toolbar}>${escapeHtml(folder.name)}</H3>`, `${pad}<DL><p>`];
    for (const link of folder.links) {
      const added = dateFor(counter++, total, now);
      const tags = link.tags?.length ? ` TAGS="${escapeHtml(link.tags.join(","))}"` : "";
      lines.push(`${pad}    <DT><A HREF="${escapeHtml(link.url)}" ADD_DATE="${added}"${tags}>${escapeHtml(link.title)}</A>`);
      if (link.description) lines.push(`${pad}    <DD>${escapeHtml(link.description)}`);
    }
    for (const child of folder.folders ?? []) lines.push(renderFolder(child, depth + 1));
    lines.push(`${pad}</DL><p>`);
    return lines.join("\n");
  };

  return [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- A sample library for Bookmark Studio. -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
    ...LIBRARY.map((folder) => renderFolder(folder, 1)),
    "</DL><p>",
  ].join("\n");
}

/** The sample as a File, ready for the import pipeline. */
export function sampleBookmarksFile(): File {
  return new File([buildSampleBookmarksHtml()], "Sample library.html", { type: "text/html" });
}

export const SAMPLE_LINK_COUNT = LIBRARY.reduce(function count(sum: number, folder: SampleFolder): number {
  return sum + folder.links.length + (folder.folders ?? []).reduce(count, 0);
}, 0);
