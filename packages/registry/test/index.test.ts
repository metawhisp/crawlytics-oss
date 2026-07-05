import { describe, expect, it } from "vitest";

import { compileRegistry, normalizeBotId } from "../src/index.js";

describe("@crawlytics/registry", () => {
  it("normalizes bot ids", () => {
    expect(normalizeBotId("OAI-SearchBot")).toBe("oai-searchbot");
    expect(normalizeBotId("ChatGPT-User/1.0")).toBe("chatgpt-user-1-0");
  });

  it("maps known AI bots to the product taxonomy", () => {
    const compiled = compileRegistry({
      aiRobots: {
        GPTBot: {
          operator: "OpenAI",
          function: "No information provided."
        },
        "Claude-SearchBot": {
          operator: "Anthropic",
          function: "AI Search Crawlers"
        },
        "ChatGPT-User": {
          operator: "OpenAI",
          function: "AI Assistants"
        }
      },
      crawlerUserAgents: []
    });

    expect(compiled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bot_id: "gptbot", operator: "openai", actor_type: "ai_training" }),
        expect.objectContaining({
          bot_id: "claude-searchbot",
          operator: "anthropic",
          actor_type: "ai_search"
        }),
        expect.objectContaining({ bot_id: "chatgpt-user", operator: "openai", actor_type: "ai_fetcher" })
      ])
    );
  });

  it("lets custom overlay values win while keeping upstream patterns", () => {
    const compiled = compileRegistry({
      aiRobots: {
        GPTBot: {
          operator: "Wrong",
          function: "Unknown"
        }
      },
      crawlerUserAgents: [],
      customBots: [
        {
          bot_id: "GPTBot",
          operator: "openai",
          actor_type: "ai_training",
          ua_patterns: ["GPTBot/"]
        }
      ]
    });

    expect(compiled).toEqual([
      {
        bot_id: "gptbot",
        operator: "openai",
        actor_type: "ai_training",
        ua_patterns: ["GPTBot/", "GPTBot"]
      }
    ]);
  });
});
