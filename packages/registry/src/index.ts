import { readFileSync } from "node:fs";

export type ActorType =
  | "human"
  | "ai_training"
  | "ai_search"
  | "ai_fetcher"
  | "search_engine"
  | "seo_tool"
  | "social"
  | "monitoring"
  | "other_bot"
  | "suspected_ai";

export interface BotRegistryEntry {
  bot_id: string;
  operator: string;
  actor_type: ActorType;
  ua_patterns: string[];
  ip_source?: string;
  rdns_suffixes?: string[];
  docs_url?: string;
}

export interface AiRobotsEntry {
  operator?: string;
  function?: string;
  description?: string;
}

export interface CrawlerUserAgentEntry {
  pattern: string;
  url?: string;
  description?: string;
  tags?: string[];
}

export interface CustomBotsDocument {
  bots?: BotRegistryEntry[];
}

export interface CompileRegistryInput {
  aiRobots: Record<string, AiRobotsEntry>;
  crawlerUserAgents: CrawlerUserAgentEntry[];
  customBots?: BotRegistryEntry[];
}

const knownBotTaxonomy = new Map<string, Pick<BotRegistryEntry, "operator" | "actor_type">>([
  ["gptbot", { operator: "openai", actor_type: "ai_training" }],
  ["claudebot", { operator: "anthropic", actor_type: "ai_training" }],
  ["ccbot", { operator: "common-crawl", actor_type: "ai_training" }],
  ["bytespider", { operator: "bytedance", actor_type: "ai_training" }],
  ["meta-externalagent", { operator: "meta", actor_type: "ai_training" }],
  ["amazonbot", { operator: "amazon", actor_type: "ai_training" }],
  ["google-extended", { operator: "google", actor_type: "ai_training" }],
  ["oai-searchbot", { operator: "openai", actor_type: "ai_search" }],
  ["perplexitybot", { operator: "perplexity", actor_type: "ai_search" }],
  ["claude-searchbot", { operator: "anthropic", actor_type: "ai_search" }],
  ["duckassistbot", { operator: "duckduckgo", actor_type: "ai_search" }],
  ["chatgpt-user", { operator: "openai", actor_type: "ai_fetcher" }],
  ["claude-user", { operator: "anthropic", actor_type: "ai_fetcher" }],
  ["perplexity-user", { operator: "perplexity", actor_type: "ai_fetcher" }],
  ["mistralai-user", { operator: "mistral", actor_type: "ai_fetcher" }],
  ["google-notebooklm", { operator: "google", actor_type: "ai_fetcher" }]
]);

/** Source precedence: custom overlay > ai.robots.txt > crawler-user-agents. */
const SOURCE_RANK = {
  crawlerUserAgents: 1,
  aiRobots: 2,
  custom: 3
} as const;

export function compileRegistry(input: CompileRegistryInput): BotRegistryEntry[] {
  const merged = new Map<string, BotRegistryEntry>();
  const ranks = new Map<string, number>();

  for (const entry of fromAiRobots(input.aiRobots)) {
    upsertEntry(merged, ranks, entry, SOURCE_RANK.aiRobots);
  }

  for (const entry of fromCrawlerUserAgents(input.crawlerUserAgents)) {
    upsertEntry(merged, ranks, entry, SOURCE_RANK.crawlerUserAgents);
  }

  for (const entry of input.customBots ?? []) {
    upsertEntry(merged, ranks, normalizeEntry(entry), SOURCE_RANK.custom);
  }

  return [...merged.values()].sort((left, right) => left.bot_id.localeCompare(right.bot_id));
}

export function fromAiRobots(source: Record<string, AiRobotsEntry>): BotRegistryEntry[] {
  return Object.entries(source).map(([name, entry]) => {
    const botId = normalizeBotId(name);
    const known = knownBotTaxonomy.get(botId);
    const botEntry: BotRegistryEntry = {
      bot_id: botId,
      operator: known?.operator ?? normalizeOperator(entry.operator),
      actor_type: known?.actor_type ?? actorTypeFromAiFunction(entry.function),
      ua_patterns: [name]
    };

    const docsUrl = extractMarkdownUrl(entry.operator);
    if (docsUrl) {
      botEntry.docs_url = docsUrl;
    }

    return normalizeEntry(botEntry);
  });
}

export function fromCrawlerUserAgents(source: CrawlerUserAgentEntry[]): BotRegistryEntry[] {
  return source.map((entry) => {
    const botId = normalizeBotId(patternToBotId(entry.pattern));
    const known = knownBotTaxonomy.get(botId);
    const botEntry: BotRegistryEntry = {
      bot_id: botId,
      operator: known?.operator ?? operatorFromUrl(entry.url),
      actor_type: known?.actor_type ?? actorTypeFromCrawlerTags(entry.tags),
      ua_patterns: [entry.pattern]
    };

    if (entry.url) {
      botEntry.docs_url = entry.url;
    }

    return normalizeEntry(botEntry);
  });
}

