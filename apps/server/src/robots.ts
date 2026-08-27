/** Generators for the suggested robots.txt / llms.txt (Setup tab).
 * Pure functions — deterministic output, no I/O — so they are trivially testable
 * and the suggestion never depends on server state. */

import type { BotRegistryEntry } from "@crawlytics/registry";

export type BotPolicy = "allow" | "deny";

export interface RobotsPolicy {
  /** ai_training bots (GPTBot, ClaudeBot, CCBot, ...) — default deny. */
  training: BotPolicy;
  /** ai_search bots (PerplexityBot, OAI-SearchBot, ...) — default allow. */
  search: BotPolicy;
  /** ai_fetcher bots (ChatGPT-User, Claude-User, ...) — default allow. */
  fetch: BotPolicy;
}

const CATEGORY_KEYS: Record<string, keyof RobotsPolicy> = {
  ai_training: "training",
  ai_search: "search",
  ai_fetcher: "fetch"
};

// robots.txt product tokens: letters/digits/_/-. RFC 9309 formally allows only
// letters/_/- , but digit tokens like "AI2Bot" are shipped by the reference
// ai.robots.txt list and matched fine by Google's REP parser — dropping them
// would silently stop blocking real training bots. Dots are rejected: those are
// domain-looking patterns ("bigsur.ai"), not addressable product tokens.
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

function robotsToken(entry: BotRegistryEntry): string | null {
  for (const pattern of entry.ua_patterns) {
    const candidate = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
    if (TOKEN_RE.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

const asciiCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Builds a suggested robots.txt. Tokens are deduped globally: when the same
 * product token shows up in several AI categories, deny wins — RFC 9309 merges
 * groups with the same token, and an accidental Allow must never defeat an
 * explicit block. */
export function buildRobotsTxt(bots: BotRegistryEntry[], policy: RobotsPolicy): string {
  // token (lowercased) -> { display, denied }
  const tokens = new Map<string, { display: string; denied: boolean }>();
  for (const entry of bots) {
    const categoryKey = CATEGORY_KEYS[entry.actor_type];
    if (categoryKey === undefined) {
      continue;
    }
    const token = robotsToken(entry);
    if (token === null) {
      continue;
    }
    const denied = policy[categoryKey] === "deny";
    const existing = tokens.get(token.toLowerCase());
    if (existing === undefined) {
      tokens.set(token.toLowerCase(), { display: token, denied });
    } else if (denied && !existing.denied) {
      existing.denied = true; // deny-precedence on cross-category duplicates
    }
  }

  const blocked = [...tokens.values()].filter((entry) => entry.denied).map((entry) => entry.display);
  const allowed = [...tokens.values()].filter((entry) => !entry.denied).map((entry) => entry.display);
  blocked.sort(asciiCompare);
  allowed.sort(asciiCompare);

  const lines: string[] = [
    "# Crawlytics — suggested AI crawler policy",
    "# Blocks/allows are per category; adjust to taste and serve at /robots.txt",
    ""
  ];
  if (blocked.length > 0) {
    lines.push("# Blocked AI crawlers");
    for (const token of blocked) {
      lines.push(`User-agent: ${token}`);
    }
    lines.push("Disallow: /", "");
  }
  if (allowed.length > 0) {
    lines.push("# Allowed AI crawlers (search & citation bots that bring humans back)");
    for (const token of allowed) {
      lines.push(`User-agent: ${token}`);
    }
    lines.push("Allow: /", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Normalizes a free-form Site.domain ("https://example.com/", "example.com",
 * "user:pass@example.com/x?q=1") down to a bare host, so templated links never
 * double the scheme or leak credentials/query noise. */
function normalizeHost(domain: string): string {
  const trimmed = domain.trim();
  if (trimmed === "") {
    return "your-domain";
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.host === "" ? "your-domain" : url.host;
  } catch {
    return "your-domain";
  }
}

/** Builds an llms.txt skeleton (https://llmstxt.org) for the site to fill in. */
export function buildLlmsTxt(domain: string): string {
  const host = normalizeHost(domain);
  return [
    `# ${host}`,
    "",
    "> One-sentence description of what this site is, for AI assistants.",
    "",
    "## Key pages",
    "",
    `- [Home](https://${host}/): what the site does`,
    `- [Docs](https://${host}/docs): how to use it`,
    `- [Pricing](https://${host}/pricing): plans and pricing`,
    "",
    "## Optional",
    "",
    `- [Changelog](https://${host}/changelog): recent updates`,
    ""
  ].join("\n");
}
