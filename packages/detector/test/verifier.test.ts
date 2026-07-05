import { describe, expect, it, vi } from "vitest";

import type { BotRegistryEntry } from "@crawlytics/registry";

import { createIpVerifier } from "../src/verify/verifier.js";
import type { DnsResolverLike } from "../src/verify/verifier.js";

const ENTRIES: BotRegistryEntry[] = [
  {
    bot_id: "gptbot",
    operator: "openai",
    actor_type: "ai_training",
    ua_patterns: ["GPTBot"],
    ip_source: "https://openai.com/gptbot.json"
  },
  {
    bot_id: "googlebot",
    operator: "google",
    actor_type: "search_engine",
    ua_patterns: ["Googlebot"],
    ip_source: "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
    rdns_suffixes: [".googlebot.com", ".google.com"]
  },
  {
    bot_id: "amazonbot",
    operator: "amazon",
    actor_type: "ai_training",
    ua_patterns: ["Amazonbot"],
    rdns_suffixes: [".crawl.amazonbot.amazon"]
  },
  {
    bot_id: "bytespider",
    operator: "bytedance",
    actor_type: "ai_training",
    ua_patterns: ["Bytespider"]
  }
];

const OPENAI_DOC = { prefixes: [{ ipv4Prefix: "52.230.152.0/24" }, { ipv6Prefix: "2a01:111::/32" }] };
const GOOGLE_DOC = { prefixes: [{ ipv4Prefix: "66.249.64.0/19" }] };

function fakeFetch(map: Record<string, unknown>) {
  return vi.fn((url: string): Promise<unknown> => {
    const doc = map[url];
    if (doc === undefined) {
      return Promise.reject(new Error(`unexpected url ${url}`));
    }
    return Promise.resolve(doc);
  });
}

function fakeResolver(overrides: Partial<DnsResolverLike> = {}): DnsResolverLike {
  return {
    reverse: () => Promise.reject(dnsError("ENOTFOUND")),
    resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
    resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
    ...overrides
  };
}

function dnsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("IpVerifier: vendor IP ranges", () => {
  it("verifies an in-range IP", async () => {
    const verifier = createIpVerifier({
      entries: ENTRIES,
      fetchJson: fakeFetch({ "https://openai.com/gptbot.json": OPENAI_DOC })
    });
    await expect(verifier.verify("gptbot", "52.230.152.17")).resolves.toBe("verified");
    await expect(verifier.verify("gptbot", "2a01:111:dead::1")).resolves.toBe("verified");
  });

  it("flags an out-of-range IP as spoofed when no rDNS fallback exists", async () => {
    const verifier = createIpVerifier({
      entries: ENTRIES,
      fetchJson: fakeFetch({ "https://openai.com/gptbot.json": OPENAI_DOC })
    });
    await expect(verifier.verify("gptbot", "129.205.96.146")).resolves.toBe("spoofed");
  });

  it("never reports spoofed when range data is unavailable (fail-open)", async () => {
    const verifier = createIpVerifier({
      entries: ENTRIES,
      fetchJson: vi.fn(() => Promise.reject(new Error("network down")))
    });
    await expect(verifier.verify("gptbot", "129.205.96.146")).resolves.toBe("unverified");
  });

  it("caches range documents between calls (TTL)", async () => {
    const fetchJson = fakeFetch({ "https://openai.com/gptbot.json": OPENAI_DOC });
    let nowMs = 1_000_000;
    const verifier = createIpVerifier({
      entries: ENTRIES,
      fetchJson,
      rangesTtlMs: 60_000,
      now: () => nowMs
    });
    await verifier.verify("gptbot", "52.230.152.1");
    await verifier.verify("gptbot", "52.230.152.2");
    expect(fetchJson).toHaveBeenCalledTimes(1);
    nowMs += 61_000;
    await verifier.verify("gptbot", "52.230.152.3");
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("returns na for bots without any verification method", async () => {
    const verifier = createIpVerifier({ entries: ENTRIES, fetchJson: fakeFetch({}) });
    await expect(verifier.verify("bytespider", "1.2.3.4")).resolves.toBe("na");
    await expect(verifier.verify("unknown-bot", "1.2.3.4")).resolves.toBe("na");
  });

  it("returns unverified for unparseable IPs", async () => {
    const verifier = createIpVerifier({
      entries: ENTRIES,
      fetchJson: fakeFetch({ "https://openai.com/gptbot.json": OPENAI_DOC })
    });
    await expect(verifier.verify("gptbot", "garbage")).resolves.toBe("unverified");
  });
});

describe("IpVerifier: FCrDNS", () => {
  it("verifies via reverse+forward DNS", async () => {
    const resolver = fakeResolver({
      reverse: () => Promise.resolve(["crawl-12-34-56-78.crawl.amazonbot.amazon"]),
      resolve4: () => Promise.resolve(["12.34.56.78"])
    });
    const verifier = createIpVerifier({ entries: ENTRIES, fetchJson: fakeFetch({}), resolver });
    await expect(verifier.verify("amazonbot", "12.34.56.78")).resolves.toBe("verified");
  });

  it("flags PTR suffix mismatch as spoofed", async () => {
    const resolver = fakeResolver({
      reverse: () => Promise.resolve(["evil.example.com"])
    });
    const verifier = createIpVerifier({ entries: ENTRIES, fetchJson: fakeFetch({}), resolver });
    await expect(verifier.verify("amazonbot", "12.34.56.78")).resolves.toBe("spoofed");
  });

  it("flags forward-confirmation mismatch as spoofed", async () => {
    const resolver = fakeResolver({
      reverse: () => Promise.resolve(["crawl-1.crawl.amazonbot.amazon"]),
      resolve4: () => Promise.resolve(["99.99.99.99"])
    });
    const verifier = createIpVerifier({ entries: ENTRIES, fetchJson: fakeFetch({}), resolver });
    await expect(verifier.verify("amazonbot", "12.34.56.78")).resolves.toBe("spoofed");
  });

  it("flags missing PTR (NXDOMAIN) as spoofed", async () => {
    const verifier = createIpVerifier({ entries: ENTRIES, fetchJson: fakeFetch({}), resolver: fakeResolver() });
    await expect(verifier.verify("amazonbot", "12.34.56.78")).resolves.toBe("spoofed");
  });

  it("treats transient DNS failures as unverified", async () => {
    const resolver = fakeResolver({
      reverse: () => Promise.reject(dnsError("ETIMEOUT"))
    });
    const verifier = createIpVerifier({ entries: ENTRIES, fetchJson: fakeFetch({}), resolver });
    await expect(verifier.verify("amazonbot", "12.34.56.78")).resolves.toBe("unverified");
  });

  it("falls back to rDNS when the IP is outside published ranges", async () => {
    const resolver = fakeResolver({
      reverse: () => Promise.resolve(["rate-limited-proxy-66-249-90-77.google.com"]),
      resolve4: () => Promise.resolve(["66.249.90.77"])
    });
    const verifier = createIpVerifier({
      entries: ENTRIES,
      fetchJson: fakeFetch({ "https://developers.google.com/static/search/apis/ipranges/googlebot.json": GOOGLE_DOC }),
      resolver
    });
    // 66.249.90.77 is outside 66.249.64.0/19 but has valid Google FCrDNS
    await expect(verifier.verify("googlebot", "66.249.90.77")).resolves.toBe("verified");
  });

  it("caches rDNS verdicts per IP", async () => {
    const reverse = vi.fn(() => Promise.resolve(["crawl-1.crawl.amazonbot.amazon"]));
    const resolver = fakeResolver({ reverse, resolve4: () => Promise.resolve(["12.34.56.78"]) });
    const verifier = createIpVerifier({ entries: ENTRIES, fetchJson: fakeFetch({}), resolver });
    await verifier.verify("amazonbot", "12.34.56.78");
    await verifier.verify("amazonbot", "12.34.56.78");
    expect(reverse).toHaveBeenCalledTimes(1);
  });
});

describe("IpVerifier: refresh", () => {
  it("prefetches every distinct ip_source once", async () => {
    const fetchJson = fakeFetch({
      "https://openai.com/gptbot.json": OPENAI_DOC,
      "https://developers.google.com/static/search/apis/ipranges/googlebot.json": GOOGLE_DOC
    });
    const verifier = createIpVerifier({ entries: ENTRIES, fetchJson });
    await verifier.refresh();
    expect(fetchJson).toHaveBeenCalledTimes(2);
    await verifier.verify("gptbot", "52.230.152.1");
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });
});
