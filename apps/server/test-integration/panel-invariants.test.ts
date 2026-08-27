import { afterAll, describe, expect, it } from "vitest";

import { IT_SITE, IT_SITE_NO_ASSETS, SCANNER_PATHS } from "./fixture.js";
import { clickHouseReady, testClient } from "./harness.js";
import { createStatsStore, type StatsStore } from "../src/stats.js";

/**
 * One test per promise a panel makes to the user. These are the assertions that
 * were missing when the panels shipped: each one describes what the heading
 * claims, not what the query happens to return.
 */

const client = clickHouseReady() ? testClient() : null;
const stats = client ? createStatsStore(client) : null;

afterAll(async () => {
  await client?.close();
});

function store(): StatsStore {
  if (!stats) {
    throw new Error("ClickHouse is not available");
  }
  return stats;
}

const DAYS = 30;
const HOURS = 720;

/** Paths that are never a citation: infrastructure files and static assets. */
const NON_CONTENT =
  /(^\/robots\.txt$|^\/sitemap[\w-]*\.xml$|^\/llms\.txt$|^\/favicon\.ico$|^\/\.well-known\/|\.(css|js|mjs|json|xml|txt|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm|pdf|zip)$)/iu;

describe.skipIf(!clickHouseReady())("panel invariants", () => {
  it("landing-page bot columns are disjoint channels that sum to the page's AI hits", async () => {
    const rows = await store().aiLandingPages(IT_SITE, DAYS, 50);
    expect(rows.length).toBeGreaterThan(0);

    if (!client) {
      throw new Error("ClickHouse is not available");
    }
    const result = await client.query({
      query: `SELECT path_group AS page, toString(countIf(actor_type LIKE 'ai_%')) AS ai_hits
              FROM events
              WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
                AND verification != 'spoofed'
              GROUP BY path_group`,
      query_params: { site: IT_SITE, days: DAYS },
      format: "JSONEachRow"
    });
    const aiHits = new Map((await result.json<{ page: string; ai_hits: string }>()).map((row) => [row.page, Number(row.ai_hits)]));

    for (const row of rows) {
      expect(row.training + row.search + row.fetch).toBe(aiHits.get(row.page) ?? 0);
    }

    // The row that made the old "funnel" impossible: a click on a page no bot
    // ever touched. It must survive, not be hidden or clamped.
    expect(rows.find((row) => row.page === "/blog/beta")).toEqual({
      page: "/blog/beta",
      training: 0,
      search: 0,
      fetch: 0,
      clicked: 1
    });
    // /blog/alpha also took 4 forged ai_fetcher hits. Counting them would inflate
    // fetch to 6 and drag clicks-per-100 down to scanner noise.
    expect(rows.find((row) => row.page === "/blog/alpha")).toEqual({
      page: "/blog/alpha",
      training: 3,
      search: 4,
      fetch: 2,
      clicked: 3
    });
  });

  it("'what AI cites' lists content pages only", async () => {
    const result = await store().citations(IT_SITE, DAYS, 50);
    expect(result.pages.length).toBeGreaterThan(0);
    const nonContent = result.pages.map((page) => page.page).filter((page) => NON_CONTENT.test(page));
    expect(nonContent).toEqual([]);
    // Relabelled, not deleted: 9 ai_search + 7 ai_fetcher hits on robots.txt
    // still have to be visible somewhere.
    expect(result.infra.find((row) => row.page === "/robots.txt")?.hits).toBe(16);
    // A forged fetch on a perfectly normal content path is still not a citation.
    expect(result.pages.find((row) => row.page === "/blog/alpha")).toMatchObject({ fetched: 2, surfaced: 4, clicked: 3 });
  });

  it("'broken pages' contains no traffic from spoofed bots", async () => {
    const result = await store().crawlHealth(IT_SITE, DAYS, 50);
    const scanPaths = ["/.env", "/.aws/credentials", "/firebase-credentials.json"];
    const scans = result.broken.map((row) => row.page).filter((page) => scanPaths.includes(page));
    expect(scans).toEqual([]);
    // The genuinely broken page — verified bot, real content — must be there,
    // and it must be distinguishable from a URL that never existed.
    expect(result.broken.find((row) => row.page === "/about")).toMatchObject({ aiErrors: 5, everOk: true });
    expect(result.broken.find((row) => row.page === "/blog/ghost")).toMatchObject({ aiErrors: 3, everOk: false });
    // Never OK, but for a completely different reason: the UI must be able to
    // tell "no such page" from "the server is failing".
    expect(result.broken.find((row) => row.page === "/blog/sick")).toMatchObject({
      aiErrors: 2,
      sampleStatus: 500,
      everOk: false
    });
  });

  it("a spoofing source is labelled with the identity it used last", async () => {
    const result = await store().security(IT_SITE, HOURS);
    const rotating = result.spoofedSources.find((row) => row.ip === "203.0.113.77");
    expect(rotating).toBeDefined();
    // This IP wore googlebot (5 hits, oldest), claude-user (3), bingbot (1, newest).
    // any(bot_id) picks an arbitrary one; the panel must not guess.
    expect(rotating?.claimedBot).toBe("bingbot");
    expect(rotating?.claimedVariants).toBe(3);
    // A single-mask source keeps a plain label, no phantom rotation.
    const singleMask = result.spoofedSources.find((row) => row.ip === "198.51.100.10");
    expect(singleMask).toMatchObject({ claimedBot: "chatgpt-user", claimedVariants: 1 });
  });

  it("'AI blind spots' counts only sessions that behaved like a browser", async () => {
    const result = await store().crawlHealth(IT_SITE, DAYS, 50);
    const pages = result.blindSpots.map((row) => row.page);

    // One session sweeping 25 paths — never pulled a stylesheet.
    expect(pages.filter((page) => SCANNER_PATHS.includes(page))).toEqual([]);
    // Six one-path sessions from six addresses. This is the shape a public site
    // actually gets, and a per-session path threshold cannot see it.
    expect(pages).not.toContain("/.hidden-config");

    // A forged ai_fetcher hit is not AI coverage — the page is still a blind spot.
    expect(result.blindSpots.find((row) => row.page === "/blog/gamma")).toMatchObject({ humanHits: 3, readers: 3 });
    // A reader whose session also pulled bundles is a reader.
    expect(result.blindSpots.find((row) => row.page === "/blog/delta")).toMatchObject({ humanHits: 1, readers: 1 });
    // ...and a page AI DOES crawl is not a blind spot, however many browsers
    // read it. Bot rows must survive the browser filter to prove that coverage.
    expect(pages).not.toContain("/blog/alpha");
    expect(pages).not.toContain("/");
  });

  it("keeps every page when a site's sensor never sees render assets", async () => {
    // CDN in front of the assets: filtering on browser behaviour would empty the
    // panel instead of cleaning it, so the filter has to switch itself off.
    const result = await store().crawlHealth(IT_SITE_NO_ASSETS, DAYS, 50);
    expect(result.blindSpots.map((row) => row.page)).toEqual(["/only-page"]);
    expect(result.blindSpots[0]).toMatchObject({ humanHits: 2, readers: 2 });
  });
});
