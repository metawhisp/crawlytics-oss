import { afterAll, describe, expect, it } from "vitest";

import { IT_SITE, SCANNER_PATHS, fixtureEvents } from "./fixture.js";
import { clickHouseReady, testClient } from "./harness.js";

const client = clickHouseReady() ? testClient() : null;

afterAll(async () => {
  await client?.close();
});

/** How many fixture rows were sent for the main site. */
function seededEvents(): number {
  return fixtureEvents().filter((event) => event.site_id === IT_SITE).length;
}

async function scalar(query: string): Promise<number> {
  if (!client) {
    throw new Error("no client");
  }
  const result = await client.query({ query, format: "JSONEachRow" });
  const rows = await result.json<{ v: string }>();
  return Number(rows[0]?.v ?? 0);
}

describe.skipIf(!clickHouseReady())("integration harness", () => {
  it("applied every migration", async () => {
    const applied = await scalar("SELECT toString(count()) AS v FROM _migrations");
    expect(applied).toBe(5);
  });

  it("the AI page rollup agrees with the raw events it summarises", async () => {
    // The pages chart reads this rollup instead of scanning raw events twice, so
    // a drift between them would silently misdraw the chart.
    const fromRollup = await scalar(
      `SELECT toString(sum(hits)) AS v FROM daily_page_ai_stats
       WHERE site_id = '${IT_SITE}' AND verification != 'spoofed'`
    );
    const fromEvents = await scalar(
      `SELECT toString(count()) AS v FROM events
       WHERE site_id = '${IT_SITE}' AND actor_type LIKE 'ai_%' AND verification != 'spoofed'`
    );
    expect(fromRollup).toBe(fromEvents);
    expect(fromRollup).toBeGreaterThan(0);

    // The errors column feeds the "was this page ever fine" half of the broken
    // citation alert, so a drift there decides whether someone gets woken up.
    const errorsFromRollup = await scalar(
      `SELECT toString(sum(errors)) AS v FROM daily_page_ai_stats
       WHERE site_id = '${IT_SITE}' AND verification != 'spoofed'`
    );
    const errorsFromEvents = await scalar(
      `SELECT toString(countIf(status >= 400)) AS v FROM events
       WHERE site_id = '${IT_SITE}' AND actor_type LIKE 'ai_%' AND verification != 'spoofed'`
    );
    expect(errorsFromRollup).toBe(errorsFromEvents);
    expect(errorsFromRollup).toBeGreaterThan(0);
  });

  it("seeded the fixture into events", async () => {
    const total = await scalar(`SELECT toString(count()) AS v FROM events WHERE site_id = '${IT_SITE}'`);
    // Counted from the fixture rather than written down: a hard-coded number only
    // says "173 arrived", needs editing every time a row is added, and goes stale
    // silently. This says "everything we sent arrived".
    expect(total).toBe(seededEvents());
  });

  it("materialized views filled the rollups", async () => {
    const daily = await scalar(`SELECT toString(sum(hits)) AS v FROM daily_bot_stats WHERE site_id = '${IT_SITE}'`);
    // Must equal the raw count above: daily_bot_stats has no WHERE, so any gap
    // means the materialized view dropped rows on the way in.
    expect(daily).toBe(seededEvents());
  });

  it("kept the scanner sweep inside a single session", async () => {
    const paths = await scalar(
      `SELECT toString(uniq(path_group)) AS v FROM events WHERE site_id = '${IT_SITE}' AND session_id = 900001`
    );
    expect(paths).toBe(SCANNER_PATHS.length);
  });

  it("gave one IP three different bot identities", async () => {
    const identities = await scalar(
      `SELECT toString(uniq(bot_id)) AS v FROM events WHERE site_id = '${IT_SITE}' AND bot_ip = '203.0.113.77'`
    );
    expect(identities).toBe(3);
  });
});
