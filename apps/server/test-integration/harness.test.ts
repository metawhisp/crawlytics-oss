import { afterAll, describe, expect, it } from "vitest";

import { IT_SITE, SCANNER_PATHS } from "./fixture.js";
import { clickHouseReady, testClient } from "./harness.js";

const client = clickHouseReady() ? testClient() : null;

afterAll(async () => {
  await client?.close();
});

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
    expect(applied).toBe(3);
  });

  it("seeded the fixture into events", async () => {
    const total = await scalar(`SELECT toString(count()) AS v FROM events WHERE site_id = '${IT_SITE}'`);
    // 12 alpha + 4 spoofed alpha + 1 beta + 7 about + 3 ghost + 2 sick
    // + 13 spoofed scan + 16 robots + 25 scanner + 3 gamma + 3 gamma-css
    // + 1 spoofed gamma + 6 distributed scan + 21 reader-with-assets
    // + 9 rotating-ua
    expect(total).toBe(128);
  });

  it("materialized views filled the rollups", async () => {
    const daily = await scalar(`SELECT toString(sum(hits)) AS v FROM daily_bot_stats WHERE site_id = '${IT_SITE}'`);
    expect(daily).toBe(128);
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
