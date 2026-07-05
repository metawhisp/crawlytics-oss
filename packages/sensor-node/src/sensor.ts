export const INGEST_BATCH_MAX = 5000;

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_FLUSH_SIZE = 20;

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
  fetch?: FetchLike;
}

export interface Sensor {
  record(event: RawSensorEvent): void;
  flush(): Promise<void>;
  stop(): void;
}

export function createSensor(options: CreateSensorOptions): Sensor {
  const buffer: RawSensorEvent[] = [];
  const flushSize = normalizePositiveInteger(options.flushSize, DEFAULT_FLUSH_SIZE);
  const flushIntervalMs = normalizeNonNegativeInteger(
    options.flushIntervalMs,
    DEFAULT_FLUSH_INTERVAL_MS
  );
  const ingestUrl = buildIngestUrl(options.url);
  let stopped = false;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  async function flush(): Promise<void> {
    try {
      const events = buffer.splice(0, buffer.length);
      if (events.length === 0) {
        return;
      }

      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (typeof fetchImpl !== "function") {
        return;
      }

      for (let offset = 0; offset < events.length; offset += INGEST_BATCH_MAX) {
        const chunk = events.slice(offset, offset + INGEST_BATCH_MAX);
        await fetchImpl(ingestUrl, {
          body: JSON.stringify({ events: chunk }),
          headers: {
            Authorization: `Bearer ${options.key}`,
            "Content-Type": "application/json"
          },
          method: "POST"
        });
      }
    } catch {
      // fail-open: sensor errors must never affect the host app
    }
  }

  function record(event: RawSensorEvent): void {
    try {
      if (stopped) {
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

  if (flushIntervalMs > 0) {
    try {
      timer = globalThis.setInterval(() => {
        void flush();
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
