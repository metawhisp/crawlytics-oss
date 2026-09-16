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
      // Batch, and wait for the batch to be written. The old default here was
      // wait_for_async_insert: 0 — fire and forget — and both writers that exist
      // today override it per call anyway. Leaving it at 0 would mean the next
      // writer someone adds inherits silent loss by default; the default should
      // be the safe one, and the two deliberate exceptions stay explicit.
      async_insert: 1,
      wait_for_async_insert: 1
    }
  });
}

export function createChSink(client: ClickHouseClient): EventSink {
  return {
    async insert(rows: EnrichedEvent[]): Promise<void> {
      // Stated per call even though the factory now agrees, because this is the
      // one path where waiting is not optional: ClickHouse used to acknowledge
      // these rows as soon as they were in RAM, so a later flush error never
      // reached the batcher and a crash before that flush lost them with nobody
      // the wiser. The batcher can only retry what it is told failed.
      //
      // async_insert stays on: ClickHouse still groups the inserts. We only stop
      // being told they are done before they are.
      await client.insert({
        table: "events",
        format: "JSONEachRow",
        values: rows.map((row) => ({ ...row, ts: formatChTimestamp(row.ts) })),
        clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 }
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
      // Synchronously, overriding the shared async_insert above for this one row.
      // Measured on ClickHouse 25.5: a row written with wait_for_async_insert=0 is
      // not visible on the next SELECT, while the INSERT ... SELECT inside a
      // migration is. Without this override a container killed between a
      // migration's backfill and its bookkeeping row re-runs that backfill on the
      // next boot — and a SummingMergeTree adds the history to itself.
      await client.insert({
        table: "_migrations",
        format: "JSONEachRow",
        values: [{ name }],
        clickhouse_settings: { async_insert: 0 }
      });
    }
  };
}
