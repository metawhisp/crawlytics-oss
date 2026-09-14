import { fileURLToPath } from "node:url";

import { createClient } from "@clickhouse/client";
import type { ClickHouseClient } from "@clickhouse/client";
import type { EnrichedEvent } from "@crawlytics/shared";
import { afterAll, describe, expect, inject, it } from "vitest";

import { createChMigrationClient, createChSink } from "../src/clickhouse.js";
import { loadMigrations, runMigrations } from "../src/migrate.js";
import { clickHouseReady } from "./harness.js";

/**
 * Migrations must survive being run twice. The shared harness cannot prove that:
 * it seeds the fixture AFTER migrating (global-setup.ts), so there the rollup is
 * filled by the materialized view and the backfill always runs over an empty
 * events table. And truncating _migrations in the shared database would break
 * every other suite reading it.
 *
 * So each scenario here builds its own database inside the same throwaway
 * container, seeds it, and then re-runs the migrations over real data.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const DAY_MINUTES = 24 * 60;

/** Older than the 365-day backfill bound and than anything the API can ask for. */
const ANCIENT_MINUTES = 366 * DAY_MINUTES;

const clients: ClickHouseClient[] = [];

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
});

function connect(database: string, prodSettings: boolean): ClickHouseClient {
  const client = createClient({
    url: inject("chUrl"),
    database,
    username: inject("chUser"),
    password: inject("chPassword"),
    // The production client is async_insert with wait_for_async_insert=0; running
    // migrations through it is the only way these tests exercise the same
    // configuration the real server uses.
    clickhouse_settings: prodSettings ? { async_insert: 1, wait_for_async_insert: 0 } : { async_insert: 0 }
  });
  clients.push(client);
  return client;
}

interface MiniRow {
  path: string;
  actorType: string;
  status?: number;
  verification?: string;
  minutesAgo?: number;
}

/**
 * Small on purpose, but every row earns its place:
 * - /doc carries a 200 and a 404 on the SAME page and day, so `sum(errors)` can
 *   never agree by both sides being zero.
 * - one row is status 400 exactly. Without it, mutating the backfill's
 *   `status >= 400` into `status > 400` changes nothing and the errors check
 *   proves nothing — which is what the first run of this suite showed.
 * - /ancient is older than the backfill bound: the view accepts it, a rebuild
 *   must drop it.
 * - the human row must never reach an AI-only rollup.
 */
const MINI_ROWS: MiniRow[] = [
  { path: "/doc", actorType: "ai_fetcher", status: 200, verification: "verified", minutesAgo: 60 },
  { path: "/doc", actorType: "ai_fetcher", status: 404, verification: "verified", minutesAgo: 61 },
  { path: "/doc", actorType: "ai_search", status: 500, verification: "na", minutesAgo: 62 },
  { path: "/doc", actorType: "ai_search", status: 400, verification: "na", minutesAgo: 66 },
  { path: "/blog", actorType: "ai_training", status: 200, verification: "spoofed", minutesAgo: 63 },
  { path: "/blog", actorType: "ai_training", status: 200, verification: "verified", minutesAgo: 64 },
  { path: "/ancient", actorType: "ai_training", status: 200, verification: "verified", minutesAgo: ANCIENT_MINUTES },
  { path: "/", actorType: "human", status: 200, verification: "na", minutesAgo: 65 }
];

function miniFixture(site: string): EnrichedEvent[] {
  const now = Date.now();
  return MINI_ROWS.map((row, index) => ({
    site_id: site,
    ts: now - (row.minutesAgo ?? 60) * 60_000,
    ip_hash: String(2_000_000 + index),
    bot_ip: "",
    method: "GET",
    path: row.path,
    path_group: row.path,
    query: "",
    status: row.status ?? 200,
    bytes: 512,
    response_ms: 10,
    ua: "mini",
    actor_type: row.actorType,
    bot_id: row.actorType === "human" ? "" : "minibot",
    operator: "",
    verification: row.verification ?? "na",
    referer: "",
    ai_referral: "",
    topic_id: "",
    country: "US",
    asn: 15169,
    as_org: "TEST-AS",
    session_id: String(600_000 + index),
    ingest_source: "api"
  }));
}

