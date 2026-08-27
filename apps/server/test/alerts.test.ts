import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ALERTS_CONFIG, dedupKey } from "../src/alerts/config.js";
import { deliverWebhook } from "../src/alerts/deliver.js";
import { evaluateRules } from "../src/alerts/rules.js";
import { createAlertsRunner, pruneAlertsState } from "../src/alerts/runner.js";
import { createMemoryStore } from "../src/metadata/memory-store.js";

interface CapturedQuery {
  query: string;
  query_params?: Record<string, unknown>;
}

function fakeClient(rowsByMatch: Array<[RegExp, unknown[]]>) {
  const captured: CapturedQuery[] = [];
  return {
    captured,
    query: vi.fn((options: CapturedQuery) => {
      captured.push(options);
      const match = rowsByMatch.find(([pattern]) => pattern.test(options.query));
      return Promise.resolve({ json: () => Promise.resolve(match ? match[1] : []) });
    })
  };
}

const ALL_RULES = { spike: true, newBot: true, spoof: true, brokenCitation: true };

describe("evaluateRules", () => {
  it("fires spike only above the factor AND the absolute floor", async () => {
    // avg 2/h, last hour 30 -> spike (factor 3, floor 20)
    const hot = fakeClient([[/AS last_hour/, [{ last_hour: "30", avg_hour: "2" }]]]);
    const fired = await evaluateRules(hot, "s1", { rules: { ...ALL_RULES, newBot: false, spoof: false, brokenCitation: false }, spikeFactor: 3, windowMinutes: 10 });
    expect(fired).toEqual([
      expect.objectContaining({ rule: "spike", site: "s1", subject: "ai-traffic" })
    ]);

    // 15 hits/hour is above factor x avg but below the absolute floor -> quiet
    const low = fakeClient([[/AS last_hour/, [{ last_hour: "15", avg_hour: "2" }]]]);
    expect(
      await evaluateRules(low, "s1", { rules: { ...ALL_RULES, newBot: false, spoof: false, brokenCitation: false }, spikeFactor: 3, windowMinutes: 10 })
    ).toEqual([]);

    // empty history (avg 0) with low volume -> quiet (cold start)
    const cold = fakeClient([[/AS last_hour/, [{ last_hour: "5", avg_hour: "0" }]]]);
    expect(
      await evaluateRules(cold, "s1", { rules: { ...ALL_RULES, newBot: false, spoof: false, brokenCitation: false }, spikeFactor: 3, windowMinutes: 10 })
    ).toEqual([]);

    // HIGH volume but zero prior history -> still quiet: a cold start is not a spike
    const coldBurst = fakeClient([[/AS last_hour/, [{ last_hour: "1000", avg_hour: "0" }]]]);
    expect(
      await evaluateRules(coldBurst, "s1", { rules: { ...ALL_RULES, newBot: false, spoof: false, brokenCitation: false }, spikeFactor: 3, windowMinutes: 10 })
    ).toEqual([]);

    // the baseline must exclude the current hour (no self-baselining)
    const spikeQuery = coldBurst.captured.find((entry) => entry.query.includes("AS avg_hour"));
    expect(spikeQuery?.query).toContain("ts <= now() - INTERVAL 1 HOUR");
  });

  it("guards new_bot behind prior history and reads broken citations from the rollup", async () => {
    const client = fakeClient([]);
    await evaluateRules(client, "s1", { rules: ALL_RULES, spikeFactor: 3, windowMinutes: 10 });
    const newBot = client.captured.find((entry) => entry.query.includes("NOT IN"));
    // scalar guard: an empty-history site must not announce every bot as new
    expect(newBot?.query).toContain("prior_events");
    const broken = client.captured.find((entry) => entry.query.includes("AS errors"));
    // "previously cited fine" comes from the rollup, not a 30-day raw scan per tick
    expect(broken?.query).toContain("daily_page_stats");
    expect(broken?.query).toContain("status >= 400");
  });

  it("fires new_bot per unseen bot and spoof per spoofed bot", async () => {
    const client = fakeClient([
      [/NOT IN/, [{ bot_id: "shinybot" }]],
      [/spoofed/, [{ bot_id: "gptbot", hits: "4" }]]
    ]);
    const fired = await evaluateRules(client, "s1", {
      rules: { ...ALL_RULES, spike: false, brokenCitation: false },
      spikeFactor: 3,
      windowMinutes: 10
    });
    expect(fired).toEqual([
      expect.objectContaining({ rule: "new_bot", subject: "shinybot" }),
      expect.objectContaining({ rule: "spoof", subject: "gptbot" })
    ]);
  });

  it("fires broken_citation for previously-cited pages that now error", async () => {
    const client = fakeClient([[/AS errors/, [{ path_group: "/docs", errors: "3" }]]]);
    const fired = await evaluateRules(client, "s1", {
      rules: { ...ALL_RULES, spike: false, newBot: false, spoof: false },
      spikeFactor: 3,
      windowMinutes: 10
    });
    expect(fired).toEqual([expect.objectContaining({ rule: "broken_citation", subject: "/docs" })]);
  });

  it("parameterizes every rule query", async () => {
    const client = fakeClient([]);
    await evaluateRules(client, "site'with'quotes", { rules: ALL_RULES, spikeFactor: 3, windowMinutes: 10 });
    expect(client.captured.length).toBeGreaterThanOrEqual(4);
    for (const entry of client.captured) {
      expect(entry.query_params).toMatchObject({ site: "site'with'quotes" });
      expect(entry.query).not.toContain("site'with'quotes");
    }
  });
});