export function normalizeBotId(value: string): string {
  return value
    .trim()
    .replace(/\\\//g, "/")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function upsertEntry(
  registry: Map<string, BotRegistryEntry>,
  ranks: Map<string, number>,
  next: BotRegistryEntry,
  nextRank: number
): void {
  const current = registry.get(next.bot_id);
  if (!current) {
    registry.set(next.bot_id, next);
    ranks.set(next.bot_id, nextRank);
    return;
  }

  // The higher-ranked source wins conflicting fields; the loser only fills
  // gaps. Patterns and rDNS suffixes are unioned from both sources.
  const currentRank = ranks.get(next.bot_id) ?? 0;
  const winner = nextRank >= currentRank ? next : current;
  const loser = winner === next ? current : next;

  const merged: BotRegistryEntry = {
    ...loser,
    ...winner,
    ua_patterns: uniqueStrings([...winner.ua_patterns, ...loser.ua_patterns])
  };

  const rdnsSuffixes = uniqueStrings([...(current.rdns_suffixes ?? []), ...(next.rdns_suffixes ?? [])]);
  if (rdnsSuffixes.length > 0) {
    merged.rdns_suffixes = rdnsSuffixes;
  }

  registry.set(next.bot_id, merged);
  ranks.set(next.bot_id, Math.max(currentRank, nextRank));
}

function normalizeEntry(entry: BotRegistryEntry): BotRegistryEntry {
  const normalized: BotRegistryEntry = {
    bot_id: normalizeBotId(entry.bot_id),
    operator: normalizeOperator(entry.operator),
    actor_type: entry.actor_type,
    ua_patterns: uniqueStrings(entry.ua_patterns.map((pattern) => pattern.trim()).filter(Boolean))
  };

  if (entry.ip_source) {
    normalized.ip_source = entry.ip_source;
  }
  if (entry.docs_url) {
    normalized.docs_url = entry.docs_url;
  }

  const rdnsSuffixes = uniqueStrings(entry.rdns_suffixes ?? []);
  if (rdnsSuffixes.length > 0) {
    normalized.rdns_suffixes = rdnsSuffixes;
  }

  return normalized;
}

function actorTypeFromAiFunction(value: string | undefined): ActorType {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("search")) {
    return "ai_search";
  }
  if (normalized.includes("assistant") || normalized.includes("agent") || normalized.includes("fetch")) {
    return "ai_fetcher";
  }
  if (
    normalized.includes("train") ||
    normalized.includes("language model") ||
    normalized.includes("data scraper") ||
    normalized.includes("scrapes data")
  ) {
    return "ai_training";
  }
  // Entries from ai.robots.txt are *declared* AI crawlers; when the purpose is
  // unknown, the dominant case in that list is training-data collection.
  // "suspected_ai" is reserved for stealth-bot heuristics, not declared bots.
  return "ai_training";
}

function actorTypeFromCrawlerTags(tags: string[] | undefined): ActorType {
  const normalized = new Set((tags ?? []).map((tag) => tag.toLowerCase()));
  if (normalized.has("search-engine")) {
    return "search_engine";
  }
  if (normalized.has("monitoring")) {
    return "monitoring";
  }
  if (normalized.has("social")) {
    return "social";
  }
  if (normalized.has("seo") || normalized.has("seo-tool")) {
    return "seo_tool";
  }
  return "other_bot";
}

function patternToBotId(pattern: string): string {
  return pattern
    .replace(/\\[/.^$*+?()[\]{}|]/g, "")
    .replace(/\(\?:.*$/, "")
    .replace(/\(\[\^.*$/, "")
    .replace(/\(\.\*\)$/, "")
    .replace(/\/$/, "");
}

function normalizeOperator(value: string | undefined): string {
  const cleaned = stripMarkdown(value ?? "").trim();
  if (!cleaned || cleaned.toLowerCase().includes("unclear")) {
    return "unknown";
  }
  return cleaned
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function operatorFromUrl(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }

  try {
    const hostname = new URL(value).hostname.replace(/^www\./, "");
    return normalizeOperator(hostname.split(".").at(-2));
  } catch {
    return "unknown";
  }
}

function stripMarkdown(value: string): string {
  return value.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
}

function extractMarkdownUrl(value: string | undefined): string | undefined {
  return value?.match(/\[[^\]]+]\(([^)]+)\)/)?.[1];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Loads the committed compiled registry snapshot (bots.compiled.json at the
 * package root). Works both from src/ (vitest) and dist/ (built output).
 */
export function loadCompiledBots(): BotRegistryEntry[] {
  const url = new URL("../bots.compiled.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as BotRegistryEntry[];
}
