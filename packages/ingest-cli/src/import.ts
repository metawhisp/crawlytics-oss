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
  return `Imported ${String(summary.eventsSent)} events from ${String(summary.linesRead)} lines (${String(summary.skipped)} skipped).`;
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
  await poster(events, { key: options.key, url: options.url });
  summary.eventsSent += events.length;
  summary.batchesPosted += 1;
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
