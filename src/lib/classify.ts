/**
 * Rule-based categorisation and tag suggestion.
 *
 * The signal comes from three places, in descending order of trust:
 *   1. the domain (unambiguous — github.com is a repository, full stop)
 *   2. the folder the user already filed it under (they categorised it themselves)
 *   3. keywords in the title and description
 *
 * No model is involved. Rules are data, so they are easy to extend.
 */
import { getDomain, normalize, titleCase } from "./text";

export interface CategoryRule {
  category: string;
  /** Matched against the hostname, as an exact host or a suffix (".github.io"). */
  domains?: string[];
  /** Matched against the whole "title description folderpath" haystack. */
  keywords?: string[];
  /** Higher wins ties. */
  weight?: number;
}

export const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "AI Tool",
    domains: [
      "openai.com","chatgpt.com","anthropic.com","claude.ai","gemini.google.com",
      "perplexity.ai","midjourney.com","huggingface.co","runwayml.com","elevenlabs.io",
      "stability.ai","replicate.com","mistral.ai","cohere.com","poe.com","deepseek.com",
      "suno.com","luma-ai.com","lumalabs.ai","ideogram.ai","leonardo.ai","heygen.com",
      "synthesia.io","descript.com","krea.ai","pika.art","x.ai","groq.com","together.ai",
    ],
    keywords: ["ai tool","llm","chatbot","generative","text to image","text to video","ai assistant","prompt","gpt","diffusion","ai model","ai video","ai audio","ai image","ai compan","ai startup","hottest ai","ai agent","ai education","agent skills","model context protocol","ai research","ai lab"],
    weight: 3,
  },
  {
    category: "AI Coding",
    domains: ["cursor.com","cursor.sh","codeium.com","windsurf.com","cognition.ai","lovable.dev","bolt.new","v0.dev","replit.com","tabnine.com","sourcegraph.com","aider.chat","cline.bot","antigravity.google"],
    keywords: ["ai code","code assistant","vibecoding","vibe coding","ai ide","copilot","code generation","agentic coding"],
    weight: 4,
  },
  {
    category: "Repository",
    domains: ["github.com","gitlab.com","bitbucket.org","codeberg.org","sourceforge.net","npmjs.com","pypi.org","crates.io"],
    keywords: ["repository","open source","git repo"],
    weight: 4,
  },
  {
    category: "Documentation",
    domains: ["developer.mozilla.org","docs.python.org","readthedocs.io","devdocs.io","w3schools.com","stackoverflow.com","stackexchange.com","developer.chrome.com","web.dev","caniuse.com"],
    keywords: ["documentation","docs","api reference","getting started","changelog","reference guide"],
    weight: 3,
  },
  {
    category: "Component Library",
    domains: ["ui.shadcn.com","mui.com","chakra-ui.com","ant.design","radix-ui.com","headlessui.com","daisyui.com","flowbite.com","mantine.dev","primereact.org","nextui.org","heroui.com","tremor.so","aceternity.com","magicui.design","reactbits.dev","prompt-kit.com","motion-primitives.com","originui.com","hyperui.dev","tailwindui.com"],
    keywords: ["component library","ui kit","design system","ui components","react components","tailwind components","headless ui"],
    weight: 4,
  },
  {
    category: "Design Inspiration",
    domains: ["dribbble.com","behance.net","awwwards.com","siteinspire.com","land-book.com","mobbin.com","godly.website","curated.design","lapa.ninja","onepagelove.com","httpster.net","minimal.gallery","saaslandingpage.com","refero.design","screenlane.com","pageflows.com","are.na","cosmos.so","savee.it","designspiration.com","muzli.com"],
    keywords: ["inspiration","showcase","gallery","portfolio","award winning","web design examples","moodboard"],
    weight: 3,
  },
  {
    category: "Design Tool",
    domains: ["figma.com","framer.com","sketch.com","penpot.app","canva.com","spline.design","rive.app","lottiefiles.com","blender.org","webflow.com","protopie.io","principleformac.com"],
    keywords: ["design tool","prototyping","vector editor","no code builder","website builder","3d design"],
    weight: 3,
  },
  {
    category: "Typography",
    domains: ["fonts.google.com","fontshare.com","myfonts.com","typewolf.com","fontsinuse.com","befonts.com","dafont.com","typography.com","klim.co.nz","pangrampangram.com","fontsquirrel.com"],
    keywords: ["font","typeface","typography","type foundry","font pairing","lettering"],
    weight: 4,
  },
  {
    category: "Colour",
    domains: ["coolors.co","colorhunt.co","paletton.com","colormind.io","huemint.com","realtimecolors.com","uicolors.app","tailwindcolor.com","colorkit.co"],
    keywords: ["colour palette","color palette","color theory","colour theory","gradient","palette generator","color picker"],
    weight: 4,
  },
  {
    category: "Assets & Icons",
    domains: ["unsplash.com","pexels.com","freepik.com","flaticon.com","thenounproject.com","iconfinder.com","phosphoricons.com","lucide.dev","heroicons.com","fontawesome.com","undraw.co","storyset.com","blush.design","haikei.app","shapefactory.co","icons8.com","svgrepo.com"],
    keywords: ["icons","illustrations","stock photos","mockups","svg","assets","3d assets","textures"],
    weight: 4,
  },
  {
    category: "Automation",
    domains: ["zapier.com","make.com","n8n.io","ifttt.com","activepieces.com","pipedream.com","airtable.com","retool.com","bubble.io","axiom.ai","browse.ai","apify.com"],
    keywords: ["automation","workflow","no code","scraping","web scraping","integration","rpa","zap"],
    weight: 3,
  },
  {
    category: "Learning",
    domains: ["coursera.org","udemy.com","edx.org","khanacademy.org","freecodecamp.org","codecademy.com","pluralsight.com","datacamp.com","deeplearning.ai","fast.ai","brilliant.org","scrimba.com","frontendmasters.com","egghead.io","roadmap.sh"],
    keywords: ["course","tutorial","learn","curriculum","bootcamp","certification","lesson","syllabus","guide"],
    weight: 3,
  },
  {
    category: "Research",
    domains: ["arxiv.org","paperswithcode.com","semanticscholar.org","researchgate.net","nature.com","science.org","acm.org","ieee.org","ssrn.com","biorxiv.org","distill.pub","jstor.org","pubmed.ncbi.nlm.nih.gov"],
    keywords: ["paper","research","preprint","study","journal","dataset","benchmark","whitepaper"],
    weight: 4,
  },
  {
    category: "Video",
    domains: ["youtube.com","youtu.be","vimeo.com","twitch.tv","loom.com","ted.com","dailymotion.com"],
    keywords: ["video","watch","episode","webinar","talk","screencast"],
    weight: 3,
  },
  {
    category: "Social",
    domains: ["twitter.com","x.com","linkedin.com","instagram.com","facebook.com","reddit.com","threads.net","mastodon.social","bsky.app","discord.com","tiktok.com","pinterest.com","whatsapp.com","t.me","telegram.org"],
    keywords: ["profile","social network","community","forum","thread"],
    weight: 3,
  },
  {
    category: "News & Blogs",
    domains: ["techcrunch.com","wired.com","theverge.com","arstechnica.com","wsj.com","nytimes.com","bloomberg.com","reuters.com","economist.com","medium.com","substack.com","hackernews.com","news.ycombinator.com","theinformation.com","ft.com","businessinsider.com","forbes.com"],
    keywords: ["news","article","blog","newsletter","magazine","opinion","editorial"],
    weight: 2,
  },
  {
    category: "Finance & VC",
    domains: ["crunchbase.com","pitchbook.com","a16z.com","sequoiacap.com","ycombinator.com","angellist.com","wellfound.com","tracxn.com","cbinsights.com","zerodha.com","groww.in","screener.in","tradingview.com","moneycontrol.com","nseindia.com"],
    keywords: ["venture capital","investor","funding","valuation","startup funding","portfolio company","investment banking","equity","stock market","angel investor"],
    weight: 3,
  },
  {
    category: "Productivity",
    domains: ["notion.so","obsidian.md","todoist.com","things.app","linear.app","asana.com","trello.com","clickup.com","monday.com","slack.com","calendly.com","raycast.com","superhuman.com","height.app"],
    keywords: ["notes","task manager","project management","productivity","calendar","to do","knowledge base","second brain"],
    weight: 3,
  },
  {
    category: "Developer Tool",
    domains: ["vercel.com","netlify.com","railway.app","render.com","fly.io","supabase.com","firebase.google.com","planetscale.com","neon.tech","cloudflare.com","docker.com","postman.com","insomnia.rest","sentry.io","posthog.com","stripe.com","twilio.com","aws.amazon.com","cloud.google.com","azure.microsoft.com"],
    keywords: ["hosting","deploy","database","backend","api","serverless","devops","ci cd","sdk","cli","framework","library"],
    weight: 2,
  },
  {
    category: "Email & Cloud",
    domains: ["mail.google.com","gmail.com","outlook.com","mail.zoho.com","drive.google.com","dropbox.com","onedrive.live.com","icloud.com","docs.google.com","sheets.google.com","calendar.google.com"],
    keywords: ["inbox","mailbox","cloud storage","spreadsheet","my drive"],
    weight: 5,
  },
  {
    category: "Consulting",
    domains: ["mckinsey.com","bain.com","bcg.com","deloitte.com","accenture.com","pwc.com","kpmg.com","ey.com","mckinseyaccelerate.com"],
    keywords: ["consulting","management consulting","advisory","forward program"],
    weight: 4,
  },
  {
    category: "Science",
    domains: ["scipy.org","numpy.org","wolfram.com","wolframalpha.com","feynmanlectures.caltech.edu","physics.harvard.edu","caltech.edu","mit.edu","stanford.edu","berkeley.edu","colab.research.google.com","kaggle.com"],
    keywords: ["physics","chemistry","quantum","catalyst","catalysis","molecular","biology","mathematics","computational","thermodynamics","periodic table","equations","scientific"],
    weight: 3,
  },
  {
    category: "Interactive & Curiosity",
    domains: ["neal.fun","pudding.cool","ncase.me","tylervigen.com","atlasofemotions.org","xkcd.com","informationisbeautiful.net","observablehq.com"],
    keywords: ["interactive","explorable","visualisation","visualization","curiosity","experiment","playground","simulation"],
    weight: 3,
  },
  {
    category: "Legal",
    domains: ["harvey.ai","westlaw.com","lexisnexis.com","casetext.com","indiankanoon.org"],
    keywords: ["legal","law firm","contract","litigation","compliance","attorney","counsel"],
    weight: 4,
  },
  {
    category: "Entertainment",
    domains: ["netflix.com","primevideo.com","hotstar.com","disneyplus.com","spotify.com","soundcloud.com","imdb.com","letterboxd.com","crunchyroll.com"],
    keywords: ["movie","streaming","series","episode guide","music","playlist","anime"],
    weight: 3,
  },
  {
    category: "Shopping",
    domains: ["amazon.com","amazon.in","flipkart.com","ebay.com","etsy.com","aliexpress.com","myntra.com","shopify.com","gumroad.com"],
    keywords: ["buy","shop","price","cart","store","deal","product page"],
    weight: 3,
  },
];