describe("deliverWebhook", () => {
  it("posts the payload and reports success", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("ok", { status: 200 })));
    const ok = await deliverWebhook("https://hooks.example/x", { text: "hi", rule: "spike", site: "s1", subject: "a" }, fetchImpl);
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("https://hooks.example/x");
    expect(JSON.parse(init.body) as Record<string, unknown>).toMatchObject({ text: "hi", rule: "spike" });
  });

  it("retries once and fails open (never throws)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    expect(await deliverWebhook("https://hooks.example/x", { text: "hi", rule: "spike", site: "s1", subject: "a" }, fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const dead = vi.fn(() => Promise.reject(new Error("down")));
    expect(await deliverWebhook("https://hooks.example/x", { text: "hi", rule: "spike", site: "s1", subject: "a" }, dead)).toBe(false);
  });
});

describe("createAlertsRunner", () => {
  function makeMetadata() {
    return createMemoryStore();
  }

  it("does nothing when no webhook URL is configured (default off)", async () => {
    const metadata = makeMetadata();
    await metadata.createSite({ id: "s1" });
    const client = fakeClient([[/AS last_hour/, [{ last_hour: "1000", avg_hour: "1" }]]]);
    const deliver = vi.fn(() => Promise.resolve(true));
    const runner = createAlertsRunner({ metadata, client, deliver });
    expect(await runner.tick()).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("delivers fired alerts per site and respects the cooldown", async () => {
    const metadata = makeMetadata();
    await metadata.createSite({ id: "s1" });
    await metadata.setAlertsConfig({ ...DEFAULT_ALERTS_CONFIG, webhookUrl: "https://hooks.example/x" });
    const client = fakeClient([[/AS last_hour/, [{ last_hour: "1000", avg_hour: "1" }]]]);
    const deliver = vi.fn(() => Promise.resolve(true));
    const runner = createAlertsRunner({ metadata, client, deliver });

    const first = await runner.tick();
    expect(first).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    // same alert immediately again -> silenced by cooldown, no second delivery
    const second = await runner.tick();
    expect(second).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1);

    // state persisted with the dedup key
    const state = await metadata.getAlertsState();
    expect(Object.keys(state)).toEqual([dedupKey({ rule: "spike", site: "s1", subject: "ai-traffic", text: "" })]);
  });

  it("keeps the alert eligible for retry when delivery fails", async () => {
    const metadata = makeMetadata();
    await metadata.createSite({ id: "s1" });
    await metadata.setAlertsConfig({ ...DEFAULT_ALERTS_CONFIG, webhookUrl: "https://hooks.example/x" });
    const client = fakeClient([[/AS last_hour/, [{ last_hour: "1000", avg_hour: "1" }]]]);
    const deliver = vi.fn(() => Promise.resolve(false));
    const runner = createAlertsRunner({ metadata, client, deliver });

    await runner.tick();
    expect(await metadata.getAlertsState()).toEqual({});

    // next tick retries the same alert
    await runner.tick();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("never runs two ticks concurrently (in-flight guard)", async () => {
    const metadata = makeMetadata();
    await metadata.createSite({ id: "s1" });
    await metadata.setAlertsConfig({ ...DEFAULT_ALERTS_CONFIG, webhookUrl: "https://hooks.example/x" });
    const client = fakeClient([[/AS last_hour/, [{ last_hour: "1000", avg_hour: "1" }]]]);
    let release: (value: boolean) => void = () => undefined;
    const deliver = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    const runner = createAlertsRunner({ metadata, client, deliver });

    const slow = runner.tick(); // will block inside deliver
    const overlapped = await runner.tick(); // must bail out immediately
    expect(overlapped).toEqual([]);

    // the slow tick reaches its (single) delivery; the overlapped one added none
    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalledTimes(1);
    });
    release(true);
    expect(await slow).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("prunes expired and overflow state entries", () => {
    const nowMs = Date.parse("2026-07-16T12:00:00.000Z");
    const cooldownMs = 60 * 60_000;
    const pruned = pruneAlertsState(
      {
        fresh: "2026-07-16T11:30:00.000Z", // inside cooldown -> kept
        stale: "2026-07-16T09:00:00.000Z", // past cooldown -> dropped
        garbage: "not-a-date" // unparseable -> dropped
      },
      nowMs,
      cooldownMs
    );
    expect(pruned.state).toEqual({ fresh: "2026-07-16T11:30:00.000Z" });
    expect(pruned.changed).toBe(true);

    // hard cap: newest entries win
    const big: Record<string, string> = {};
    for (let i = 0; i < 1500; i++) {
      big[`k${String(i)}`] = new Date(nowMs - i * 1000).toISOString();
    }
    const capped = pruneAlertsState(big, nowMs, 365 * 24 * 60 * 60_000);
    expect(Object.keys(capped.state)).toHaveLength(1000);
    expect(capped.state["k0"]).toBeDefined(); // newest kept
    expect(capped.state["k1499"]).toBeUndefined(); // oldest dropped
  });

  it("survives a ClickHouse failure without throwing (fail-open)", async () => {
    const metadata = makeMetadata();
    await metadata.createSite({ id: "s1" });
    await metadata.setAlertsConfig({ ...DEFAULT_ALERTS_CONFIG, webhookUrl: "https://hooks.example/x" });
    const client = { query: vi.fn(() => Promise.reject(new Error("ch down"))) };
    const deliver = vi.fn(() => Promise.resolve(true));
    const runner = createAlertsRunner({ metadata, client, deliver });
    await expect(runner.tick()).resolves.toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });
});
