import { describe, expect, it } from "vitest";

import { compileRegistry } from "../src/index.js";

describe("compileRegistry source priority", () => {
  it("ai.robots.txt beats crawler-user-agents regardless of merge order (Diffbot case)", () => {
    const compiled = compileRegistry({
      aiRobots: {
        Diffbot: {
          operator: "[Diffbot](https://www.diffbot.com/)",
          function: "Scrapes data to train LLMs"
        }
      },
      crawlerUserAgents: [
        {
          pattern: "Diffbot",
          url: "https://www.diffbot.com/",
          tags: ["seo"]
        }
      ]
    });

    const diffbot = compiled.find((bot) => bot.bot_id === "diffbot");
    expect(diffbot?.actor_type).toBe("ai_training");
    // patterns from both sources survive the merge
    expect(diffbot?.ua_patterns).toContain("Diffbot");
  });

  it("custom overlay beats both upstream sources", () => {
    const compiled = compileRegistry({
      aiRobots: {
        SomeBot: { operator: "X", function: "AI Search Crawlers" }
      },
      crawlerUserAgents: [{ pattern: "SomeBot" }],
      customBots: [
        {
          bot_id: "somebot",
          operator: "acme",
          actor_type: "monitoring",
          ua_patterns: ["SomeBot/2"]
        }
      ]
    });

    const bot = compiled.find((entry) => entry.bot_id === "somebot");
    expect(bot?.actor_type).toBe("monitoring");
    expect(bot?.operator).toBe("acme");
    expect(bot?.ua_patterns).toEqual(expect.arrayContaining(["SomeBot", "SomeBot/2"]));
  });
});
