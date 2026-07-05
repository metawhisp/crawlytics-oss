export type AiReferralSource =
  | "chatgpt"
  | "perplexity"
  | "gemini"
  | "claude"
  | "copilot"
  | "deepseek"
  | "grok"
  | "meta"
  | "you"
  | "mistral";

interface ReferrerRule {
  source: AiReferralSource;
  host: RegExp;
  path?: RegExp;
}

const REFERRER_RULES: ReferrerRule[] = [
  { source: "chatgpt", host: /(^|\.)chatgpt\.com$/ },
  { source: "chatgpt", host: /^chat\.openai\.com$/ },
  { source: "perplexity", host: /(^|\.)perplexity\.ai$/ },
  { source: "gemini", host: /^(gemini|bard)\.google\.com$/ },
  { source: "claude", host: /(^|\.)claude\.ai$/ },
  { source: "copilot", host: /^copilot\.microsoft\.com$/ },
  { source: "copilot", host: /(^|\.)bing\.com$/, path: /^\/chat/i },
  { source: "deepseek", host: /(^|\.)deepseek\.com$/ },
  { source: "grok", host: /(^|\.)grok\.com$/ },
  { source: "meta", host: /^(www\.)?meta\.ai$/ },
  { source: "you", host: /^(www\.)?you\.com$/ },
  { source: "mistral", host: /^chat\.mistral\.ai$/ }
];

/**
 * utm_source values used by AI assistants when the referrer is stripped.
 * ChatGPT appends utm_source=chatgpt.com to cited links since mid-2025.
 */
const UTM_SOURCES = new Map<string, AiReferralSource>([
  ["chatgpt.com", "chatgpt"],
  ["chatgpt", "chatgpt"],
  ["chat.openai.com", "chatgpt"],
  ["perplexity", "perplexity"],
  ["perplexity.ai", "perplexity"],
  ["gemini", "gemini"],
  ["claude", "claude"],
  ["claude.ai", "claude"],
  ["copilot", "copilot"],
  ["deepseek", "deepseek"],
  ["grok", "grok"],
  ["meta.ai", "meta"],
  ["you.com", "you"],
  ["mistral", "mistral"]
]);

/**
 * Classifies human traffic referred by an AI assistant.
 *
 * @param referer  Referer header value (may be a bare hostname).
 * @param queryString  Landing-page query string, used as a fallback when the
 *   referrer is stripped (mobile apps, in-app browsers). Leading "?" optional.
 */
export function classifyReferral(
  referer?: string | null,
  queryString?: string | null
): AiReferralSource | null {
  return classifyByReferer(referer) ?? classifyByQuery(queryString);
}

function classifyByReferer(referer: string | null | undefined): AiReferralSource | null {
  if (!referer) {
    return null;
  }

  const url = parseUrl(referer.trim());
  if (!url) {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  const host = url.hostname.toLowerCase();
  for (const rule of REFERRER_RULES) {
    if (rule.host.test(host) && (!rule.path || rule.path.test(url.pathname))) {
      return rule.source;
    }
  }
  return null;
}

function classifyByQuery(queryString: string | null | undefined): AiReferralSource | null {
  if (!queryString) {
    return null;
  }
  const normalized = queryString.startsWith("?") ? queryString.slice(1) : queryString;
  const utmSource = new URLSearchParams(normalized).get("utm_source");
  if (!utmSource) {
    return null;
  }
  return UTM_SOURCES.get(utmSource.toLowerCase()) ?? null;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    // bare hostnames like "chatgpt.com"
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(value)) {
      try {
        return new URL(`https://${value}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}