async function scalar(client: ClickHouseClient, query: string): Promise<number> {
  const result = await client.query({ query, format: "JSONEachRow" });
  const rows = await result.json<{ v: string }>();
  return Number(rows[0]?.v ?? 0);
}

/** The rollup restricted to what the API can actually ask for (days <= 365). */
async function boundedRollup(client: ClickHouseClient, site: string) {
  return {
    hits: await scalar(
      client,
      `SELECT toString(sum(hits)) AS v FROM daily_page_ai_stats
       WHERE site_id = '${site}' AND date >= today() - 365`
    ),
    errors: await scalar(
      client,
      `SELECT toString(sum(errors)) AS v FROM daily_page_ai_stats
       WHERE site_id = '${site}' AND date >= today() - 365`
    ),
    // uniqExact over the full sort key, not count(): count() on a SummingMergeTree
    // depends on how many parts happen to be unmerged.
    keys: await scalar(
      client,
      `SELECT toString(uniqExact((site_id, date, path_group, actor_type, verification))) AS v
       FROM daily_page_ai_stats WHERE site_id = '${site}' AND date >= today() - 365`
    )
  };
}

/**
 * Rows in the rollup that the source of truth does not produce, plus rows it
 * produces that the rollup does not have. Zero, or the rebuild is wrong.
 *
 * Sums and a key COUNT are not enough: swap actor_type and verification in the
 * backfill and both are identical while every filter downstream reads the wrong
 * column. This compares the keys themselves, with their values.
 */
async function rollupVsEvents(client: ClickHouseClient, site: string): Promise<number> {
  const rollup = `
    SELECT toString(date) AS d, path_group AS p, toString(actor_type) AS a,
           toString(verification) AS v, sum(hits) AS h, sum(errors) AS e
    FROM daily_page_ai_stats WHERE site_id = '${site}' AND date >= today() - 365
    GROUP BY d, p, a, v`;
  const events = `
    SELECT toString(toDate(ts)) AS d, path_group AS p, toString(actor_type) AS a,
           toString(verification) AS v, count() AS h, countIf(status >= 400) AS e
    FROM events
    WHERE site_id = '${site}' AND actor_type LIKE 'ai_%' AND toDate(ts) >= today() - 365
    GROUP BY d, p, a, v`;
  return scalar(
    client,
    `SELECT toString(
       (SELECT count() FROM (${rollup} EXCEPT ${events}))
       + (SELECT count() FROM (${events} EXCEPT ${rollup}))
     ) AS v`
  );
}

/** The same numbers straight from the source of truth. */
async function boundedEvents(client: ClickHouseClient, site: string) {
  return {
    hits: await scalar(
      client,
      `SELECT toString(count()) AS v FROM events
       WHERE site_id = '${site}' AND actor_type LIKE 'ai_%' AND toDate(ts) >= today() - 365`
    ),
    errors: await scalar(
      client,
      `SELECT toString(countIf(status >= 400)) AS v FROM events
       WHERE site_id = '${site}' AND actor_type LIKE 'ai_%' AND toDate(ts) >= today() - 365`
    ),
    keys: await scalar(
      client,
      `SELECT toString(uniqExact((site_id, toDate(ts), path_group, actor_type, verification))) AS v
       FROM events WHERE site_id = '${site}' AND actor_type LIKE 'ai_%' AND toDate(ts) >= today() - 365`
    )
  };
}

async function ancientRows(client: ClickHouseClient, site: string): Promise<number> {
  return scalar(
    client,
    `SELECT toString(sum(hits)) AS v FROM daily_page_ai_stats
     WHERE site_id = '${site}' AND path_group = '/ancient'`
  );
}

async function viewExists(client: ClickHouseClient): Promise<number> {
  return scalar(
    client,
    "SELECT toString(count()) AS v FROM system.tables WHERE database = currentDatabase() AND name = 'daily_page_ai_stats_mv'"
  );
}

async function makeDatabase(name: string): Promise<{ prod: ClickHouseClient; sync: ClickHouseClient }> {
  const root = connect("default", false);
  // A plain user needs the right to do this; the throwaway container grants it
  // through CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT.
  await root.command({ query: `CREATE DATABASE IF NOT EXISTS ${name}` });
  return { prod: connect(name, true), sync: connect(name, false) };
}