/** Category shown when nothing matches. */
export const UNCATEGORISED = "Unsorted";

export const ALL_CATEGORIES = [
  ...new Set(CATEGORY_RULES.map((rule) => rule.category)),
  UNCATEGORISED,
].sort();

function domainMatches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

export interface ClassifyInput {
  url: string;
  title: string;
  description?: string;
  /** "Bookmarks bar / Design / Fonts" — the user's own filing is strong evidence. */
  folderPath?: string;
}

/**
 * Scores every rule and returns the best category.
 * Domain hits dominate; folder-name hits count more than title hits because the
 * user chose the folder deliberately.
 */
export function classify(input: ClassifyInput): string {
  const host = getDomain(input.url);
  const title = normalize(input.title);
  const description = normalize(input.description ?? "");
  const folderPath = normalize(input.folderPath ?? "");
  const haystack = `${title} ${description}`;

  let best = UNCATEGORISED;
  let bestScore = 0;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    const weight = rule.weight ?? 1;

    if (rule.domains?.some((pattern) => domainMatches(host, pattern))) {
      score += 10 * weight;
    }
    for (const keyword of rule.keywords ?? []) {
      if (folderPath.includes(keyword)) score += 3 * weight;
      if (haystack.includes(keyword)) score += 2 * weight;
    }

    if (score > bestScore) {
      bestScore = score;
      best = rule.category;
    }
  }

  if (bestScore > 0) return best;

  // No rule fired. Rather than dumping it in "Unsorted", fall back to the folder the
  // user filed it under: they already named the concept, and their words beat ours.
  // (Measured on a real 1241-bookmark library this cut "Unsorted" from 19% to under 1%.)
  const derived = categoryFromFolder(input.folderPath ?? "");
  return derived ?? UNCATEGORISED;
}

