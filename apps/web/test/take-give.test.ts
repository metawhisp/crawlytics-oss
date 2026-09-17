import { describe, expect, it } from "vitest";

import { classifyVendors, perVisitorText } from "../src/takeGive.js";

// Measured on three months of real traffic across two live sites before this
// module existed. The panel's old scale was: taker < 0.01, low < 0.1, sender
// above. The observed range was 0.0028 to 0.023 — so "sender" was unreachable,
// the single best vendor on each site was labelled "low", and Perplexity came
// out "taker" on one site and "low" on the other because the 0.01 line runs
// through the middle of what actually happens. A scale whose good end never
// occurs is not a scale.
const SITE_A = [
  { vendor: "meta", crawls: 10936, clicks: 0, ratio: 0, hasAssistant: true },
  { vendor: "amazon", crawls: 9838, clicks: 0, ratio: 0, hasAssistant: false },
  { vendor: "openai", crawls: 4787, clicks: 110, ratio: 110 / 4787, hasAssistant: true },
  { vendor: "anthropic", crawls: 4500, clicks: 0, ratio: 0, hasAssistant: true },
  { vendor: "perplexity", crawls: 3331, clicks: 13, ratio: 13 / 3331, hasAssistant: true },
  { vendor: "google", crawls: 162, clicks: 0, ratio: 0, hasAssistant: true },
  { vendor: "mistral", crawls: 10, clicks: 0, ratio: 0, hasAssistant: true }
];

function verdictOf(rows: typeof SITE_A, vendor: string) {
  return classifyVendors(rows).find((r) => r.vendor === vendor)?.verdict.kind;
}

describe("what the panel says about a vendor", () => {
  it("names a vendor that cannot ever send anyone for what it is", () => {
    // Amazon has no consumer assistant that cites the open web. Zero clicks is
    // not a disappointment, it is the design — and it is the clearest case the
    // owner has: a quarter of the crawl budget that can only ever cost.
    // The old panel called this "no assistant" in a neutral grey badge.
    expect(verdictOf(SITE_A, "amazon")).toBe("only-takes");
  });

  it("separates 'could have sent someone and did not' from that", () => {
    // Anthropic has Claude, crawled 4500 times, sent nobody in three months.
    // That is the damning number and it must not look like Amazon's.
    expect(verdictOf(SITE_A, "anthropic")).toBe("sent-nobody");
    expect(verdictOf(SITE_A, "meta")).toBe("sent-nobody");
  });

  it("does not convict a vendor on too little traffic to judge", () => {
    // I first wrote this expecting Google's 162 crawls to be "too little", and
    // the arithmetic disagreed: at this site's best rate — one visitor per 44
    // crawls — zero visitors out of 162 has a 2.3% chance, so silence there IS
    // evidence. The line falls at 30 crawls, where zero is still the more
    // likely outcome even for a vendor as good as the best one. Mistral's ten
    // crawls are below it; Google's are not. The expectation moved to match the
    // measurement, not the other way round.
    expect(verdictOf(SITE_A, "mistral")).toBe("not-enough");
    expect(verdictOf(SITE_A, "google")).toBe("sent-nobody");
  });

  it("says a vendor sends people when it sends people, best one included", () => {
    // OpenAI brought 110 of this site's 123 human arrivals. The old panel
    // labelled it "low", the same word it would use for a failing vendor.
    expect(verdictOf(SITE_A, "openai")).toBe("sends");
    expect(verdictOf(SITE_A, "perplexity")).toBe("sends");
  });

  it("gives the same vendor the same verdict on a site with different volumes", () => {
    // Perplexity: 0.0039 on one site, 0.0203 on the other. The old thresholds
    // put those on opposite sides of a line and called one of them a taker.
    const siteB = [
      { vendor: "openai", crawls: 10537, clicks: 120, ratio: 120 / 10537, hasAssistant: true },
      { vendor: "perplexity", crawls: 1328, clicks: 27, ratio: 27 / 1328, hasAssistant: true }
    ];
    expect(verdictOf(SITE_A, "perplexity")).toBe(verdictOf(siteB, "perplexity"));
  });

  it("a vendor that sends people without crawling at all is not a mystery", () => {
    // Copilot on the second site: 0 crawls, 20 clicks. Microsoft indexes with
    // bingbot, which is a search engine, not an AI crawler.
    const rows = [{ vendor: "copilot", crawls: 0, clicks: 20, ratio: null, hasAssistant: true }];
    expect(classifyVendors(rows)[0]?.verdict.kind).toBe("sends-without-crawling");
  });

  it("states the rate in people, not in thousandths", () => {
    // "0.0039" is not a number anybody can act on.
    expect(perVisitorText(110 / 4787)).toBe("1 in 44");
    expect(perVisitorText(13 / 3331)).toBe("1 in 256");
  });
});
