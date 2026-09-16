export const INGEST_BATCH_MAX = 5000;

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_FLUSH_SIZE = 20;
/** The sensor lives inside someone else's process. If the server stays full we
 * must stop growing rather than take their memory with us. */
const DEFAULT_MAX_BUFFER = 10_000;
/** After the server refuses a chunk, the timer waits this long before trying
 * again, doubling up to the cap. Without it the default one-second timer would
 * retry every second and turn our sensor into a load amplifier against a server
 * that has just said it is full. An explicit flush() is never held back: that is
 * the caller asking for an attempt now. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export interface RawSensorEvent {
  ts: string;
  ip: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  ua: string;
  referer: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<unknown>;

export interface CreateSensorOptions {
  url: string;
  key: string;
  flushSize?: number;
  flushIntervalMs?: number;
  /** Upper bound on buffered events. Default 10000. */
  maxBuffer?: number;
  fetch?: FetchLike;
}

/**
 * Did the server ask us to come back later?
 *
 * Read by shape, not by type: FetchLike is declared as Promise<unknown> in the
 * public API, and narrowing it would break every implementation already passing
 * something else. Anything we cannot read counts as delivered, which is exactly
 * how this sensor behaved before.
 */
function serverWantsItBack(result: unknown): boolean {
  if (typeof result !== "object" || result === null || !("status" in result)) {
    return false;
  }
  const { status } = result;
  return typeof status === "number" && (status === 429 || status >= 500);
}

export interface Sensor {
  record(event: RawSensorEvent): void;
  flush(): Promise<void>;
  stop(): void;
}

export function createSensor(options: CreateSensorOptions): Sensor {
  const buffer: RawSensorEvent[] = [];
  const flushSize = normalizePositiveInteger(options.flushSize, DEFAULT_FLUSH_SIZE);
  const maxBuffer = normalizePositiveInteger(options.maxBuffer, DEFAULT_MAX_BUFFER);
  const flushIntervalMs = normalizeNonNegativeInteger(
    options.flushIntervalMs,
    DEFAULT_FLUSH_INTERVAL_MS
  );
  const ingestUrl = buildIngestUrl(options.url);
  let stopped = false;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let flushing: Promise<void> | null = null;
  let retryDelayMs = 0;
  let nextTimerAttemptAt = 0;

  /** Everything this chunk and the ones behind it, back into the buffer. */
  function giveBack(events: RawSensorEvent[], from: number): void {
    buffer.unshift(...events.slice(from, from + maxBuffer));
    buffer.length = Math.min(buffer.length, maxBuffer);
    retryDelayMs = retryDelayMs === 0 ? RETRY_BASE_MS : Math.min(retryDelayMs * 2, RETRY_MAX_MS);
    nextTimerAttemptAt = Date.now() + retryDelayMs;
  }

  async function sendAll(): Promise<void> {
    const events = buffer.splice(0, buffer.length);
    if (events.length === 0) {
      return;
    }
    let sent = 0;
    try {

      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (typeof fetchImpl !== "function") {
        return;
      }

      for (let offset = 0; offset < events.length; offset += INGEST_BATCH_MAX) {
        const chunk = events.slice(offset, offset + INGEST_BATCH_MAX);
        const result = await fetchImpl(ingestUrl, {
          body: JSON.stringify({ events: chunk }),
          headers: {
            Authorization: `Bearer ${options.key}`,
            "Content-Type": "application/json"
          },
          method: "POST"
        });
        if (serverWantsItBack(result)) {
          // This chunk and everything behind it stay ours. Sending the rest now
          // would only add to a queue the server has already said is full.
          giveBack(events, offset);
          return;
        }
        sent = offset + chunk.length;
      }
      retryDelayMs = 0;
      nextTimerAttemptAt = 0;
    } catch {
      // A rejected fetch — DNS, refused, reset — is the most ordinary outage
      // there is, and it used to empty the buffer as thoroughly as a success.
      // Fail-open means the host's response is never touched; it never meant
      // throwing the data away.
      giveBack(events, sent);
    }
  }

  /**
   * One at a time. record() starts a flush at flushSize while an explicit one
   * may still be in the air, and two overlapping flushes share every piece of
   * state here: a slow success finishing last would clear the back-off a fast
   * refusal had just set, and the timer would go back to asking a full server
   * every second.
   */
  async function flush(): Promise<void> {
    const previous = flushing;
    if (previous) {
      await previous;
    }
    if (buffer.length === 0) {
      return;
    }
    const run = sendAll();
    flushing = run;
    try {
      await run;
    } finally {
      if (flushing === run) {
        flushing = null;
      }
    }
  }

  function record(event: RawSensorEvent): void {
    try {
      if (stopped) {
        return;
      }

      if (buffer.length >= maxBuffer) {
        // Refuse the new one rather than quietly evicting an older one we have
        // already promised to deliver. Bounded loss, and always the freshest.
        return;
      }
      buffer.push(event);
      if (buffer.length >= flushSize) {
        void flush();
      }
    } catch {
      // fail-open
    }
  }

  function stop(): void {
    try {
      stopped = true;
      if (timer !== undefined) {
        globalThis.clearInterval(timer);
        timer = undefined;
      }
      void flush();
    } catch {
      // fail-open
    }
  }

  function timerTick(): void {
    if (nextTimerAttemptAt > 0 && Date.now() < nextTimerAttemptAt) {
      return;
    }
    void flush();
  }

  if (flushIntervalMs > 0) {
    try {
      timer = globalThis.setInterval(() => {
        timerTick();
      }, flushIntervalMs);

      if (typeof timer.unref === "function") {
        timer.unref();
      }
    } catch {
      // fail-open
    }
  }

  return { flush, record, stop };
}

function buildIngestUrl(url: string): string {
  return `${url.replace(/\/+$/u, "")}/api/ingest`;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}
