import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

import {
  compileRegistry,
  type AiRobotsEntry,
  type BotRegistryEntry,
  type CrawlerUserAgentEntry,
  type CustomBotsDocument
} from "./index.js";

const aiRobotsUrl = "https://raw.githubusercontent.com/ai-robots-txt/ai.robots.txt/main/robots.json";
const crawlerUserAgentsUrl =
  "https://raw.githubusercontent.com/monperrus/crawler-user-agents/master/crawler-user-agents.json";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultCustomBotsPath = resolve(packageRoot, "src/custom-bots.yaml");
const defaultOutputPath = resolve(packageRoot, "bots.compiled.json");
const dataDir = resolve(packageRoot, "data");
const aiRobotsSnapshotPath = resolve(dataDir, "robots.json");
const crawlerUserAgentsSnapshotPath = resolve(dataDir, "crawler-user-agents.json");

export interface BuildRegistryOptions {
  customBotsPath?: string;
  outputPath?: string;
  /**
   * When true, re-fetches upstream sources over the network and refreshes the
   * committed snapshots in data/. By default the build is offline-reproducible:
   * it reads the snapshots and only falls back to the network when a snapshot
   * is missing.
   */
  update?: boolean;
}

export async function buildRegistrySnapshot(
  options: BuildRegistryOptions = {}
): Promise<BotRegistryEntry[]> {
  const update = options.update ?? false;

  const [aiRobots, crawlerUserAgents, customBots] = await Promise.all([
    loadSource<Record<string, AiRobotsEntry>>(aiRobotsSnapshotPath, aiRobotsUrl, update),
    loadSource<CrawlerUserAgentEntry[]>(crawlerUserAgentsSnapshotPath, crawlerUserAgentsUrl, update),
    readCustomBots(options.customBotsPath ?? defaultCustomBotsPath)
  ]);

  const compiled = compileRegistry({
    aiRobots,
    crawlerUserAgents,
    customBots
  });

  const outputPath = options.outputPath ?? defaultOutputPath;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(compiled, null, 2)}\n`);

  return compiled;
}

async function loadSource<T>(snapshotPath: string, url: string, update: boolean): Promise<T> {
  if (!update && existsSync(snapshotPath)) {
    return JSON.parse(await readFile(snapshotPath, "utf8")) as T;
  }

  const fetched = await fetchJson<T>(url);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(fetched, null, 2)}\n`);
  return fetched;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${String(response.status)} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function readCustomBots(path: string): Promise<BotRegistryEntry[]> {
  const raw = await readFile(path, "utf8");
  const parsed = parse(raw) as CustomBotsDocument;
  return parsed.bots ?? [];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildRegistrySnapshot({ update: process.argv.includes("--update") });
}
