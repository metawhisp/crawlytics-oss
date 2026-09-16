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

/** What a shutdown could not hand over, so the caller can say so out loud. */
export interface StopReport {
  undelivered: number;
}

export interface Batcher {
  push(siteId: string, events: RawLogEvent[]): boolean;
  flush(): Promise<void>;
  stop(): Promise<StopReport>;
  /** Buffered plus in-flight: everything this batcher has taken responsibility for. */
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
  /** Events handed to process() and not yet acknowledged. They have left the
   * buffer but are still ours: the ingest API already answered 202 for them. */
  let inFlight = 0;
  let flushing: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  if (flushIntervalMs > 0) {
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    timer.unref();
  }

  function push(siteId: string, events: RawLogEvent[]): boolean {
    // In-flight events count against the cap. Without them a batch that had
    // left the buffer freed space it might still need: when the write failed
    // there was no room to put it back, and it was dropped — after the caller
    // had been told 202. Reserving the space is what makes the restore below
    // unconditional and therefore lossless.
    if (buffer.length + inFlight + events.length > maxBuffer) {
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
    inFlight = batch.length;
    // Promise.resolve().then(...) and not options.process(batch).then(...):
    // a synchronous throw escapes before there is a promise to attach the
    // restore handler to, and the batch would be lost as an object while
    // inFlight still counted it as ours. The contract above promises a throw
    // keeps the batch, and that has to hold for both kinds of throw.
    flushing = Promise.resolve()
      .then(() => options.process(batch))
      .then(
        () => {
          inFlight = 0;
          flushing = null;
        },
        (error: unknown) => {
          // Unconditionally: these events were accepted, so losing them is never
          // an option. push() reserved their space while they were in flight, so
          // they always fit — the old conditional could not be satisfied and
          // silently discarded up to maxBuffer accepted events.
          buffer = [...batch, ...buffer];
          inFlight = 0;
          flushing = null;
          onError(error);
        }
      );
    await flushing;
  }

  async function stop(): Promise<StopReport> {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    await flush();
    // flush() cannot reject — the timer and the size trigger call it as
    // void flush() — so the only way a caller learns that a shutdown left
    // accepted events behind is this number.
    return { undelivered: buffer.length + inFlight };
  }

  return {
    push,
    flush,
    stop,
    get size() {
      return buffer.length + inFlight;
    }
  };
}
