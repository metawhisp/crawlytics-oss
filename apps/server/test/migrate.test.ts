import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { formatChTimestamp } from "../src/clickhouse.js";
import { loadMigrations, runMigrations } from "../src/migrate.js";

describe("loadMigrations", () => {
  it("loads .sql files in name order and splits statements", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc-migrations-"));
    await writeFile(join(dir, "0002_second.sql"), "CREATE TABLE b (x UInt8) ENGINE = Memory;\n");
    await writeFile(
      join(dir, "0001_first.sql"),
      "-- events table\nCREATE TABLE a (x UInt8) ENGINE = Memory;\n\nCREATE TABLE a2 (y UInt8) ENGINE = Memory;\n"
    );

    const migrations = await loadMigrations(dir);
    expect(migrations.map((migration) => migration.name)).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(migrations[0]?.statements).toHaveLength(2);
    expect(migrations[0]?.statements[0]).toContain("CREATE TABLE a ");
    expect(migrations[1]?.statements).toHaveLength(1);
  });
});

describe("runMigrations", () => {
  function fakeClient(applied: string[] = []) {
    const executed: string[] = [];
    return {
      executed,
      command: vi.fn((sql: string) => {
        executed.push(sql);
        return Promise.resolve();
      }),
      fetchAppliedNames: vi.fn(() => Promise.resolve(applied)),
      recordApplied: vi.fn(() => Promise.resolve())
    };
  }

  const migrations = [
    { name: "0001_a.sql", statements: ["CREATE TABLE a"] },
    { name: "0002_b.sql", statements: ["CREATE TABLE b", "CREATE VIEW bv"] }
  ];

  it("applies pending migrations in order and records them", async () => {
    const client = fakeClient();
    await runMigrations(client, migrations);
    expect(client.executed).toEqual(["CREATE TABLE a", "CREATE TABLE b", "CREATE VIEW bv"]);
    expect(client.recordApplied).toHaveBeenCalledTimes(2);
  });

  it("skips already applied migrations", async () => {
    const client = fakeClient(["0001_a.sql"]);
    await runMigrations(client, migrations);
    expect(client.executed).toEqual(["CREATE TABLE b", "CREATE VIEW bv"]);
    expect(client.recordApplied).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when everything is applied", async () => {
    const client = fakeClient(["0001_a.sql", "0002_b.sql"]);
    await runMigrations(client, migrations);
    expect(client.executed).toEqual([]);
  });
});

describe("formatChTimestamp", () => {
  it("formats epoch ms as ClickHouse DateTime64(3) UTC", () => {
    expect(formatChTimestamp(Date.UTC(2026, 5, 10, 3, 22, 1, 7))).toBe("2026-06-10 03:22:01.007");
  });
});