/** Generic containers that say nothing about meaning. */
const GENERIC_FOLDERS = new Set([
  "bookmarks bar","bookmarks","bookmark bar","other bookmarks","favorites","favourites",
  "unsorted","imported","toolbar","mobile bookmarks","new folder","misc","temp","links",
]);

/**
 * Turns "Bookmarks bar / Hottest AI Companies & Startups" into "Hottest AI Companies".
 * Only the leaf matters, generic containers are ignored, and the label is trimmed to a
 * few words so it reads as a category rather than a sentence.
 */
export function categoryFromFolder(folderPath: string): string | null {
  const segments = folderPath.split("/").map((segment) => segment.trim()).filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (GENERIC_FOLDERS.has(segment.toLowerCase())) continue;
    const words = segment
      // Drop parentheticals first, so "OCR (Optical Character Recognition)"
      // truncates to "OCR" rather than a dangling "OCR (Optical Character".
      .replace(/\([^)]*\)?/g, " ")
      .replace(/[&/]+/g, " ")
      .replace(/\s+/g, " ")
      .split(" ")
      .filter((word) => word && !["and","the","for","of","to","in","a"].includes(word.toLowerCase()));
    if (!words.length) continue;
    return titleCase(words.slice(0, 3).join(" "));
  }
  return null;
}

