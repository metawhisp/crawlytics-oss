import { loadCompiledBots } from "@crawlytics/registry";
import { describe, expect, it } from "vitest";

import { createDetector } from "../src/index.js";

// On the shipped registry, not a fixture: these entries come from the upstream
// crawler list, where "Spider" and "Code" are entries in their own right with a
// definite actor_type and operator "unknown". Reaching them through the weak
// stage turned a generic English word into "this is an AI crawler", and AI hits
// is the headline number of this product.
const detector = createDetector(loadCompiledBots());

describe("a generic word is not evidence of AI", () => {
  const GENERIC = [
    "Spider/1.0",
    "Mozilla/5.0 (compatible; Spider)",
    "Mozilla/5.0 (X11; Linux) Spider",
    "MyCompany Code/2.1 (internal tool)"
  ];

  for (const ua of GENERIC) {
    it(`does not file "${ua.slice(0, 32)}" under ai_*`, () => {
      const result = detector.classify(ua);
      expect(result.actorType).not.toMatch(/^ai_/);
      // Still a bot — the word did tell us that much.
      expect(result.actorType).toBe("other_bot");
    });
  }

  it("still names the bots whose short token is a real name, not a word", () => {
    // ds9, lcc, yak, bw/, y!j reach the same stage and are product names. The
    // rule is about generic words, not about short ones.
    expect(detector.classify("Mozilla/5.0 (compatible; YaK/1.0)").actorType).toBe("seo_tool");
  });

  it("and the real crawlers whose names merely contain those words are untouched", () => {
    expect(detector.classify("Mozilla/5.0 (compatible; Baiduspider/2.0)").botId).toBe("baiduspider");
    expect(detector.classify("Mozilla/5.0 (compatible; YisouSpider/5.0)").actorType).toBe("search_engine");
  });
});
