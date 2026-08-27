import { describe, expect, it, vi } from "vitest";

import { createStatsStore, joinCrawlToRefer, pivotTimeseries } from "../src/stats.js";

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
      [/DISTINCT site_id/, [{ site_id: "acme" }, { site_id: "globex" }]]
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
    expect(overview.sites).toEqual(["acme", "globex"]);
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

describe("createStatsStore.aiLandingPages", () => {
  it("returns landing pages split by bot class", async () => {
    const client = fakeClient([
      [/AS clicked/, [
        { page: "/blog/a", training_hits: "50", search_hits: "12", fetch_hits: "6", clicked: "8" },
        { page: "/blog/b", training_hits: "0", search_hits: "0", fetch_hits: "0", clicked: "3" }
      ]]
    ]);
    const store = createStatsStore(client);
    const result = await store.aiLandingPages("acme", 30, 50);

    expect(result).toEqual([
      { page: "/blog/a", training: 50, search: 12, fetch: 6, clicked: 8 },
      // Clicks with zero bot hits are ordinary, not a data error.
      { page: "/blog/b", training: 0, search: 0, fetch: 0, clicked: 3 }
    ]);
    expect(client.captured[0]?.query_params).toMatchObject({ site: "acme", days: 30, limit: 50 });
    expect(client.captured[0]?.query).not.toContain("acme'");
  });

  it("returns empty when no page received referral landings", async () => {
    const store = createStatsStore(fakeClient([]));
    expect(await store.aiLandingPages("acme", 30)).toEqual([]);
  });
});

describe("createStatsStore.citations", () => {
  it("returns cited pages, per-assistant clicks, per-operator crawls and the live feed", async () => {
    const client = fakeClient([
      [/AS fetched/, [
        { page: "/pricing", fetched: "9", surfaced: "4", clicked: "6", last_cited: "2026-07-15 10:00:00" },
        { page: "/blog/a", fetched: "0", surfaced: "3", clicked: "0", last_cited: "2026-07-14 09:00:00" }
      ]],
      [/AS clicks/, [{ source: "chatgpt", clicks: "6" }, { source: "perplexity", clicks: "2" }]],
      [/AS crawls/, [{ operator: "openai", crawls: "42" }]],
      [/SELECT ts, bot_id/, [
        {
          ts: "2026-07-15 10:00:00",
          bot_id: "chatgpt-user",
          operator: "openai",
          actor_type: "ai_fetcher",
          path: "/pricing",
          country: "US"
        }
      ]]
    ]);

    const store = createStatsStore(client);
    const result = await store.citations("acme", 30, 50);

    expect(result.pages).toEqual([
      { page: "/pricing", fetched: 9, surfaced: 4, clicked: 6, lastCited: "2026-07-15 10:00:00" },
      { page: "/blog/a", fetched: 0, surfaced: 3, clicked: 0, lastCited: "2026-07-14 09:00:00" }
    ]);
    expect(result.bySource).toEqual([
      { source: "chatgpt", clicks: 6 },
      { source: "perplexity", clicks: 2 }
    ]);
    expect(result.byOperator).toEqual([{ operator: "openai", crawls: 42 }]);
    expect(result.feed).toEqual([
      {
        ts: "2026-07-15 10:00:00",
        botId: "chatgpt-user",
        operator: "openai",
        actorType: "ai_fetcher",
        path: "/pricing",
        country: "US"
      }
    ]);

    // every query is parameterized — raw values never appear in the SQL text
    for (const entry of client.captured) {
      expect(entry.query_params).toMatchObject({ site: "acme" });
      expect(entry.query).not.toContain("acme'");
    }
    // the paged query is bounded
    const pagesQuery = client.captured.find((entry) => entry.query.includes("AS fetched"));
    expect(pagesQuery?.query_params).toMatchObject({ site: "acme", days: 30, limit: 50 });
    // the feed only shows live retrieval bots (ai_fetcher/ai_search), never training noise
    const feedQuery = client.captured.find((entry) => entry.query.includes("SELECT ts, bot_id"));
    expect(feedQuery?.query).toContain("'ai_fetcher'");
    expect(feedQuery?.query).toContain("'ai_search'");
    expect(feedQuery?.query).not.toContain("'ai_training'");
    // ...and is time-bounded — must never scan all retained partitions
    expect(feedQuery?.query).toContain("INTERVAL {days:UInt32} DAY");
  });

  it("returns empty structures when the site has no AI traffic", async () => {
    const store = createStatsStore(fakeClient([]));
    expect(await store.citations("acme", 30)).toEqual({
      pages: [],
      bySource: [],
      byOperator: [],
      feed: [],
      infra: []
    });
  });
});