/**
 * The topics a tag may be suggested for.
 *
 * Tags used to be the strongest *words* of the title and folder, which on a real library
 * produced tags like `else`, `everything` and `stuff` from a folder called "Everything
 * Else & Stuff", and thousands of one-off words across a 1,300-bookmark import that made
 * the Tags list useless. A suggested tag now has to name a recognisable topic: each entry
 * is the tag, then the whole words or phrases that imply it.
 */
export const TOPIC_TAGS: ReadonlyArray<readonly [tag: string, phrases: readonly string[]]> = [
  ["ai", ["ai", "artificial intelligence", "llm", "llms", "gpt", "chatgpt", "claude", "gemini", "openai", "anthropic", "generative", "genai"]],
  ["agents", ["agent", "agents", "agentic", "mcp", "model context protocol"]],
  ["machine-learning", ["machine learning", "deep learning", "neural network", "neural networks", "pytorch", "tensorflow", "huggingface", "hugging face"]],
  ["prompting", ["prompt", "prompts", "prompt engineering"]],
  ["design", ["design", "designer", "designers", "ui", "ux", "ui/ux"]],
  ["inspiration", ["inspiration", "showcase", "moodboard", "gallery"]],
  ["typography", ["font", "fonts", "typeface", "typefaces", "typography"]],
  ["colour", ["color", "colour", "colors", "colours", "palette", "palettes", "gradient", "gradients"]],
  ["icons", ["icon", "icons", "illustration", "illustrations", "mockup", "mockups"]],
  ["animation", ["animation", "animations", "motion", "lottie"]],
  ["3d", ["3d", "three.js", "threejs", "webgl", "blender", "spline"]],
  ["figma", ["figma"]],
  ["framer", ["framer"]],
  ["frontend", ["frontend", "front-end", "css", "html", "tailwind", "web development", "webdev"]],
  ["react", ["react", "nextjs", "next.js"]],
  ["javascript", ["javascript", "typescript", "nodejs", "node.js", "npm"]],
  ["python", ["python", "django", "flask", "pandas", "jupyter", "numpy"]],
  ["components", ["component", "components", "ui kit", "ui kits", "design system", "design systems"]],
  ["developer-tools", ["devtools", "developer tools", "cli", "api", "apis", "sdk"]],
  ["open-source", ["github", "open source", "open-source", "repository"]],
  ["automation", ["automation", "automate", "workflow", "workflows", "zapier", "n8n", "scraping"]],
  ["no-code", ["no code", "no-code", "nocode", "low code", "low-code", "webflow", "bubble"]],
  ["data", ["dataset", "datasets", "analytics", "visualization", "visualisation", "sql", "database"]],
  ["research", ["research", "paper", "papers", "arxiv", "preprint"]],
  ["learning", ["course", "courses", "tutorial", "tutorials", "learn", "learning", "education", "lesson", "lessons"]],
  ["video", ["video", "videos", "youtube"]],
  ["audio", ["audio", "music", "podcast", "podcasts", "voice", "speech"]],
  ["images", ["image", "images", "photo", "photos", "photography"]],
  ["writing", ["writing", "blog", "blogs", "newsletter", "essay", "essays"]],
  ["marketing", ["marketing", "seo", "influencer", "branding", "advertising"]],
  ["social-media", ["social media", "instagram", "linkedin", "twitter", "tiktok"]],
  ["startups", ["startup", "startups", "founder", "founders", "y combinator"]],
  ["investing", ["venture capital", "vc", "investor", "investors", "angel investors", "investment", "investing"]],
  ["finance", ["finance", "financial", "banking", "accounting", "valuation", "stocks"]],
  ["legal", ["legal", "law", "lawyer", "lawyers"]],
  ["productivity", ["productivity", "notion", "todo"]],
  ["security", ["security", "privacy", "encryption", "passwords"]],
  ["career", ["career", "careers", "jobs", "resume", "hiring"]],
  ["ocr", ["ocr", "optical character recognition"]],
];

