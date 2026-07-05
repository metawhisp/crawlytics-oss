#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  formatImportSummary,
  importLogFile,
  type ImportLogFileOptions,
  type ImportPoster
} from "./import.js";
import { renderSystemdUnit, type RenderSystemdUnitOptions } from "./systemd.js";
import { tailLogFile, type TailLogFileOptions } from "./tail.js";
import type { LogFormat } from "./types.js";

export type { LogFormat, RawLogEvent } from "./types.js";
export { formatImportSummary, importLogFile, type ImportPoster, type ImportSummary } from "./import.js";
export { INGEST_BATCH_MAX, postEvents, type FetchLike, type PostEventsSummary } from "./post.js";
export { renderSystemdUnit, type RenderSystemdUnitOptions } from "./systemd.js";
export {
  tailLogFile,
  type TailLogFileHandle,
  type TailLogFileOptions,
  type TailPoster,
  type TailSummary
} from "./tail.js";
export {
  parseApache,
  parseCaddyJson,
  parseCloudflareNdjson,
  parseJsonl,
  parseLine,
  parseNginxCombined,
  parseNginxJson
} from "./parsers/index.js";

const LOG_FORMATS = [
  "apache",
  "nginx-combined",
  "nginx-json",
  "caddy-json",
  "cloudflare-ndjson",
  "jsonl"
] as const satisfies readonly LogFormat[];

const USAGE =
  [
    "Usage:",
    "  crawlytics import --key <ingestKey> --url <ingestApiUrl> --format <fmt> --file <path>",
    "  crawlytics tail --key <ingestKey> --url <ingestApiUrl> --format <fmt> --file <path> [--interval <ms>]",
    "  crawlytics systemd --key <ingestKey> --url <ingestApiUrl> --format <fmt> --file <path> [--interval <ms>]"
  ].join("\n");

interface CliDependencies {
  abortSignal?: AbortSignal;
  cliPath?: string;
  nodePath?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
  poster?: ImportPoster;
}

interface WritableLike {
  write(chunk: string): unknown;
}

class CliUsageError extends Error {}

type ParsedCliCommand =
  | { kind: "import"; options: ImportLogFileOptions }
  | { kind: "systemd"; options: Omit<RenderSystemdUnitOptions, "cliPath" | "nodePath"> }
  | { kind: "tail"; options: TailLogFileOptions };

interface ParsedFlagValues {
  file: string;
  format: LogFormat;
  key: string;
  url: string;
  intervalMs?: number;
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {}
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  try {
    const command = parseCliArgs(argv);
    if (command === "help") {
      writeLine(stdout, USAGE);
      return 0;
    }

    switch (command.kind) {
      case "import": {
        const importOptions: ImportLogFileOptions = { ...command.options };
        if (dependencies.poster !== undefined) {
          importOptions.poster = dependencies.poster;
        }

        const summary = await importLogFile(importOptions);
        writeLine(stdout, formatImportSummary(summary));
        return 0;
      }
      case "tail": {
        const tailOptions: TailLogFileOptions = { ...command.options };
        if (dependencies.poster !== undefined) {
          tailOptions.poster = dependencies.poster;
        }
        if (dependencies.abortSignal !== undefined) {
          tailOptions.signal = dependencies.abortSignal;
        }

        const tail = tailLogFile(tailOptions);
        await tail.done;
        return 0;
      }
      case "systemd": {
        const unit = renderSystemdUnit({
          ...command.options,
          cliPath: dependencies.cliPath ?? fileURLToPath(import.meta.url),
          nodePath: dependencies.nodePath ?? process.execPath
        });
        stdout.write(unit);
        return 0;
      }
    }
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseCliArgs(argv: readonly string[]): ParsedCliCommand | "help" {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    return "help";
  }

  if (command !== "import" && command !== "tail" && command !== "systemd") {
    throw new CliUsageError(`Unknown command: ${command}\n${USAGE}`);
  }

  const flags = parseSharedFlags(argv, command !== "import");
  if (flags === "help") {
    return "help";
  }

  switch (command) {
    case "import":
      return { kind: "import", options: toImportOptions(flags) };
    case "tail":
      return { kind: "tail", options: toTailOptions(flags) };
    case "systemd":
      return { kind: "systemd", options: toSystemdOptions(flags) };
  }
}

function parseSharedFlags(
  argv: readonly string[],
  allowInterval: boolean
): ParsedFlagValues | "help" {
  const parsed: Partial<Record<"file" | "format" | "interval" | "key" | "url", string>> = {};

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      return "help";
    }

    switch (flag) {
      case "--key":
      case "--url":
      case "--format":
      case "--file": {
        const value = readFlagValue(argv, index, flag);
        parsed[flag.slice(2) as "file" | "format" | "key" | "url"] = value;
        index += 1;
        break;
      }
      case "--interval": {
        if (!allowInterval) {
          throw new CliUsageError(`Unknown option: ${flag}\n${USAGE}`);
        }

        parsed.interval = readFlagValue(argv, index, flag);
        index += 1;
        break;
      }
      default:
        throw new CliUsageError(`Unknown option: ${String(flag)}\n${USAGE}`);
    }
  }

  const key = requireParsedValue(parsed.key, "--key");
  const url = requireParsedValue(parsed.url, "--url");
  const formatText = requireParsedValue(parsed.format, "--format");
  const file = requireParsedValue(parsed.file, "--file");

  if (!isLogFormat(formatText)) {
    throw new CliUsageError(`Unsupported format: ${formatText}\nSupported formats: ${LOG_FORMATS.join(", ")}`);
  }

  const values: ParsedFlagValues = { file, format: formatText, key, url };
  if (parsed.interval !== undefined) {
    values.intervalMs = parseIntervalMs(parsed.interval);
  }

  return values;
}

function toImportOptions(flags: ParsedFlagValues): ImportLogFileOptions {
  return {
    file: flags.file,
    format: flags.format,
    key: flags.key,
    url: flags.url
  };
}

function toTailOptions(flags: ParsedFlagValues): TailLogFileOptions {
  const options: TailLogFileOptions = {
    file: flags.file,
    format: flags.format,
    key: flags.key,
    url: flags.url
  };

  if (flags.intervalMs !== undefined) {
    options.pollIntervalMs = flags.intervalMs;
  }

  return options;
}

function toSystemdOptions(
  flags: ParsedFlagValues
): Omit<RenderSystemdUnitOptions, "cliPath" | "nodePath"> {
  const options: Omit<RenderSystemdUnitOptions, "cliPath" | "nodePath"> = {
    file: flags.file,
    format: flags.format,
    key: flags.key,
    url: flags.url
  };

  if (flags.intervalMs !== undefined) {
    options.intervalMs = flags.intervalMs;
  }

  return options;
}

function readFlagValue(argv: readonly string[], index: number, flag: string | undefined): string {
  const value = argv[index + 1];
  if (flag === undefined || value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`Missing value for ${String(flag)}\n${USAGE}`);
  }

  return value;
}

function parseIntervalMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`--interval must be an integer greater than or equal to 1\n${USAGE}`);
  }

  return parsed;
}

function requireParsedValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`Missing required option ${flag}\n${USAGE}`);
  }

  return value;
}

function isLogFormat(value: string): value is LogFormat {
  return (LOG_FORMATS as readonly string[]).includes(value);
}

function writeLine(writer: WritableLike, value: string): void {
  writer.write(`${value}\n`);
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isCliEntry()) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
