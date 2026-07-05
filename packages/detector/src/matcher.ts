import type { BotRegistryEntry } from "@crawlytics/registry";

import type { Classification, Detector, DetectorOptions } from "./types.js";

const DEFAULT_CACHE_SIZE = 5000;

const REGEX_METACHARS = /[\\^$.*+?()[\]{}|]/;

/** UA substrings that look bot-ish but belong to real consumer devices. */
const FALSE_POSITIVE_UA = /cubot/i;

/**
 * Tokens too generic to be trusted as a specific-bot signal on their own.
 * They are only consulted after the specific stages, so e.g. "Googlebot"
 * never degrades to the weak "bot" token.
 */
const WEAK_TOKEN = /^(bot|spider|crawl|crawler|search|fetch|scan|archive|code|feed|java|ruby|perl)$/i;

/** Cheap catch-all signals for unidentified automation. */
const GENERIC_BOT_RE = new RegExp(
  [
    "\\bbot\\b",
    "bot[/;:,\\s)]",
    "bot$",
    "crawl",
    "spider",
    "scrap",
    "python",
    "aiohttp",
    "httpx",
    "curl/",
    "wget/",
    "libwww",
    "java/",
    "okhttp",
    "httpclient",
    "node-fetch",
    "axios/",
    "go-http-client",
    "headlesschrome",
    "phantomjs",
    "puppeteer",
    "playwright",
    "lighthouse",
    "feedparser",
    "feedfetcher",
    "monitoring",
    "uptime",
    "probe"
  ].join("|"),
  "i"
);

interface RegexChunk {
  combined: RegExp;
  members: Array<{ re: RegExp; entry: BotRegistryEntry }>;
}

export function createDetector(entries: BotRegistryEntry[], options: DetectorOptions = {}): Detector {
  const cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;

  const tokenMap = new Map<string, BotRegistryEntry>();
  const weakTokenMap = new Map<string, BotRegistryEntry>();
  const regexSources: Array<{ source: string; entry: BotRegistryEntry }> = [];

  for (const entry of entries) {
    for (const rawPattern of entry.ua_patterns) {
      // Upstream patterns escape slashes ("Googlebot\/"); unescape before
      // deciding whether the pattern is a plain token or a real regex.
      const pattern = rawPattern.replace(/\\\//g, "/").trim();
      if (!pattern) {
        continue;
      }
      if (REGEX_METACHARS.test(pattern)) {
        regexSources.push({ source: rawPattern, entry });
        continue;
      }
      const token = pattern.toLowerCase();
      if (token.length < 4 || WEAK_TOKEN.test(token)) {
        if (!weakTokenMap.has(token)) {
          weakTokenMap.set(token, entry);
        }
      } else if (!tokenMap.has(token)) {
        tokenMap.set(token, entry);
      }
    }
  }

  const tokenRegex = buildAlternation([...tokenMap.keys()]);
  const weakTokenRegex = buildAlternation([...weakTokenMap.keys()]);
  const regexChunks = buildRegexChunks(regexSources);
  const cache = new Map<string, Classification>();

  function classifyUncached(ua: string): Classification {
    // 1. Specific tokens — covers every curated AI bot and major crawler.
    const strongMatch = tokenRegex?.exec(ua);
    if (strongMatch?.[1]) {
      const entry = tokenMap.get(strongMatch[1].toLowerCase());
      if (entry) {
        return toClassification(entry);
      }
    }

    // 2. Upstream regex patterns (crawler-user-agents).
    for (const chunk of regexChunks) {
      if (chunk.combined.test(ua)) {
        for (const member of chunk.members) {
          if (member.re.test(ua)) {
            return toClassification(member.entry);
          }
        }
      }
    }

    // 3. Consumer devices that merely look bot-ish (e.g. CUBOT phones).
    if (FALSE_POSITIVE_UA.test(ua)) {
      return { actorType: "human" };
    }

    // 4. Weak tokens and generic automation signals.
    const weakMatch = weakTokenRegex?.exec(ua);
    if (weakMatch?.[1]) {
      const entry = weakTokenMap.get(weakMatch[1].toLowerCase());
      if (entry) {
        return toClassification(entry);
      }
    }
    if (GENERIC_BOT_RE.test(ua)) {
      return { actorType: "other_bot" };
    }

    return { actorType: "human" };
  }

  function classify(userAgent: string | null | undefined): Classification {
    if (userAgent == null) {
      return { actorType: "other_bot" };
    }
    const ua = userAgent.trim();
    if (ua === "" || ua === "-") {
      return { actorType: "other_bot" };
    }

    if (cacheSize > 0) {
      const cached = cache.get(ua);
      if (cached) {
        // refresh LRU recency
        cache.delete(ua);
        cache.set(ua, cached);
        return cached;
      }
    }

    const result = classifyUncached(ua);

    if (cacheSize > 0) {
      if (cache.size >= cacheSize) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      cache.set(ua, result);
    }

    return result;
  }

  return { classify };
}

function toClassification(entry: BotRegistryEntry): Classification {
  const classification: Classification = { actorType: entry.actor_type };
  if (entry.bot_id) {
    classification.botId = entry.bot_id;
  }
  if (entry.operator && entry.operator !== "unknown") {
    classification.operator = entry.operator;
  }
  return classification;
}

function buildAlternation(tokens: string[]): RegExp | null {
  if (tokens.length === 0) {
    return null;
  }
  // Longest first so "applebot-extended" wins over "applebot" at the same position.
  const escaped = tokens.sort((a, b) => b.length - a.length).map(escapeRegex);
  return new RegExp(`(${escaped.join("|")})`, "i");
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Combines upstream regex patterns into OR-chunks so a miss costs a handful of
 * regex executions instead of hundreds. Patterns with capture groups are kept
 * standalone (combining would renumber backreferences); invalid patterns are
 * skipped.
 */
function buildRegexChunks(
  items: Array<{ source: string; entry: BotRegistryEntry }>,
  chunkSize = 50
): RegexChunk[] {
  const combinable: Array<{ source: string; re: RegExp; entry: BotRegistryEntry }> = [];
  const standalone: RegexChunk[] = [];

  for (const item of items) {
    let re: RegExp;
    try {
      re = new RegExp(item.source);
    } catch {
      continue; // invalid upstream pattern
    }
    if (/\((?!\?)/.test(item.source)) {
      standalone.push({ combined: re, members: [{ re, entry: item.entry }] });
    } else {
      combinable.push({ source: item.source, re, entry: item.entry });
    }
  }

  const chunks: RegexChunk[] = [];
  for (let i = 0; i < combinable.length; i += chunkSize) {
    const slice = combinable.slice(i, i + chunkSize);
    try {
      const combined = new RegExp(slice.map((member) => `(?:${member.source})`).join("|"));
      chunks.push({
        combined,
        members: slice.map(({ re, entry }) => ({ re, entry }))
      });
    } catch {
      for (const member of slice) {
        chunks.push({ combined: member.re, members: [{ re: member.re, entry: member.entry }] });
      }
    }
  }

  return [...chunks, ...standalone];
}