const TOPIC_TAG_NAMES = new Set(TOPIC_TAGS.map(([tag]) => tag));

/** Whether `tag` is one of the topic tags this module suggests. */
export function isTopicTag(tag: string): boolean {
  return TOPIC_TAG_NAMES.has(tag.toLowerCase());
}

/** Phrase -> tag, longest phrases first so "machine learning" beats "learning". */
const TOPIC_PHRASES: { words: string[]; tag: string }[] = TOPIC_TAGS.flatMap(([tag, phrases]) =>
  phrases.map((phrase) => ({ words: phrase.split(" "), tag })),
).sort((a, b) => b.words.length - a.words.length);

/** Lower-cased words, keeping the characters topic names use (`ui/ux`, `next.js`). */
function topicWords(value: string): string[] {
  return normalize(value)
    .replace(/[^a-z0-9+#./-]+/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[./-]+|[./-]+$/g, ""))
    .filter(Boolean);
}

/** Adds the topic tags `value` mentions to `into`, each weighted by `weight` per mention. */
export function topicsIn(value: string, into = new Map<string, number>(), weight = 1): Map<string, number> {
  const words = topicWords(value);
  if (!words.length) return into;
  const used = new Array<boolean>(words.length).fill(false);
  for (const { words: phrase, tag } of TOPIC_PHRASES) {
    for (let index = 0; index + phrase.length <= words.length; index += 1) {
      let match = true;
      for (let offset = 0; offset < phrase.length; offset += 1) {
        if (used[index + offset] || words[index + offset] !== phrase[offset]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      for (let offset = 0; offset < phrase.length; offset += 1) used[index + offset] = true;
      into.set(tag, (into.get(tag) ?? 0) + weight);
    }
  }
  return into;
}

/**
 * Suggests tags without a model: the recognisable topics named in the title, the
 * deepest folder the user picked, and the description.
 *
 * Returns nothing rather than noise when no topic is named: an untagged bookmark is
 * still found by its folder, title and site, while a meaningless tag clutters every list.
 */
export function suggestTags(input: ClassifyInput, limit = 3): string[] {
  const scores = new Map<string, number>();
  topicsIn(input.title, scores, 2);
  topicsIn(input.description ?? "", scores, 1);
  // Only the deepest folder; parents are usually generic ("Bookmarks bar").
  const leaf = (input.folderPath ?? "").split("/").pop() ?? "";
  topicsIn(leaf, scores, 3);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag);
}
