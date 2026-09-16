import { createReadStream, statSync, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { clearTimeout, setTimeout } from "node:timers";

import { parseLine } from "./parsers/index.js";
import { INGEST_BATCH_MAX, postEvents, type PostEventsOptions } from "./post.js";
import type { LogFormat, RawLogEvent } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
/** Events kept while the server is refusing. Roughly a minute of a busy access
 * log; past that the tailer refuses new lines rather than growing without end. */
const DEFAULT_MAX_BUFFER = 10_000;
/** Same first step and same ceiling as the node sensor, so the two agree about
 * how hard to push a server that is already saying no. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

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
  /** Events per request, mirroring the poster's own split. Overridden in tests. */
  chunkSize?: number;
  flushIntervalMs?: number;
  maxBuffer?: number;
  now?: () => number;
  pollIntervalMs?: number;
  poster?: TailPoster;
  signal?: AbortSignal;
  startOffset?: number;
}

export interface TailSummary {
  batchesPosted: number;
  bytesRead: number;
  /** Parsed, refused by the buffer because the server was not taking them, and
   * gone. Counted rather than silent: this is the number that says the tailer
   * could not keep up with an outage. */
  dropped: number;
  eventsSent: number;
  linesRead: number;
  skipped: number;
  /** Read here, then refused by the server one event at a time. */
  rejected: number;
  /** Parsed and still held, waiting for a server that will take them. */
  undelivered: number;
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

/** One line for the journal. `crawlytics tail` printed nothing at all, ever, so
 * under systemd a sensor delivering everything and a sensor skipping every line
 * of a log it cannot parse looked exactly alike: "active (running)". */
/** What the server said it took. Anything else it was handed, it refused one
 * event at a time — a number that must not vanish into "sent". */
function acceptedCount(result: unknown, handed: number): number {
  if (typeof result === "object" && result !== null && "sent" in result) {
    const { sent } = result;
    if (typeof sent === "number" && sent >= 0 && sent <= handed) {
      return sent;
    }
  }
  return handed;
}

/** How many of the events handed to the poster it managed to deliver before it
 * threw. Absent means none of them — an error from somewhere other than the
 * poster cannot have delivered anything. */
function deliveredBefore(error: unknown): number {
  if (typeof error !== "object" || error === null || !("delivered" in error)) {
    return 0;
  }
  const { delivered } = error;
  return typeof delivered === "number" && delivered > 0 ? delivered : 0;
}

/** 429 and 5xx mean "again, later"; anything else the server said is final.
 * Not an HTTP failure at all (a dead socket) is always worth another go. The
 * node sensor draws the same line, in serverWantsItBack. */
function willTakeItLater(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return true;
  }
  const { status } = error;
  if (typeof status !== "number") {
    return true;
  }
  return status === 429 || status >= 500;
}

export function formatTailHeartbeat(summary: TailSummary): string {
  const parts = [
    `${String(summary.linesRead)} lines`,
    `${String(summary.eventsSent)} sent`,
    `${String(summary.skipped)} skipped`
  ];
  if (summary.rejected > 0) {
    parts.push(`${String(summary.rejected)} refused`);
  }
  if (summary.undelivered > 0) {
    parts.push(`${String(summary.undelivered)} waiting`);
  }
  if (summary.dropped > 0) {
    parts.push(`${String(summary.dropped)} DROPPED`);
  }
  const line = parts.join(", ");
  if (summary.linesRead > 0 && summary.eventsSent === 0 && summary.skipped === summary.linesRead) {
    return `${line} — no line was recognised, check --format against the file`;
  }
  return line;
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
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const chunkSize = options.chunkSize ?? INGEST_BATCH_MAX;
  const now = options.now ?? Date.now;
  const initialState = getInitialTailState(options.file, startOffset);
  const batch: RawLogEvent[] = [];
  const summary: TailSummary = {
    batchesPosted: 0,
    bytesRead: 0,
    dropped: 0,
    eventsSent: 0,
    linesRead: 0,
    rejected: 0,
    skipped: 0,
    undelivered: 0
  };
  let failures = 0;
  let nextAttemptAtMs = 0;

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

    if (batch.length >= maxBuffer) {
      // Refuse rather than evict. Dropping the oldest would throw away the
      // events closest to being delivered, and dropping silently is the thing
      // this whole wave is about — so it is counted and reported.
      summary.dropped += 1;
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

  /**
   * `force` is what an explicit flush() or stop() passes: a back-off is about
   * not hammering a server that said no, and it must never hold back the last
   * attempt before the process goes away.
   */
  async function flush(force = false): Promise<TailSummary> {
    if (batch.length === 0) {
      lastFlushAtMs = now();
      return getSummary();
    }

    if (!force && now() < nextAttemptAtMs) {
      return getSummary();
    }

    const events = batch.splice(0, batch.length);
    let result: unknown;
    try {
      result = await poster(events, { key: options.key, url: options.url });
    } catch (error) {
      // The poster splits the batch into requests and stops at the first
      // failure, so part of what we handed it may already be in the database.
      // Putting ALL of it back would re-send those rows, and the events table
      // has no unique key — trading loss for duplication is not a fix. The node
      // sensor restores from the failing chunk onward (giveBack); same rule.
      const delivered = Math.min(deliveredBefore(error), events.length);
      summary.eventsSent += delivered;
      if (delivered > 0) {
        summary.batchesPosted += 1;
      }

      if (!willTakeItLater(error)) {
        // A 400 does not become valid by waiting. Holding it would block every
        // line behind it until the buffer filled and the tail stopped
        // altogether, so it is dropped — and counted, and named. Only the chunk
        // the server actually refused: what never left the process is still
        // ours to deliver.
        const refused = events.slice(delivered, delivered + chunkSize);
        summary.dropped += refused.length;
        batch.unshift(...events.slice(delivered + refused.length));
        lastFlushAtMs = now();
        return getSummary();
      }
      // Put back what the server did not take, at the front, in order — the
      // server batcher does the same thing for the same reason: these lines
      // were read out of a file whose offset has already moved past them, so
      // nothing else will ever produce them again. Swallowing the error here is
      // deliberate: it used to travel up through pump() into the scheduler,
      // which stopped the tailer and rejected `done`, so one blip of the server
      // ended log collection until somebody noticed.
      batch.unshift(...events.slice(delivered));
      failures += 1;
      nextAttemptAtMs = now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      lastFlushAtMs = now();
      return getSummary();
    }
    const accepted = acceptedCount(result, events.length);
    summary.eventsSent += accepted;
    summary.rejected += events.length - accepted;
    summary.batchesPosted += 1;
    failures = 0;
    nextAttemptAtMs = 0;
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
      const finalSummary = await flush(true);
      options.signal?.removeEventListener("abort", abortListener);
      done.resolve(finalSummary);
      return finalSummary;
    } catch (error) {
      done.reject(error);
      throw error;
    }
  }

  function getSummary(): TailSummary {
    return { ...summary, undelivered: batch.length };
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
    // An explicit flush is a decision, not a tick: it is never held back.
    flush: () => flush(true),
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
