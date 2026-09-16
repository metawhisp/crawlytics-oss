import { loadCompiledBots } from "@crawlytics/registry";
import { describe, expect, it, vi } from "vitest";

import { createIpVerifier } from "../src/verify/verifier.js";
import type { DnsResolverLike } from "../src/verify/verifier.js";

// Deliberately NOT a fixture. The other verifier tests hand-build entries, and
// one of them gave amazonbot an rdns_suffixes the shipped registry has never
// had — which is how three search engines sat under a heading promising
// "verification metadata" with none, answering "na" to every check. A forgery
// wearing their name got a green badge and never reached Security. So this
// file asks the compiled registry itself.
//
// amazonbot is not in here on purpose: Amazon publishes its addresses only as
// text inside a script-rendered page, and reverse lookups of that list return
// ec2-*.compute-1.amazonaws.com — shared with every EC2 instance there is.
// "na" is the truthful answer for it. The reasoning sits in custom-bots.yaml
// next to the entry rather than being frozen into an assertion here.

const nx = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));

/** Forward and reverse agree for `host` at `ip`, which is what FCrDNS wants. */
function resolverFor(ip: string, host: string): DnsResolverLike {
  return {
    reverse: (address: string) => (address === ip ? Promise.resolve([host]) : nx()),
    resolve4: (name: string) => (name === host ? Promise.resolve([ip]) : nx()),
    resolve6: () => nx()
  };
}

const noNetwork = () => vi.fn(() => Promise.reject(new Error("no network in tests")));

describe("search engines the registry lists as checkable really are", () => {
  const RDNS = [
    { botId: "yandexbot", ip: "5.45.207.77", host: "5-45-207-77.spider.yandex.com" },
    { botId: "baiduspider", ip: "123.125.66.120", host: "baiduspider-123-125-66-120.crawl.baidu.com" }
  ];

  for (const c of RDNS) {
    it(`${c.botId} verifies by forward-confirmed reverse DNS`, async () => {
      const verifier = createIpVerifier({
        entries: loadCompiledBots(),
        resolver: resolverFor(c.ip, c.host),
        fetchJson: noNetwork()
      });
      await expect(verifier.verify(c.botId, c.ip)).resolves.toBe("verified");
    });

    it(`${c.botId} wearing a foreign PTR is called spoofed, not "na"`, async () => {
      const verifier = createIpVerifier({
        entries: loadCompiledBots(),
        resolver: resolverFor("203.0.113.9", "scanner.example.com"),
        fetchJson: noNetwork()
      });
      await expect(verifier.verify(c.botId, "203.0.113.9")).resolves.toBe("spoofed");
    });
  }

  // DuckDuckGo runs on Azure and its PTRs are generic, so it publishes
  // addresses instead — the same {prefixes:[{ipv4Prefix}]} document Google and
  // Bing use.
  const DDG_LIST = { prefixes: [{ ipv4Prefix: "20.191.45.212/32" }] };

  it("duckduckbot verifies against the published address list", async () => {
    const verifier = createIpVerifier({
      entries: loadCompiledBots(),
      resolver: resolverFor("20.191.45.212", "whatever.cloudapp.azure.com"),
      fetchJson: vi.fn(() => Promise.resolve(DDG_LIST))
    });
    await expect(verifier.verify("duckduckbot", "20.191.45.212")).resolves.toBe("verified");
  });

  it("something calling itself duckduckbot from elsewhere is spoofed", async () => {
    const verifier = createIpVerifier({
      entries: loadCompiledBots(),
      resolver: resolverFor("203.0.113.9", "scanner.example.com"),
      fetchJson: vi.fn(() => Promise.resolve(DDG_LIST))
    });
    await expect(verifier.verify("duckduckbot", "203.0.113.9")).resolves.toBe("spoofed");
  });

  // A 200 OK whose body has no readable addresses is not a list saying "this IP
  // is not ours" — it is no list at all. The contract above verify() says
  // failures never produce "spoofed", and an empty parse is a failure: a vendor
  // error page served with status 200, a format change, a document keyed by
  // address (walk() reads values, not keys). duckduckbot has no reverse-DNS
  // fallback, so this verdict would be final for it.
  const UNREADABLE = [
    { label: "an error served as 200", doc: { error: "temporarily unavailable" } },
    { label: "an empty document", doc: {} },
    { label: "addresses hidden in keys", doc: [{ "20.191.45.212": "" }] }
  ];

  for (const c of UNREADABLE) {
    it(`does not call duckduckbot spoofed over ${c.label}`, async () => {
      const verifier = createIpVerifier({
        entries: loadCompiledBots(),
        resolver: resolverFor("20.191.45.212", "whatever.cloudapp.azure.com"),
        fetchJson: vi.fn(() => Promise.resolve(c.doc))
      });
      await expect(verifier.verify("duckduckbot", "20.191.45.212")).resolves.not.toBe("spoofed");
    });
  }

  // A vendor document that cannot be read is a state that lasts — a maintenance
  // page, a schema change, an outage. verify() runs once per bot event
  // (apps/server/src/pipeline/enrich.ts), and enrichment runs a whole batch
  // concurrently, so "ask again next time" means asking the vendor once per
  // event for as long as it lasts. The answer has to be remembered, briefly.
  it("asks the vendor once, not once per event, while its document is unreadable", async () => {
    const fetchJson = vi.fn(() => Promise.resolve({ error: "maintenance" }));
    const verifier = createIpVerifier({
      entries: loadCompiledBots(),
      resolver: resolverFor("20.191.45.212", "whatever.cloudapp.azure.com"),
      fetchJson
    });
    for (let i = 0; i < 50; i += 1) {
      await verifier.verify("duckduckbot", "20.191.45.212");
    }
    expect(fetchJson.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("and stops asking when the vendor is unreachable, too", async () => {
    const fetchJson = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    const verifier = createIpVerifier({
      entries: loadCompiledBots(),
      resolver: resolverFor("20.191.45.212", "whatever.cloudapp.azure.com"),
      fetchJson
    });
    for (let i = 0; i < 50; i += 1) {
      await verifier.verify("duckduckbot", "20.191.45.212");
    }
    expect(fetchJson.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
