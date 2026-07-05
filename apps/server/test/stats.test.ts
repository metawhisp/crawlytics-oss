import { describe, expect, it, vi } from "vitest";

import { createStatsStore, pivotTimeseries } from "../src/stats.js";

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
      return Promise.resolve({
        json: () => Promise.resolve(match ? match[1] : [])
      });
    })
  };
}

describe("createStatsStore.overview", () => {
  it("collects KPIs, timeseries, tops and recent in one call", async () => {
    const client = fakeClient([
      [/AS bot_errors/, [{ ai_hits: "12", unique_bots: "3", verified: "5", spoofed: "2", ai_referrals: "4", bot_errors: "1" }]],
      [/toStartOfHour/, [{ t: "2026-06-10 18:00:00", actor_type: "ai_training", c: "7" }]],
      [/GROUP BY bot_id/, [{ bot_id: "gptbot", operator: "openai", actor_type: "ai_training", hits: "7", pages: "3", spoofed: "1", last_seen: "2026-06-10 19:00:00" }]],
      [/GROUP BY path_group/, [{ path_group: "/blog/:id", ai_hits: "6", bots: "2", hits: "9" }]],
      [/ai_referral AS source/, [{ source: "chatgpt", hits: "4" }]],
      [/ORDER BY ts DESC/, [{ ts: "2026-06-10 19:31:27", actor_type: "ai_training", bot_id: "gptbot", operator: "openai", verification: "spoofed", path: "/robots.txt", ai_referral: "", status: 200 }]],
      [/DISTINCT site_id/, [{ site_id: "acme" }, { site_id: "example" }]]
    ]);

    const store = createStatsStore(client);
    const overview = await store.overview("acme", 24);

    expect(overview.kpis).toEqual({
      aiHits: 12,
      uniqueBots: 3,
      verified: 5,
      spoofed: 2,
      aiReferrals: 4,
      botErrors: 1
    });
    expect(overview.topBots[0]).toMatchObject({ botId: "gptbot", hits: 7, spoofed: 1 });
    expect(overview.topPages[0]).toMatchObject({ pathGroup: "/blog/:id", aiHits: 6 });
    expect(overview.referrals[0]).toEqual({ source: "chatgpt", hits: 4 });
    expect(overview.recent[0]).toMatchObject({ botId: "gptbot", verification: "spoofed" });
    expect(overview.sites).toEqual(["acme", "example"]);
    expect(overview.timeseries[0]).toMatchObject({ t: "2026-06-10 18:00:00", ai_training: 7 });

    // every data query is parameterized with site and hours
    const dataQueries = client.captured.filter((entry) => entry.query.includes("{site:String}"));
    expect(dataQueries.length).toBeGreaterThanOrEqual(5);
    for (const entry of dataQueries) {
      expect(entry.query_params).toMatchObject({ site: "acme", hours: 24 });
    }
    // never interpolates raw values into SQL
    for (const entry of client.captured) {
      expect(entry.query).not.toContain("acme'");
    }
  });
});

describe("createStatsStore.pagesDaily", () => {
  it("aligns dates, orders pages by total, and 0-fills gaps", async () => {
    // Rows come back ordered by (page, date); /a has no row on 2026-06-02.
    const client = fakeClient([
      [/FROM daily_page_stats/, [
        { date: "2026-06-01", page: "/a", hits: "5" },
        { date: "2026-06-03", page: "/a", hits: "3" },
        { date: "2026-06-01", page: "/b", hits: "10" },
        { date: "2026-06-02", page: "/b", hits: "20" },
        { date: "2026-06-03", page: "/b", hits: "10" }
      ]]
    ]);

    const store = createStatsStore(client);
    const result = await store.pagesDaily("acme", 30, 10);

    // x-axis: sorted unique dates
    expect(result.dates).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    // most popular first: /b (40) before /a (8)
    expect(result.pages).toEqual([
      { page: "/b", total: 40 },
      { page: "/a", total: 8 }
    ]);
    // series aligned to dates, gap on 2026-06-02 filled with 0
    expect(result.series).toEqual([
      { page: "/b", hits: [10, 20, 10] },
      { page: "/a", hits: [5, 0, 3] }
    ]);

    // query is parameterised (no raw interpolation) and bounded by limit
    expect(client.captured[0]?.query_params).toMatchObject({ site: "acme", days: 30, limit: 10 });
    expect(client.captured[0]?.query).not.toContain("acme'");
    // AI-only: an "AI hits per page" chart must not include human/search/social rows
    expect(client.captured[0]?.query).toContain("actor_type LIKE 'ai_%'");
  });

  it("returns empty structures when there is no data", async () => {
    const store = createStatsStore(fakeClient([]));
    expect(await store.pagesDaily("acme", 30)).toEqual({ dates: [], pages: [], series: [] });
  });
});

describe("createStatsStore.referralFunnels", () => {
  it("returns landing pages with the crawled->surfaced->clicked funnel", async () => {
    const client = fakeClient([
      [/AS clicked/, [
        { page: "/blog/a", crawled: "50", surfaced: "12", clicked: "8" },
        { page: "/blog/b", crawled: "30", surfaced: "5", clicked: "3" }
      ]]
    ]);
    const store = createStatsStore(client);
    const result = await store.referralFunnels("acme", 30, 50);

    expect(result).toEqual([
      { page: "/blog/a", crawled: 50, surfaced: 12, clicked: 8 },
      { page: "/blog/b", crawled: 30, surfaced: 5, clicked: 3 }
    ]);
    expect(client.captured[0]?.query_params).toMatchObject({ site: "acme", days: 30, limit: 50 });
    expect(client.captured[0]?.query).not.toContain("acme'");
  });

  it("returns empty when no page received referral landings", async () => {
    const store = createStatsStore(fakeClient([]));
    expect(await store.referralFunnels("acme", 30)).toEqual([]);
  });
});

describe("pivotTimeseries", () => {
  it("pivots actor_type rows into one row per bucket", () => {
    const rows = [
      { t: "10:00", actor_type: "ai_training", c: "3" },
      { t: "10:00", actor_type: "human", c: "5" },
      { t: "11:00", actor_type: "ai_search", c: "2" }
    ];
    expect(pivotTimeseries(rows)).toEqual([
      { t: "10:00", ai_training: 3, human: 5 },
      { t: "11:00", ai_search: 2 }
    ]);
  });
});
