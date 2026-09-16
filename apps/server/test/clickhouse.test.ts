import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";

import { createChMigrationClient, createChSink } from "../src/clickhouse.js";

interface CapturedInsert {
  table: string;
  clickhouse_settings?: Record<string, unknown>;
}

function fakeClient() {
  const inserts: CapturedInsert[] = [];
  const client = {
    command: vi.fn(() => Promise.resolve()),
    query: vi.fn(() => Promise.resolve({ json: () => Promise.resolve([]) })),
    insert: vi.fn((options: CapturedInsert) => {
      inserts.push(options);
      return Promise.resolve();
    })
  } as unknown as ClickHouseClient;
  return { client, inserts };
}

describe("createChMigrationClient", () => {
  it("records an applied migration synchronously", async () => {
    // The shared client runs async_insert with wait_for_async_insert=0 so ingest
    // never waits on disk. Measured on ClickHouse 25.5: a row written that way is
    // NOT visible on the next SELECT (it appeared ~1.5s later), while the
    // INSERT ... SELECT inside a migration IS synchronous. A container killed
    // between a migration's backfill and its "applied" row therefore re-runs that
    // backfill on the next boot, and a SummingMergeTree adds the history to itself.
    const { client, inserts } = fakeClient();
    await createChMigrationClient(client).recordApplied("0005_x.sql");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe("_migrations");
    expect(inserts[0]?.clickhouse_settings).toMatchObject({ async_insert: 0 });
  });

  it("waits for the ingest write to be durable before calling it done", async () => {
    // This assertion used to require the opposite — no settings at all, so the
    // shared setting of the day applied, which was wait_for_async_insert: 0
    // (the factory has since been moved to 1 as well). ClickHouse then
    // acknowledged the rows as soon as they were in RAM, a later flush error
    // never reached the batcher, and a crash before that flush lost them. The
    // batcher can only retry what it is told failed, so the sink has to wait.
    // Changed deliberately: this is a decision reversed, not a test bent to fit.
    const { client, inserts } = fakeClient();
    await createChSink(client).insert([]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe("events");
    expect(inserts[0]?.clickhouse_settings).toMatchObject({ wait_for_async_insert: 1 });
  });

  it("keeps batching on — waiting is not the same as writing one row at a time", async () => {
    // async_insert stays 1: ClickHouse still groups the inserts, we simply stop
    // being told they are done before they are.
    const { client, inserts } = fakeClient();
    await createChSink(client).insert([]);
    expect(inserts[0]?.clickhouse_settings).toMatchObject({ async_insert: 1 });
  });
});
