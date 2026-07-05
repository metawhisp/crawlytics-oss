import { createReadStream, statSync, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { clearTimeout, setTimeout } from "node:timers";

import { parseLine } from "./parsers/index.js";
import { INGEST_BATCH_MAX, postEvents, type PostEventsOptions } from "./post.js";
import type { LogFormat, RawLogEvent } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

export type TailPoster = (
  events: readonly RawLogEvent[],
  options: PostEventsOptions
) => Promise<unknown>;

export interface TailLogFileOptions {
  file: string;
  format: LogFormat;
  key: string;
  url: string;
  autoStart?: boolean;
  batchSize?: number;
  fieldMap?: Record<string, string>;
  flushIntervalMs?: number;
  now?: () => number;
  pollIntervalMs?: number;
  poster?: TailPoster;
  signal?: AbortSignal;
  startOffset?: number;
}

export interface TailSummary {
  batchesPosted: number;
  bytesRead: number;
  eventsSent: number;
  linesRead: number;
  skipped: number;
}

export interface TailLogFileHandle {
  readonly done: Promise<TailSummary>;
  flush(): Promise<TailSummary>;
  getSummary(): TailSummary;
  pump(): Promise<TailSummary>;
  stop(): Promise<TailSummary>;
}

interface InitialTailState {
  fileIdentity?: string;
  offset: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

export function tailLogFile(options: TailLogFileOptions): TailLogFileHandle {
  const batchSize = normalizeBatchSize(options.batchSize);
  const pollIntervalMs = normalizeIntervalMs(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
    1
  );
  const flushIntervalMs = normalizeIntervalMs(
    options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    "flushIntervalMs",
    0
  );
  const startOffset =
    options.startOffset === undefined ? undefined : normalizeStartOffset(options.startOffset);
  const poster = options.poster ?? postEvents;
  const now = options.now ?? Date.now;
  const initialState = getInitialTailState(options.file, startOffset);
  const batch: RawLogEvent[] = [];
  const summary: TailSummary = {
    batchesPosted: 0,
    bytesRead: 0,
    eventsSent: 0,
    linesRead: 0,
    skipped: 0
  };

  let offset = initialState.offset;
  let fileIdentity = initialState.fileIdentity;
  let pendingLine = "";
  let lastFlushAtMs = now();
  let stopped = options.signal?.aborted ?? false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = createDeferred<TailSummary>();

  async function pump(): Promise<TailSummary> {
    if (stopped) {
      return getSummary();
    }

    const snapshot = await statLogFile(options.file);
    if (snapshot === undefined) {
      fileIdentity = undefined;
      offset = 0;
      pendingLine = "";
      await flushIfDue();
      return getSummary();
    }

    if (fileIdentity !== undefined && fileIdentity !== snapshot.identity) {
      offset = 0;
      pendingLine = "";
    } else if (snapshot.size < offset) {
      offset = 0;
      pendingLine = "";
    }
    fileIdentity = snapshot.identity;

    if (snapshot.size > offset) {
      const text = await readRange(options.file, offset, snapshot.size);
      if (text === undefined) {
        fileIdentity = undefined;
        offset = 0;
        pendingLine = "";
        await flushIfDue();
        return getSummary();
      }

      offset = snapshot.size;
      summary.bytesRead += Buffer.byteLength(text);
      await processText(text);
    }

    await flushIfDue();
    return getSummary();
  }

  async function processText(text: string): Promise<void> {
    const lines = `${pendingLine}${text}`.split("\n");
    pendingLine = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      await processLine(line);
    }
  }

  async function processLine(line: string): Promise<void> {
    summary.linesRead += 1;

    const event = parseLine(line, options.format, options.fieldMap);
    if (event === null) {
      summary.skipped += 1;
      return;
    }

    batch.push(event);
    if (batch.length >= batchSize) {
      await flush();
    }
  }

  async function flushIfDue(): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    if (now() - lastFlushAtMs >= flushIntervalMs) {
      await flush();
    }
  }

  async function flush(): Promise<TailSummary> {
    if (batch.length === 0) {
      lastFlushAtMs = now();
      return getSummary();
    }

    const events = batch.splice(0, batch.length);
    await poster(events, { key: options.key, url: options.url });
    summary.eventsSent += events.length;
    summary.batchesPosted += 1;
    lastFlushAtMs = now();
    return getSummary();
  }

  async function stop(): Promise<TailSummary> {
    if (stopped) {
      return getSummary();
    }

    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    try {
      const finalSummary = await flush();
      options.signal?.removeEventListener("abort", abortListener);
      done.resolve(finalSummary);
      return finalSummary;
    } catch (error) {
      done.reject(error);
      throw error;
    }
  }

  function getSummary(): TailSummary {
    return { ...summary };
  }

  function scheduleNextPump(): void {
    if (stopped || timer !== undefined) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      void pump().then(
        () => {
          scheduleNextPump();
        },
        (error: unknown) => {
          stopped = true;
          done.reject(error);
        }
      );
    }, pollIntervalMs);
  }

  const abortListener = (): void => {
    void stop().catch((error: unknown) => {
      done.reject(error);
    });
  };

  if (stopped) {
    done.resolve(getSummary());
  } else {
    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (options.autoStart !== false) {
      scheduleNextPump();
    }
  }

  return {
    done: done.promise,
    flush,
    getSummary,
    pump,
    stop
  };
}

function getInitialTailState(file: string, startOffset: number | undefined): InitialTailState {
  try {
    const stats = statSync(file);
    return {
      fileIdentity: getFileIdentity(stats),
      offset: startOffset ?? stats.size
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { offset: startOffset ?? 0 };
    }

    throw error;
  }
}

async function statLogFile(
  file: string
): Promise<{ identity: string; size: number } | undefined> {
  try {
    const stats = await stat(file);
    return { identity: getFileIdentity(stats), size: stats.size };
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function readRange(
  file: string,
  startOffset: number,
  endOffset: number
): Promise<string | undefined> {
  const chunks: string[] = [];

  try {
    const stream = createReadStream(file, {
      encoding: "utf8",
      end: endOffset - 1,
      start: startOffset
    });

    for await (const chunk of stream) {
      chunks.push(String(chunk));
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }

  return chunks.join("");
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

function normalizeIntervalMs(value: number, name: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${String(minimum)}`);
  }

  return value;
}

function normalizeStartOffset(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("startOffset must be an integer greater than or equal to 0");
  }

  return value;
}

function getFileIdentity(stats: Stats): string {
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });

  if (resolveDeferred === undefined || rejectDeferred === undefined) {
    throw new Error("failed to create deferred");
  }

  return {
    promise,
    reject: rejectDeferred,
    resolve: resolveDeferred
  };
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