describe("createStatsStore.crawlHealth", () => {
  it("returns AI-error pages and pages AI never crawled (blind spots)", async () => {
    const client = fakeClient([
      [/AS ai_errors/, [
        { page: "/docs/old", ai_errors: "7", sample_status: "404", last_hit: "2026-07-15 09:00:00", ever_ok: 1 }
      ]],
      [/AS human_hits/, [
        { page: "/pricing/enterprise", human_hits: "120", readers: "31" },
        { page: "/changelog", human_hits: "40", readers: "12" }
      ]]
    ]);

    const store = createStatsStore(client);
    const result = await store.crawlHealth("acme", 30, 50);

    expect(result.broken).toEqual([
      { page: "/docs/old", aiErrors: 7, sampleStatus: 404, lastHit: "2026-07-15 09:00:00", everOk: true }
    ]);
    expect(result.blindSpots).toEqual([
      { page: "/pricing/enterprise", humanHits: 120, readers: 31 },
      { page: "/changelog", humanHits: 40, readers: 12 }
    ]);

    for (const entry of client.captured) {
      // The render-asset probe is site+window only — it has no row limit to pass.
      expect(entry.query_params).toMatchObject({ site: "acme", days: 30 });
      expect(entry.query).not.toContain("acme'");
    }
    for (const entry of client.captured.filter((row) => /AS ai_errors|AS human_hits/.test(row.query))) {
      expect(entry.query_params).toMatchObject({ limit: 50 });
    }
    // Nothing to compare against when the sensor sees no assets: the filter has
    // to switch itself off rather than empty the panel.
    expect(client.captured.some((entry) => entry.query.includes("browserOnly"))).toBe(true);
    // broken = AI bots hitting >=400; blind spots = zero AI hits but real human traffic
    const broken = client.captured.find((entry) => entry.query.includes("AS ai_errors"));
    expect(broken?.query).toContain("actor_type LIKE 'ai_%'");
    const blind = client.captured.find((entry) => entry.query.includes("AS human_hits"));
    expect(blind?.query).toContain("= 0");
    // blind spots are PAGES: successful GET/HEAD, assets/API noise excluded
    expect(blind?.query).toContain("method IN ('GET', 'HEAD')");
    expect(blind?.query).toContain("NOT match(path_group");
    expect(blind?.query).toContain("status < 400");
  });

  it("returns empty lists when there is no traffic at all", async () => {
    const store = createStatsStore(fakeClient([]));
    expect(await store.crawlHealth("acme", 30)).toEqual({ broken: [], blindSpots: [] });
  });
});

describe("joinCrawlToRefer", () => {
  it("joins crawls (operator) with clicks (ai_referral) via the vendor mapping", () => {
    const rows = joinCrawlToRefer(
      [
        { operator: "openai", crawls: 1000 },
        { operator: "perplexity", crawls: 50 },
        { operator: "bytedance", crawls: 800 }
      ],
      [
        { source: "chatgpt", clicks: 20 },
        { source: "perplexity", clicks: 10 },
        { source: "you", clicks: 3 }
      ]
    );

    expect(rows).toEqual([
      // sorted by crawls desc; ratio = clicks/crawls
      { vendor: "openai", crawls: 1000, clicks: 20, ratio: 0.02, hasAssistant: true },
      // no consumer assistant -> 0 clicks is expected, flagged via hasAssistant
      { vendor: "bytedance", crawls: 800, clicks: 0, ratio: 0, hasAssistant: false },
      { vendor: "perplexity", crawls: 50, clicks: 10, ratio: 0.2, hasAssistant: true },
      // clicks with zero observed crawls: ratio is null (no division by zero)
      { vendor: "you", crawls: 0, clicks: 3, ratio: null, hasAssistant: true }
    ]);
  });

  it("breaks crawl/click ties deterministically by vendor name", () => {
    const rows = joinCrawlToRefer(
      [
        { operator: "bytedance", crawls: 10 },
        { operator: "amazon", crawls: 10 }
      ],
      []
    );
    expect(rows.map((row) => row.vendor)).toEqual(["amazon", "bytedance"]);
  });

  it("returns empty for no data", () => {
    expect(joinCrawlToRefer([], [])).toEqual([]);
  });

  it("treats an operator that collides with Object.prototype as unmapped", () => {
    // operator comes from the database; a plain index would resolve "toString"
    // to a function and pretend the vendor has a consumer assistant.
    const rows = joinCrawlToRefer(
      [
        { operator: "toString", crawls: 10 },
        { operator: "constructor", crawls: 5 }
      ],
      [{ source: "chatgpt", clicks: 3 }]
    );
    const polluted = rows.filter((row) => row.vendor === "toString" || row.vendor === "constructor");
    expect(polluted).toHaveLength(2);
    for (const row of polluted) {
      expect(row.clicks).toBe(0);
      expect(row.hasAssistant).toBe(false);
    }
    // the real chatgpt clicks stay their own "sender" row, untouched by the collision
    expect(rows.find((row) => row.vendor === "chatgpt")?.clicks).toBe(3);
  });
});

describe("createStatsStore.crawlToRefer", () => {
  it("reads crawls and clicks from the rollups and joins them", async () => {
    const client = fakeClient([
      [/FROM daily_bot_stats/, [{ operator: "openai", crawls: "100" }]],
      [/FROM daily_referrals/, [{ source: "chatgpt", clicks: "5" }]]
    ]);
    const store = createStatsStore(client);
    const result = await store.crawlToRefer("acme", 30);

    expect(result.rows).toEqual([{ vendor: "openai", crawls: 100, clicks: 5, ratio: 0.05, hasAssistant: true }]);
    for (const entry of client.captured) {
      expect(entry.query_params).toMatchObject({ site: "acme", days: 30 });
      expect(entry.query).not.toContain("acme'");
      // exact rolling window: `date > today() - days`, not `>=` (that's days+1 dates)
      expect(entry.query).toContain("date > today() - {days:UInt32}");
    }
    // crawl side counts AI bots only
    const crawlQuery = client.captured.find((entry) => entry.query.includes("daily_bot_stats"));
    expect(crawlQuery?.query).toContain("actor_type LIKE 'ai_%'");
  });

  it("returns empty rows when the site has no data", async () => {
    const store = createStatsStore(fakeClient([]));
    expect(await store.crawlToRefer("acme", 30)).toEqual({ rows: [] });
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
