import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createClient } from "@clickhouse/client";
import type { TestProject } from "vitest/node";

import { createChMigrationClient, createChSink } from "../src/clickhouse.js";
import { loadMigrations, runMigrations } from "../src/migrate.js";
import { fixtureEvents } from "./fixture.js";

const run = promisify(execFile);

const IMAGE = "clickhouse/clickhouse-server:25.5-alpine";
const DATABASE = "crawlytics_it";
const USER = "crawlytics_it";
const PASSWORD = "crawlytics_it";
const READY_ATTEMPTS = 60;
const READY_DELAY_MS = 500;

declare module "vitest" {
  interface ProvidedContext {
    /** "" when docker is unavailable — the suites skip themselves. */
    chUrl: string;
    chDatabase: string;
    chUser: string;
    chPassword: string;
  }
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    return true;
  } catch {
    return false;
  }
}

/** A port the kernel just handed out — raced only by something else grabbing it
 * in the same millisecond, which docker would then report as a bind failure. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    // 127.0.0.1 only: this container must never be reachable from outside the host.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => {
          reject(new Error("could not determine a free port"));
        });
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitForPing(url: string): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${url}/ping`);
      if (response.ok) {
        return;
      }
    } catch {
      // container still booting
    }
    await new Promise((resolve) => setTimeout(resolve, READY_DELAY_MS));
  }
  throw new Error(`ClickHouse at ${url} did not become ready`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!(await dockerAvailable())) {
    project.provide("chUrl", "");
    project.provide("chDatabase", DATABASE);
    project.provide("chUser", USER);
    project.provide("chPassword", PASSWORD);
    console.warn("[integration] docker is not available — ClickHouse suites will be skipped");
    return () => Promise.resolve();
  }

  const port = await freePort();
  const name = `crawlytics-it-${String(port)}`;
  // -p 127.0.0.1:PORT:8123 binds loopback ONLY. Never publish this container.
  const { stdout } = await run("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    `127.0.0.1:${String(port)}:8123`,
    "-e",
    `CLICKHOUSE_DB=${DATABASE}`,
    "-e",
    `CLICKHOUSE_USER=${USER}`,
    "-e",
    `CLICKHOUSE_PASSWORD=${PASSWORD}`,
    "-e",
    "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
    IMAGE
  ]);
  const containerId = stdout.trim();
  const url = `http://127.0.0.1:${String(port)}`;

  const teardown = async (): Promise<void> => {
    await run("docker", ["rm", "-f", containerId]);
  };

  try {
    await waitForPing(url);

    // async_insert is off here (the production client sets it): tests must see
    // their own writes on the very next SELECT.
    const client = createClient({
      url,
      database: DATABASE,
      username: USER,
      password: PASSWORD,
      clickhouse_settings: { async_insert: 0 }
    });

    const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
    await runMigrations(createChMigrationClient(client), await loadMigrations(migrationsDir));
    await createChSink(client).insert(fixtureEvents());
    await client.close();
  } catch (error) {
    await teardown();
    throw error;
  }

  project.provide("chUrl", url);
  project.provide("chDatabase", DATABASE);
  project.provide("chUser", USER);
  project.provide("chPassword", PASSWORD);

  return teardown;
}