describe.skipIf(!clickHouseReady())("migrations are safe to run twice", () => {
  it("re-running every migration over real data changes nothing", async () => {
    const site = "mig_repeat";
    const { prod, sync } = await makeDatabase("crawlytics_it_mig");
    const migrations = await loadMigrations(MIGRATIONS_DIR);

    await runMigrations(createChMigrationClient(prod), migrations);
    // One insert: several would leave several parts, and count()-style assertions
    // would then depend on background merges.
    await createChSink(sync).insert(miniFixture(site));

    const before = await boundedRollup(sync, site);
    expect(before).toEqual(await boundedEvents(sync, site));
    expect(await rollupVsEvents(sync, site)).toBe(0);
    expect(before.hits).toBeGreaterThan(0);
    expect(before.errors).toBeGreaterThan(0);
    // The view has no date filter, so it accepted the ancient row.
    expect(await ancientRows(sync, site)).toBe(1);

    // Exactly what a container killed before its bookkeeping row was durable
    // would look like on the next boot.
    await sync.command({ query: "TRUNCATE TABLE _migrations" });
    await runMigrations(createChMigrationClient(prod), migrations);

    expect(await boundedRollup(sync, site)).toEqual(before);
    expect(await rollupVsEvents(sync, site)).toBe(0);
    expect(await scalar(sync, "SELECT toString(count()) AS v FROM _migrations")).toBe(migrations.length);
    expect(await viewExists(sync)).toBe(1);
    // A rebuild is bounded to what the API can ask for; the view was not.
    expect(await ancientRows(sync, site)).toBe(0);

    // And the view still feeds the table it was just recreated over.
    await createChSink(sync).insert(
      miniFixture(site).filter((event) => event.path_group === "/doc" && event.status === 404)
    );
    const after = await boundedRollup(sync, site);
    expect(after.hits).toBe(before.hits + 1);
    expect(after.errors).toBe(before.errors + 1);
  });

  it("upgrades a database that already has the first version of the rollup", async () => {
    // The production trajectory. On a clean database ALTER ... ADD COLUMN is a
    // guaranteed no-op, so without this scenario the one statement that has to
    // work on the live instance is never executed by any test.
    const site = "mig_upgrade";
    const { prod, sync } = await makeDatabase("crawlytics_it_prod");
    const all = await loadMigrations(MIGRATIONS_DIR);
    const upTo0003 = all.filter((migration) => migration.name < "0004");

    await runMigrations(createChMigrationClient(prod), upTo0003);

    // Recreate the shipped 0004 by hand: six columns, no errors, view included.
    await sync.command({
      query: `CREATE TABLE daily_page_ai_stats (
                site_id LowCardinality(String), date Date, path_group String,
                actor_type LowCardinality(String), verification LowCardinality(String), hits UInt64
              ) ENGINE = SummingMergeTree
              ORDER BY (site_id, date, path_group, actor_type, verification)`
    });
    await sync.command({
      query: `CREATE MATERIALIZED VIEW daily_page_ai_stats_mv TO daily_page_ai_stats AS
              SELECT site_id, toDate(ts) AS date, path_group, actor_type, verification, count() AS hits
              FROM events WHERE actor_type LIKE 'ai_%'
              GROUP BY site_id, date, path_group, actor_type, verification`
    });
    await sync.insert({
      table: "_migrations",
      format: "JSONEachRow",
      values: [{ name: "0004_page_ai_rollup.sql" }]
    });
    await createChSink(sync).insert(miniFixture(site));
    expect(await scalar(sync, `SELECT toString(sum(hits)) AS v FROM daily_page_ai_stats WHERE site_id = '${site}'`)).toBeGreaterThan(0);

    await runMigrations(createChMigrationClient(prod), all);

    expect(await boundedRollup(sync, site)).toEqual(await boundedEvents(sync, site));
    expect(await rollupVsEvents(sync, site)).toBe(0);
    expect(await viewExists(sync)).toBe(1);
    expect(await ancientRows(sync, site)).toBe(0);
    expect(
      await scalar(
        sync,
        "SELECT toString(count()) AS v FROM system.columns WHERE database = currentDatabase() AND table = 'daily_page_ai_stats' AND name = 'errors'"
      )
    ).toBe(1);
  });
});
