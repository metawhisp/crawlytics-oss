/**
 * Local visual check: boots the real dashboard against the integration fixture.
 * Loopback only, no license, no password — never deploy or expose this.
 *
 *   node --experimental-strip-types is not enough (NodeNext .js specifiers), so
 *   this is bundled by scripts/preview.sh before running.
 */
import { createClient } from "@clickhouse/client";

import { buildApp } from "../src/app.js";
import { createChMigrationClient, createChSink } from "../src/clickhouse.js";
import { createMemoryStore } from "../src/metadata/index.js";
import { loadMigrations, runMigrations } from "../src/migrate.js";
import { createStatsStore } from "../src/stats.js";
import { fixtureEvents, IT_SITE } from "./fixture.js";

const url = process.env["CH_URL"] ?? "";
const port = Number(process.env["PREVIEW_PORT"] ?? "0");
const migrationsDir = process.env["MIGRATIONS_DIR"] ?? "";
const publicDir = process.env["PUBLIC_DIR"] ?? "";

const client = createClient({
  url,
  database: "crawlytics_it",
  username: "crawlytics_it",
  password: "crawlytics_it",
  clickhouse_settings: { async_insert: 0 }
});

await runMigrations(createChMigrationClient(client), await loadMigrations(migrationsDir));
await createChSink(client).insert(fixtureEvents());

const metadata = createMemoryStore();
await metadata.createSite({ id: IT_SITE, domain: "it.test" });

const app = buildApp({
  metadata,
  batcher: { push: () => true, size: 0 },
  stats: createStatsStore(client),
  chClient: client,
  dashboardEnabled: true,
  serveDashboard: true,
  publicDir
});

await app.listen({ host: "127.0.0.1", port });
console.log(`preview on http://127.0.0.1:${String(port)} site=${IT_SITE}`);
