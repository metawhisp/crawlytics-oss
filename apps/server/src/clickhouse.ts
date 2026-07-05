import { createClient } from "@clickhouse/client";
import type { ClickHouseClient } from "@clickhouse/client";

import type { EnrichedEvent } from "@crawlytics/shared";

import type { MigrationClient } from "./migrate.js";

export interface ClickHouseOptions {
  url: string;
  database: string;
  username: string;
  password: string;
}

export interface EventSink {
  insert(rows: EnrichedEvent[]): Promise<void>;
}

/** Formats epoch ms as ClickHouse DateTime64(3) literal in UTC. */
export function formatChTimestamp(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 23).replace("T", " ");
}

export function createChClient(options: ClickHouseOptions): ClickHouseClient {
  return createClient({
    url: options.url,
    database: options.database,
    username: options.username,
    password: options.password,
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0
    }
  });
}

export function createChSink(client: ClickHouseClient): EventSink {
  return {
    async insert(rows: EnrichedEvent[]): Promise<void> {
      await client.insert({
        table: "events",
        format: "JSONEachRow",
        values: rows.map((row) => ({ ...row, ts: formatChTimestamp(row.ts) }))
      });
    }
  };
}

export function createChMigrationClient(client: ClickHouseClient): MigrationClient {
  return {
    async command(sql: string): Promise<void> {
      await client.command({ query: sql });
    },
    async fetchAppliedNames(): Promise<string[]> {
      await client.command({
        query:
          "CREATE TABLE IF NOT EXISTS _migrations (name String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY name"
      });
      const result = await client.query({ query: "SELECT name FROM _migrations", format: "JSONEachRow" });
      const rows = await result.json<{ name: string }>();
      return rows.map((row) => row.name);
    },
    async recordApplied(name: string): Promise<void> {
      await client.insert({ table: "_migrations", format: "JSONEachRow", values: [{ name }] });
    }
  };
}
