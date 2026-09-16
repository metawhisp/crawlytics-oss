import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { parseLine } from "./parsers/index.js";
import { INGEST_BATCH_MAX, postEvents, type PostEventsOptions } from "./post.js";
import type { LogFormat, RawLogEvent } from "./types.js";

export type ImportPoster = (
  events: readonly RawLogEvent[],
  options: PostEventsOptions
) => Promise<unknown>;

export interface ImportLogFileOptions {
  file: string;
  format: LogFormat;
  key: string;
  url: string;
  batchSize?: number;
  fieldMap?: Record<string, string>;
  poster?: ImportPoster;
}

export interface ImportSummary {
  linesRead: number;
  eventsSent: number;
  /** Read by this CLI, then refused by the server one event at a time. */
  rejected: number;
  skipped: number;
  batchesPosted: number;
}

export async function importLogFile(options: ImportLogFileOptions): Promise<ImportSummary> {
  const batchSize = normalizeBatchSize(options.batchSize);
  const poster = options.poster ?? postEvents;
  const seen = new Set<string>();
  const batch: RawLogEvent[] = [];
  const summary: ImportSummary = {
    batchesPosted: 0,
    eventsSent: 0,
    rejected: 0,
    linesRead: 0,
    skipped: 0
  };

  const lines = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(options.file, { encoding: "utf8" })
  });

  for await (const line of lines) {
    summary.linesRead += 1;

    const lineHash = hashLine(line);
    if (seen.has(lineHash)) {
      summary.skipped += 1;
      continue;
    }
    seen.add(lineHash);

    const event = parseLine(line, options.format, options.fieldMap);
    if (event === null) {
      summary.skipped += 1;
      continue;
    }

    batch.push(event);
    if (batch.length >= batchSize) {
      await flushBatch(batch, summary, poster, options);
    }
  }

  await flushBatch(batch, summary, poster, options);

  return summary;
}

export function formatImportSummary(summary: ImportSummary): string {
  const refused = summary.rejected > 0 ? `, ${String(summary.rejected)} refused by the server` : "";
  const base = `Imported ${String(summary.eventsSent)} events from ${String(summary.linesRead)} lines (${String(summary.skipped)} skipped${refused}).`;
  if (recognisedNothing(summary)) {
    // The same sentence used to be printed for a run that understood every line
    // and for one that understood none, and both exited 0. A --format that does
    // not match the log is the likeliest cause and the cheapest thing to check.
    return `${base}\nNo line was recognised — check --format against the file (and --field-map for jsonl).`;
  }
  return base;
}

/** Zero unless the file had lines and not one of them parsed. */
export function importExitCode(summary: ImportSummary): number {
  return recognisedNothing(summary) ? 1 : 0;
}

function recognisedNothing(summary: ImportSummary): boolean {
  return summary.linesRead > 0 && summary.eventsSent === 0;
}

async function flushBatch(
  batch: RawLogEvent[],
  summary: ImportSummary,
  poster: ImportPoster,
  options: ImportLogFileOptions
): Promise<void> {
  if (batch.length === 0) {
    return;
  }

  const events = batch.splice(0, batch.length);
  const result = await poster(events, { key: options.key, url: options.url });
  // The server reads events one at a time and says how many it refused.
  // Counting everything handed over would hide those drops in a line that
  // otherwise reads like a clean import.
  const accepted = acceptedCount(result, events.length);
  summary.eventsSent += accepted;
  summary.rejected += events.length - accepted;
  summary.batchesPosted += 1;
}

function acceptedCount(result: unknown, handed: number): number {
  if (typeof result === "object" && result !== null && "sent" in result) {
    const { sent } = result;
    if (typeof sent === "number" && sent >= 0 && sent <= handed) {
      return sent;
    }
  }
  return handed;
}

function normalizeBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) {
    return INGEST_BATCH_MAX;
  }

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > INGEST_BATCH_MAX) {
    throw new Error(`batchSize must be an integer between 1 and ${String(INGEST_BATCH_MAX)}`);
  }

  return batchSize;
}

function hashLine(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}
