import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Migration {
  name: string;
  statements: string[];
}

export interface MigrationClient {
  command(sql: string): Promise<void>;
  fetchAppliedNames(): Promise<string[]>;
  recordApplied(name: string): Promise<void>;
}

/** Loads .sql files (sorted by name); statements are separated by ";" at end of line. */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const raw = await readFile(join(dir, file), "utf8");
    const statements = raw
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => stripComments(statement).trim())
      .filter((statement) => statement.length > 0);
    migrations.push({ name: file, statements });
  }
  return migrations;
}

export async function runMigrations(client: MigrationClient, migrations: Migration[]): Promise<void> {
  const applied = new Set(await client.fetchAppliedNames());
  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      continue;
    }
    for (const statement of migration.statements) {
      await client.command(statement);
    }
    await client.recordApplied(migration.name);
  }
}

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}
