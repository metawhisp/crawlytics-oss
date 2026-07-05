import type { RawLogEvent } from "@crawlytics/shared";

export interface PendingEvent {
  siteId: string;
  event: RawLogEvent;
}

export interface BatcherOptions {
  /** Drains the buffer: enrich + insert. Throwing keeps the batch for retry. */
  process: (events: PendingEvent[]) => Promise<void>;
  /** Auto-flush threshold. Default 5000. */
  flushSize?: number;
  /** Timer flush interval; 0 disables the timer (manual flush). Default 2000. */
  flushIntervalMs?: number;
  /** Hard buffer cap; pushes beyond it are rejected (HTTP 429). Default 50_000. */
  maxBuffer?: number;
  onError?: (error: unknown) => void;
}

export interface Batcher {
  push(siteId: string, events: RawLogEvent[]): boolean;
  flush(): Promise<void>;
  stop(): Promise<void>;
  readonly size: number;
}

const DEFAULT_FLUSH_SIZE = 5000;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BUFFER = 50_000;

export function createBatcher(options: BatcherOptions): Batcher {
  const flushSize = options.flushSize ?? DEFAULT_FLUSH_SIZE;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const onError = options.onError ?? (() => undefined);

  let buffer: PendingEvent[] = [];
  let flushing: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  if (flushIntervalMs > 0) {
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    timer.unref();
  }

  function push(siteId: string, events: RawLogEvent[]): boolean {
    if (buffer.length + events.length > maxBuffer) {
      return false;
    }
    for (const event of events) {
      buffer.push({ siteId, event });
    }
    if (buffer.length >= flushSize) {
      void flush();
    }
    return true;
  }

  async function flush(): Promise<void> {
    // serialize flushes; a queued caller picks up whatever is buffered after
    if (flushing) {
      await flushing;
      if (buffer.length === 0) {
        return;
      }
    }
    if (buffer.length === 0) {
      return;
    }

    const batch = buffer;
    buffer = [];
    flushing = options.process(batch).then(
      () => {
        flushing = null;
      },
      (error: unknown) => {
        // retry later: prepend the failed batch unless the cap is exceeded
        flushing = null;
        if (batch.length + buffer.length <= maxBuffer) {
          buffer = [...batch, ...buffer];
        }
        onError(error);
      }
    );
    await flushing;
  }

  async function stop(): Promise<void> {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    await flush();
  }

  return {
    push,
    flush,
    stop,
    get size() {
      return buffer.length;
    }
  };
}
