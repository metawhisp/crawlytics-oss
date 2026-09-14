import { describe, expect, it } from "vitest";

import { loadCompiledBots } from "@crawlytics/registry";
import type { RawLogEvent } from "@crawlytics/shared";

import { createAsnLookup } from "../src/pipeline/asn-lookup.js";
import { createEnricher } from "../src/pipeline/enrich.js";

/** Two ranges from the real dump, enough to prove lookup and non-overwrite. */
const NETWORK = createAsnLookup(
  ["8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE", "203.0.113.0\t203.0.113.255\t64496\tDE\tEXAMPLE-HOST"].join("\n")
);

const fakeVerifier = {
  verify: (botId: string, ip: string) =>
    Promise.resolve(botId === "gptbot" && ip.startsWith("52.230.") ? ("verified" as const) : ("spoofed" as const)),
  refresh: () => Promise.resolve()
};

function makeEnricher() {
  return createEnricher({
    bots: loadCompiledBots(),
    verifier: fakeVerifier,
    secret: "test-secret",
    ingestSource: "api"
  });
}

function event(overrides: Partial<RawLogEvent>): RawLogEvent {
  return {
    ts: "2026-06-10T03:22:01.000Z",
    ip: "203.0.113.10",
    method: "GET",
    path: "/blog/ai-crawlers?utm_source=chatgpt.com",
    status: 200,
    bytes: 512,
    ua: "",
    referer: "",
    ...overrides
  };
}

describe("createEnricher network enrichment", () => {
  it("fills the network from the database when the sensor could not", async () => {
    // A plain access log has no country/asn/asOrg — that is the whole problem.
    const enrich = createEnricher({
      bots: loadCompiledBots(),
      secret: "test-secret",
      network: NETWORK
    });
    const row = await enrich("site-1", event({ ip: "8.8.8.8" }));
    expect(row).toMatchObject({ country: "US", asn: 15169, as_org: "GOOGLE" });
  });

  it("never overwrites what the sensor already reported", async () => {
    // Cloudflare knows the address better than a dump refreshed hourly, and its
    // answer for 203.0.113.10 differs from the database on every field.
    const enrich = createEnricher({
      bots: loadCompiledBots(),
      secret: "test-secret",
      network: NETWORK
    });
    const row = await enrich(
      "site-1",
      event({ ip: "203.0.113.10", country: "FR", asn: 3215, asOrg: "ORANGE" })
    );
    expect(row).toMatchObject({ country: "FR", asn: 3215, as_org: "ORANGE" });
  });

  it("fills only the fields the sensor left out", async () => {
    const enrich = createEnricher({
      bots: loadCompiledBots(),
      secret: "test-secret",
      network: NETWORK
    });
    const row = await enrich("site-1", event({ ip: "8.8.8.8", country: "FR" }));
    expect(row).toMatchObject({ country: "FR", asn: 15169, as_org: "GOOGLE" });
  });

  it("treats a zero ASN from a sensor as unknown, not as an answer", async () => {
    // 0 is the unknown sentinel everywhere else in the schema, so a sensor that
    // reports it must not block the lookup and leave a row half-filled.
    const enrich = createEnricher({
      bots: loadCompiledBots(),
      secret: "test-secret",
      network: NETWORK
    });
    const row = await enrich("site-1", event({ ip: "8.8.8.8", asn: 0 }));
    expect(row).toMatchObject({ country: "US", asn: 15169, as_org: "GOOGLE" });
  });

  it("leaves the network empty when no database is configured", async () => {
    const enrich = createEnricher({ bots: loadCompiledBots(), secret: "test-secret" });
    const row = await enrich("site-1", event({ ip: "8.8.8.8" }));
    expect(row).toMatchObject({ country: "", asn: 0, as_org: "" });
  });

  it("leaves the network empty for an address nobody announces", async () => {
    const enrich = createEnricher({
      bots: loadCompiledBots(),
      secret: "test-secret",
      network: NETWORK
    });
    const row = await enrich("site-1", event({ ip: "192.168.1.1" }));
    expect(row).toMatchObject({ country: "", asn: 0, as_org: "" });
  });
});

describe("createEnricher", () => {
  it("enriches a verified bot hit and keeps the raw bot IP", async () => {
    const enrich = makeEnricher();
    const row = await enrich("site-1", event({
      ip: "52.230.152.17",
      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot"
    }));

    expect(row.site_id).toBe("site-1");
    expect(row.actor_type).toBe("ai_training");
    expect(row.bot_id).toBe("gptbot");
    expect(row.operator).toBe("openai");
    expect(row.verification).toBe("verified");
    expect(row.bot_ip).toBe("52.230.152.17");
    expect(row.ip_hash).toMatch(/^\d+$/);
    expect(row.ts).toBe(Date.parse("2026-06-10T03:22:01.000Z"));
    expect(row.path).toBe("/blog/ai-crawlers");
    expect(row.query).toBe(""); // query dropped before storage (privacy)
    expect(row.path_group).toBe("/blog/ai-crawlers");
    // bots never count as AI referrals
    expect(row.ai_referral).toBe("");
  });

  it("flags a spoofed bot", async () => {
    const enrich = makeEnricher();
    const row = await enrich("site-1", event({
      ip: "129.205.96.146",
      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot"
    }));
    expect(row.verification).toBe("spoofed");
  });

  it("hashes human IPs and never stores them raw", async () => {
    const enrich = makeEnricher();
    const row = await enrich("site-1", event({
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      referer: "https://chatgpt.com/"
    }));

    expect(row.actor_type).toBe("human");
    expect(row.bot_ip).toBe("");
    expect(row.verification).toBe("na");
    expect(row.ai_referral).toBe("chatgpt");
    expect(row.referer).toBe("https://chatgpt.com"); // stored origin-only
  });

  it("stores only the referer origin but still classifies from the full URL", async () => {
    const enrich = makeEnricher();
    const row = await enrich("site-1", event({
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      path: "/pricing", // no utm, so detection must come from the referer
      referer: "https://www.perplexity.ai/search/abc?token=secret-do-not-store"
    }));

    expect(row.ai_referral).toBe("perplexity"); // detected from the full referer
    expect(row.referer).toBe("https://www.perplexity.ai"); // but the token is not stored
    expect(row.query).toBe("");
  });

  it("detects AI referral from utm_source when the referrer is stripped", async () => {
    const enrich = makeEnricher();
    const row = await enrich("site-1", event({
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
    }));
    expect(row.ai_referral).toBe("chatgpt");
  });

  it("keeps one session for the same visitor and splits different visitors", async () => {
    const enrich = makeEnricher();
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    const first = await enrich("site-1", event({ ua, path: "/a" }));
    const second = await enrich("site-1", event({ ua, path: "/b", ts: "2026-06-10T03:25:01.000Z" }));
    const other = await enrich("site-1", event({ ua, ip: "198.51.100.7", path: "/a" }));

    expect(second.session_id).toBe(first.session_id);
    expect(other.session_id).not.toBe(first.session_id);
  });

  it("groups dynamic path segments", async () => {
    const enrich = makeEnricher();
    const row = await enrich("site-1", event({ path: "/users/12345/profile" }));
    expect(row.path_group).toBe("/users/:id/profile");
  });
});
