import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadCompiledBots } from "@crawlytics/registry";

import { createDetector } from "../src/index.js";
import type { Classification } from "../src/index.js";

interface Fixture {
  ua: string;
  expected: Classification;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/ua-fixtures.json", import.meta.url), "utf8")
) as Fixture[];

const detector = createDetector(loadCompiledBots());

describe("classify: UA fixtures", () => {
  it.each(fixtures.map((fixture) => [fixture.ua === "" ? "<empty>" : fixture.ua.slice(0, 64), fixture] as const))(
    "%s",
    (_label, fixture) => {
      const result = detector.classify(fixture.ua);
      expect(result.actorType, `actorType for: ${fixture.ua}`).toBe(fixture.expected.actorType);
      if (fixture.expected.botId) {
        expect(result.botId, `botId for: ${fixture.ua}`).toBe(fixture.expected.botId);
      }
      if (fixture.expected.operator) {
        expect(result.operator, `operator for: ${fixture.ua}`).toBe(fixture.expected.operator);
      }
    }
  );
});

describe("classify: edge behaviour", () => {
  it("handles null and undefined as bot-grade traffic", () => {
    expect(detector.classify(null).actorType).toBe("other_bot");
    expect(detector.classify(undefined).actorType).toBe("other_bot");
  });

  it("memoizes results (LRU cache returns the same object)", () => {
    const local = createDetector(loadCompiledBots(), { cacheSize: 2 });
    const ua = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    expect(local.classify(ua)).toBe(local.classify(ua));
  });

  it("evicts oldest entries when the cache is full", () => {
    const local = createDetector(loadCompiledBots(), { cacheSize: 1 });
    const first = local.classify("curl/8.4.0");
    local.classify("Wget/1.21.3");
    // "curl" was evicted; a fresh object is produced, result stays correct.
    const again = local.classify("curl/8.4.0");
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });

  it("works with the cache disabled", () => {
    const local = createDetector(loadCompiledBots(), { cacheSize: 0 });
    expect(local.classify("curl/8.4.0").actorType).toBe("other_bot");
  });
});

describe("compiled registry quality gates", () => {
  it("has verification metadata (ip_source) for key verifiable bots", () => {
    const bots = loadCompiledBots();
    for (const id of [
      "gptbot",
      "oai-searchbot",
      "chatgpt-user",
      "claudebot",
      "claude-user",
      "perplexitybot",
      "perplexity-user",
      "googlebot",
      "bingbot",
      "applebot",
      "ccbot"
    ]) {
      const entry = bots.find((bot) => bot.bot_id === id);
      expect(entry?.ip_source, `${id} must carry ip_source`).toBeTruthy();
    }
  });

  it("never classifies declared ai.robots.txt bots as suspected_ai", () => {
    const bots = loadCompiledBots();
    expect(bots.filter((bot) => bot.actor_type === "suspected_ai")).toEqual([]);
  });
});
