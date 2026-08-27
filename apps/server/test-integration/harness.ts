import { createClient } from "@clickhouse/client";
import type { ClickHouseClient } from "@clickhouse/client";
import { inject } from "vitest";

import { createStatsStore, type StatsStore } from "../src/stats.js";

/** False when docker was unavailable at global setup; suites skip themselves. */
export function clickHouseReady(): boolean {
  return inject("chUrl") !== "";
}

export function testClient(): ClickHouseClient {
  return createClient({
    url: inject("chUrl"),
    database: inject("chDatabase"),
    username: inject("chUser"),
    password: inject("chPassword"),
    clickhouse_settings: { async_insert: 0 }
  });
}

export function testStats(): StatsStore {
  return createStatsStore(testClient());
}
