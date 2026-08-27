import { describe, expect, it } from "vitest";

import { loadCompiledBots } from "@crawlytics/registry";
import type { BotRegistryEntry } from "@crawlytics/registry";

import { buildLlmsTxt, buildRobotsTxt } from "../src/robots.js";

const BOTS: BotRegistryEntry[] = [
  { bot_id: "gptbot", operator: "openai", actor_type: "ai_training", ua_patterns: ["GPTBot", "GPTBot/"] },
  { bot_id: "claudebot", operator: "anthropic", actor_type: "ai_training", ua_patterns: ["ClaudeBot"] },
  { bot_id: "perplexitybot", operator: "perplexity", actor_type: "ai_search", ua_patterns: ["PerplexityBot"] },
  { bot_id: "chatgpt-user", operator: "openai", actor_type: "ai_fetcher", ua_patterns: ["ChatGPT-User"] },
  // no clean token (spaces) -> must be skipped, robots.txt needs a product token
  { bot_id: "brightbot", operator: "unknown", actor_type: "ai_training", ua_patterns: ["Brightbot 1.0"] },
  // domain-looking pattern -> not a product token, skipped
  { bot_id: "bigsur-ai", operator: "unknown", actor_type: "ai_fetcher", ua_patterns: ["bigsur.ai"] },
  // non-AI bots never appear in the AI policy file
  { bot_id: "googlebot", operator: "google", actor_type: "search_engine", ua_patterns: ["Googlebot"] }
];

const DEFAULT_POLICY = { training: "deny", search: "allow", fetch: "allow" } as const;

describe("buildRobotsTxt", () => {
  it("splits AI bots into blocked/allowed groups per policy, sorted and deduped", () => {
    const text = buildRobotsTxt(BOTS, DEFAULT_POLICY);

    // training bots blocked, alphabetical, one contiguous group
    expect(text).toContain("User-agent: ClaudeBot\nUser-agent: GPTBot\nDisallow: /");
    // search + fetch allowed, alphabetical, one contiguous group
    expect(text).toContain("User-agent: ChatGPT-User\nUser-agent: PerplexityBot\nAllow: /");
    // token appears exactly once despite two ua_patterns
    expect(text.match(/User-agent: GPTBot/g)).toHaveLength(1);
    // tokenless, domain-looking, and non-AI bots are excluded
    expect(text).not.toContain("Brightbot");
    expect(text).not.toContain("bigsur.ai");
    expect(text).not.toContain("Googlebot");
  });

  it("resolves cross-category duplicate tokens with deny-precedence", () => {
    const dupes: BotRegistryEntry[] = [
      { bot_id: "x-train", operator: "x", actor_type: "ai_training", ua_patterns: ["SameBot"] },
      { bot_id: "x-fetch", operator: "x", actor_type: "ai_fetcher", ua_patterns: ["SameBot"] }
    ];
    const text = buildRobotsTxt(dupes, DEFAULT_POLICY);
    // one group only: an Allow group must never coexist with a Disallow for the same token
    expect(text.match(/User-agent: SameBot/g)).toHaveLength(1);
    expect(text).toContain("User-agent: SameBot\nDisallow: /");
    expect(text).not.toContain("Allow: /");
  });

  it("skips versioned patterns but keeps the bare token", () => {
    const versioned: BotRegistryEntry[] = [
      { bot_id: "m", operator: "mistral", actor_type: "ai_fetcher", ua_patterns: ["MistralAI-User/1.0", "MistralAI-User"] }
    ];
    const text = buildRobotsTxt(versioned, DEFAULT_POLICY);
    expect(text).toContain("User-agent: MistralAI-User\n");
    expect(text).not.toContain("1.0");
  });

  it("can deny everything or allow everything", () => {
    const denyAll = buildRobotsTxt(BOTS, { training: "deny", search: "deny", fetch: "deny" });
    expect(denyAll).not.toContain("Allow: /");
    const allowAll = buildRobotsTxt(BOTS, { training: "allow", search: "allow", fetch: "allow" });
    expect(allowAll).not.toContain("Disallow: /");
  });

  it("is stable (same input -> identical output) and handles an empty registry", () => {
    const a = buildRobotsTxt(BOTS, DEFAULT_POLICY);
    const b = buildRobotsTxt(BOTS, DEFAULT_POLICY);
    expect(a).toBe(b);
    expect(buildRobotsTxt([], DEFAULT_POLICY)).toContain("# Crawlytics");
  });

  it("emits only clean product tokens for the real compiled registry", () => {
    const text = buildRobotsTxt(loadCompiledBots(), DEFAULT_POLICY);
    const tokens = [...text.matchAll(/^User-agent: (.+)$/gm)].map((match) => match[1] ?? "");
    expect(tokens.length).toBeGreaterThan(20);
    for (const token of tokens) {
      // letters/digits/_/- only — no spaces, dots, slashes or regex leftovers
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    // no token is listed twice (global dedup across categories)
    const lower = tokens.map((token) => token.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });
});

describe("buildLlmsTxt", () => {
  it("uses the site domain", () => {
    const text = buildLlmsTxt("example.com");
    expect(text.startsWith("# example.com")).toBe(true);
    expect(text).toContain("https://example.com/");
  });

  it("normalizes scheme/path noise in free-form domains", () => {
    const text = buildLlmsTxt("https://example.com/");
    expect(text).toContain("https://example.com/docs");
    expect(text).not.toContain("https://https://");
  });

  it("falls back to a placeholder when the domain is empty", () => {
    const text = buildLlmsTxt("  ");
    expect(text).toContain("your-domain");
  });
});
