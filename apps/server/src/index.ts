import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createIpVerifier } from "@crawlytics/detector";
import { loadCompiledBots } from "@crawlytics/registry";

import { deliverWebhook } from "./alerts/deliver.js";
import { createAlertsRunner } from "./alerts/runner.js";
import { buildApp, resolveDashboardEnabled, resolveDevOverride } from "./app.js";
import { createBatcher } from "./batcher.js";
import { createChClient, createChMigrationClient, createChSink } from "./clickhouse.js";
import { loadConfig } from "./config.js";
import { createFileStore, createMemoryStore, seedFromEnv } from "./metadata/index.js";
import { loadMigrations, runMigrations } from "./migrate.js";
import { createEnricher } from "./pipeline/enrich.js";
import { createStatsStore } from "./stats.js";

export { buildApp } from "./app.js";
export { createBatcher } from "./batcher.js";
export { createEnricher } from "./pipeline/enrich.js";

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const config = loadConfig();
  const bots = loadCompiledBots();

  const client = createChClient(config.clickhouse);
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  await runMigrations(createChMigrationClient(client), await loadMigrations(migrationsDir));

  const verifier = createIpVerifier({ entries: bots });
  await verifier.refresh().catch(() => undefined);

  const sink = createChSink(client);
  const enrich = createEnricher({ bots, secret: config.ipHashSecret, verifier });
  const batcher = createBatcher({
    process: async (pending) => {
      const rows = await Promise.all(pending.map(({ siteId, event }) => enrich(siteId, event)));
      await sink.insert(rows);
    },
    onError: (error) => {
      console.error("flush failed:", error);
    }
  });

  const metadataFile = process.env["CRAWLYTICS_METADATA_FILE"];
  const metadata = metadataFile ? createFileStore(metadataFile) : createMemoryStore();
  await seedFromEnv(metadata);

  // Open-source self-host: the dashboard is NOT license-gated — it's enabled by
  // default. In production it still requires TC_DASHBOARD_PASSWORD (fail-closed),
  // so a public instance is never left open without a password.
  const dashboardPassword = process.env["TC_DASHBOARD_PASSWORD"];
  const isProduction = process.env["NODE_ENV"] === "production";
  const devOverride = resolveDevOverride();
  const dashboardEnabled = resolveDashboardEnabled({
    licensed: true,
    hasPassword: Boolean(dashboardPassword),
    isProduction,
    devOverride
  });
  if (isProduction && !dashboardPassword) {
    console.warn("dashboard disabled: set TC_DASHBOARD_PASSWORD to serve the dashboard");
  }

  // The full image ships the built SPA → serve the dashboard shell (license
  // entry) even while unlicensed. The headless image has no public/ → ingest only.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  const serveDashboard = existsSync(publicDir) || dashboardEnabled;
  const app = buildApp({
    metadata,
    batcher,
    stats: createStatsStore(client),
    chClient: client,
    checkReady: () => client.ping().then((result) => result.success).catch(() => false),
    ...(dashboardPassword ? { dashboardPassword } : {}),
    dashboardEnabled,
    serveDashboard,
    isProduction,
    devOverride,
    publicDir,
    logger: true
  });

  // Alerts scheduler — a no-op until the owner saves a webhook URL in Setup
  // (the runner re-checks the stored config every tick; default is OFF, the
  // server never posts anywhere out of the box). Fail-open: a broken tick logs
  // and skips inside tick(), it never crashes the server.
  const alertsIntervalMs = Math.min(
    Math.max(Number(process.env["CRAWLYTICS_ALERTS_INTERVAL_MS"]) || 300_000, 60_000),
    3_600_000
  );
  const alertsRunner = createAlertsRunner({
    metadata,
    client,
    deliver: deliverWebhook,
    // the rule look-back covers ~2 intervals so events between ticks aren't missed
    windowMinutes: Math.max(Math.ceil((alertsIntervalMs / 60_000) * 2), 5)
  });
  const alertsTimer = setInterval(() => {
    void alertsRunner.tick();
  }, alertsIntervalMs);
  alertsTimer.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(alertsTimer);
    await app.close();
    await batcher.stop();
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port: config.port, host: config.host });
}
