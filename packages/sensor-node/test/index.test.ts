import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { INGEST_BATCH_MAX, createSensor, expressSensor, nextSensor } from "../src/index.js";
import type { NextRequestLike, RawSensorEvent } from "../src/index.js";

const INGEST_URL = "https://analytics.example.com/api/ingest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createSensor", () => {
  it("buffers records and fire-and-forget flushes a batch at flushSize", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    const sensor = createSensor({
      fetch: fetchMock,
      flushIntervalMs: 0,
      flushSize: 2,
      key: "test-key",
      url: "https://analytics.example.com/"
    });

    sensor.record(makeEvent(1));
    expect(fetchMock).not.toHaveBeenCalled();

    sensor.record(makeEvent(2));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(INGEST_URL);
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json"
    });
    expect(readPostedEvents(init)).toEqual([makeEvent(1), makeEvent(2)]);

    sensor.stop();
  });

  it("swallows fetch errors from record-triggered and explicit flushes", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("ingest down")));
    const sizeSensor = createSensor({
      fetch: fetchMock,
      flushIntervalMs: 0,
      flushSize: 1,
      key: "test-key",
      url: "https://analytics.example.com"
    });

    expect(() => {
      sizeSensor.record(makeEvent(1));
    }).not.toThrow();
    await expect(sizeSensor.flush()).resolves.toBeUndefined();
    sizeSensor.stop();

    const explicitSensor = createSensor({
      fetch: fetchMock,
      flushIntervalMs: 0,
      flushSize: 10,
      key: "test-key",
      url: "https://analytics.example.com"
    });
    explicitSensor.record(makeEvent(2));

    await expect(explicitSensor.flush()).resolves.toBeUndefined();
    explicitSensor.stop();
  });

  it("chunks explicit flushes at 5000 events", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const sensor = createSensor({
      fetch: fetchMock,
      flushIntervalMs: 0,
      flushSize: 10_000,
      key: "test-key",
      url: "https://analytics.example.com"
    });

    for (let index = 0; index < 5001; index += 1) {
      sensor.record(makeEvent(index));
    }

    await sensor.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(readPostedEvents(firstInit)).toHaveLength(5000);
    expect(readPostedEvents(secondInit)).toHaveLength(1);

    sensor.stop();
  });

  it("flushes buffered events on the interval without real sleeps", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    const sensor = createSensor({
      fetch: fetchMock,
      flushIntervalMs: 1000,
      flushSize: 10,
      key: "test-key",
      url: "https://analytics.example.com"
    });

    sensor.record(makeEvent(1));
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    sensor.stop();
  });
});

describe("expressSensor", () => {
  it("calls next synchronously and records the response event on finish", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T10:11:12.000Z"));

    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    const middleware = expressSensor({
      fetch: fetchMock,
      flushIntervalMs: 0,
      flushSize: 1,
      key: "test-key",
      url: "https://analytics.example.com"
    });

    const req = {
      headers: {
        referer: "https://chatgpt.com/",
        "user-agent": "GPTBot/1.3",
        "x-forwarded-for": "203.0.113.10, 198.51.100.7"
      },
      method: "POST",
      originalUrl: "/checkout?plan=ltd"
    };
    const res = new FakeResponse(201, "123");
    const calls: string[] = [];
    const next = vi.fn(() => {
      calls.push("next");
    });

    middleware(req, res, next);
    calls.push("after");

    expect(calls).toEqual(["next", "after"]);
    expect(fetchMock).not.toHaveBeenCalled();

    res.emit("finish");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(readPostedEvents(init)).toEqual([
      {
        bytes: 123,
        ip: "203.0.113.10",
        method: "POST",
        path: "/checkout?plan=ltd",
        referer: "https://chatgpt.com/",
        status: 201,
        ts: "2026-06-12T10:11:12.000Z",
        ua: "GPTBot/1.3"
      }
    ]);
  });
});

describe("nextSensor", () => {
  it("records request-side events with status and bytes unavailable in middleware", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T10:11:12.000Z"));

    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    const record = nextSensor({
      fetch: fetchMock,
      flushIntervalMs: 0,
      flushSize: 1,
      key: "test-key",
      url: "https://analytics.example.com"
    });

    record(
      makeNextRequest({
        headers: {
          referer: "https://perplexity.ai/",
          "user-agent": "PerplexityBot/1.0",
          "x-forwarded-for": "203.0.113.44, 198.51.100.9"
        },
        method: "POST",
        nextUrl: { pathname: "/pricing" },
        url: "https://site.example.com/fallback"
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(readPostedEvents(init)).toEqual([
      {
        bytes: 0,
        ip: "203.0.113.44",
        method: "POST",
        path: "/pricing",
        referer: "https://perplexity.ai/",
        status: 0,
        ts: "2026-06-12T10:11:12.000Z",
        ua: "PerplexityBot/1.0"
      }
    ]);
  });

  it("falls back to the request url pathname and referrer header", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T10:11:12.000Z"));

    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    const record = nextSensor({
      fetch: fetchMock,
      flushIntervalMs: 0,
      flushSize: 1,
      key: "test-key",
      url: "https://analytics.example.com"
    });

    record(
      makeNextRequest({
        headers: {
          referrer: "https://chatgpt.com/",
          "user-agent": "ChatGPT-User/1.0"
        },
        ip: "198.51.100.11",
        method: "GET",
        nextUrl: {},
        url: "https://site.example.com/docs/install?tab=next"
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(readPostedEvents(init)).toEqual([
      {
        bytes: 0,
        ip: "198.51.100.11",
        method: "GET",
        path: "/docs/install",
        referer: "https://chatgpt.com/",
        status: 0,
        ts: "2026-06-12T10:11:12.000Z",
        ua: "ChatGPT-User/1.0"
      }
    ]);
  });

  it("stays fail-open when ingestion fails", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("ingest down")));
    const record = nextSensor({
      fetch: fetchMock,
      flushIntervalMs: 0,
      flushSize: 1,
      key: "test-key",
      url: "https://analytics.example.com"
    });

    expect(() => {
      record(
        makeNextRequest({
          headers: {
            "user-agent": "GPTBot/1.3"
          },
          method: "GET",
          url: "https://site.example.com/robots.txt"
        })
      );
    }).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

class FakeResponse extends EventEmitter {
  statusCode: number;

  private readonly contentLength: string;

  constructor(statusCode: number, contentLength: string) {
    super();
    this.statusCode = statusCode;
    this.contentLength = contentLength;
  }

  getHeader(name: string): string | undefined {
    return name.toLowerCase() === "content-length" ? this.contentLength : undefined;
  }
}

function makeEvent(index: number): RawSensorEvent {
  return {
    bytes: 412,
    ip: `203.0.113.${String(index % 255)}`,
    method: "GET",
    path: `/robots.txt?i=${String(index)}`,
    referer: "",
    status: 200,
    ts: "2026-06-10T00:22:01.000Z",
    ua: "GPTBot/1.3"
  };
}

function makeNextRequest(input: {
  headers?: Record<string, string>;
  ip?: string;
  method?: string;
  nextUrl?: { pathname?: string };
  url: string;
}): NextRequestLike {
  const headers = new Map(
    Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  const request: NextRequestLike = {
    headers: {
      get(name: string): string | null {
        return headers.get(name.toLowerCase()) ?? null;
      }
    },
    url: input.url
  };

  if (input.ip !== undefined) {
    request.ip = input.ip;
  }
  if (input.method !== undefined) {
    request.method = input.method;
  }
  if (input.nextUrl !== undefined) {
    request.nextUrl = input.nextUrl;
  }

  return request;
}

function readPostedEvents(init: RequestInit): unknown[] {
  if (typeof init.body !== "string") {
    throw new Error("expected JSON body");
  }

  const parsed = JSON.parse(init.body) as { events?: unknown };
  if (!Array.isArray(parsed.events)) {
    throw new Error("expected events array");
  }

  return parsed.events;
}

describe("createSensor backpressure", () => {
  const event = {
    ts: "2026-09-15T10:00:00.000Z",
    ip: "203.0.113.10",
    method: "GET",
    path: "/a",
    status: 200,
    bytes: 0,
    ua: "GPTBot/1.3",
    referer: ""
  };

  it("keeps events when the server says it is full", async () => {
    // The buffer was spliced before the POST and the response was never looked
    // at, so 429 was indistinguishable from 202 and the chunk simply vanished —
    // inside the host application, where nobody can see it.
    const fetchImpl = vi.fn(() => Promise.resolve({ status: 429 }));
    const sensor = createSensor({ url: "http://localhost:3000", key: "k", flushIntervalMs: 0, fetch: fetchImpl });
    sensor.record(event);
    await sensor.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Still ours: the next flush retries instead of starting from nothing.
    await sensor.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps events when the server fails", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ status: 503 }));
    const sensor = createSensor({ url: "http://localhost:3000", key: "k", flushIntervalMs: 0, fetch: fetchImpl });
    sensor.record(event);
    await sensor.flush();
    await sensor.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("drops the chunk on a rejection the server will not take back", async () => {
    // 401 is not backpressure: retrying a bad key forever would grow the buffer
    // without end in someone else's process.
    const fetchImpl = vi.fn(() => Promise.resolve({ status: 401 }));
    const sensor = createSensor({ url: "http://localhost:3000", key: "k", flushIntervalMs: 0, fetch: fetchImpl });
    sensor.record(event);
    await sensor.flush();
    await sensor.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a response it cannot read as delivered, exactly as before", async () => {
    // FetchLike is Promise<unknown> in the public API. An implementation that
    // returns something else must keep working the way it always has.
    const fetchImpl = vi.fn(() => Promise.resolve("whatever"));
    const sensor = createSensor({ url: "http://localhost:3000", key: "k", flushIntervalMs: 0, fetch: fetchImpl });
    sensor.record(event);
    await sensor.flush();
    await sensor.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps events when the connection fails outright", async () => {
    // A rejected fetch — DNS, connection refused, reset — is the most ordinary
    // outage there is, and it used to empty the buffer just as thoroughly as a
    // success did.
    let attempts = 0;
    const fetchImpl = vi.fn(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("ECONNREFUSED"))
        : Promise.resolve({ status: 202 });
    });
    const sensor = createSensor({ url: "http://localhost:3000", key: "k", flushIntervalMs: 0, fetch: fetchImpl });
    sensor.record(event);
    await sensor.flush();
    await sensor.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off the timer instead of hammering a server that is full", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => Promise.resolve({ status: 429 }));
      const sensor = createSensor({
        url: "http://localhost:3000",
        key: "k",
        flushIntervalMs: 1000,
        fetch: fetchImpl
      });
      sensor.record(event);
      await vi.advanceTimersByTimeAsync(1100);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Without a back-off the default one-second timer would retry every second
      // and make the server's problem worse — a load amplifier we introduced.
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      sensor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a flush that succeeds does not cancel a back-off another flush just set", async () => {
    // Two flushes can overlap: record() starts one at flushSize while an
    // explicit one is still in the air. If the slow success finishes last it
    // used to clear the back-off the refusal had just set, and the timer went
    // back to asking a full server every second.
    vi.useFakeTimers();
    try {
      let finishFirst: ((value: { status: number }) => void) | undefined;
      const first = new Promise<{ status: number }>((resolve) => {
        finishFirst = resolve;
      });
      let call = 0;
      const fetchImpl = vi.fn(() => {
        call += 1;
        return call === 1 ? first : Promise.resolve({ status: 429 });
      });
      const sensor = createSensor({
        url: "http://localhost:3000",
        key: "k",
        flushSize: 1,
        flushIntervalMs: 1000,
        fetch: fetchImpl
      });
      sensor.record(event);
      sensor.record(event);
      finishFirst?.({ status: 202 });
      await vi.advanceTimersByTimeAsync(50);
      const afterRefusal = fetchImpl.mock.calls.length;

      // The refusal must still be in force a second later.
      await vi.advanceTimersByTimeAsync(1100);
      expect(fetchImpl.mock.calls.length).toBe(afterRefusal);

      sensor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requeues exactly the chunks the server did not take", async () => {
    // One flush can span several chunks. A refusal on the second must put back
    // the second and nothing else: re-sending the first would duplicate it,
    // forgetting the tail would lose it.
    let call = 0;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      void init;
      call += 1;
      return call === 1 ? Promise.resolve({ status: 202 }) : Promise.resolve({ status: 429 });
    });
    const sensor = createSensor({
      url: "http://localhost:3000",
      key: "k",
      flushSize: 100_000,
      flushIntervalMs: 0,
      fetch: fetchImpl
    });
    for (let i = 0; i < INGEST_BATCH_MAX + 1; i += 1) {
      sensor.record(event);
    }
    await sensor.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await sensor.flush();
    const retried = fetchImpl.mock.calls[2]?.[1].body;
    const body = JSON.parse(typeof retried === "string" ? retried : "{}") as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });

  it("stops growing when the server stays full", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      void init;
      return Promise.resolve({ status: 429 });
    });
    const sensor = createSensor({
      url: "http://localhost:3000",
      key: "k",
      flushIntervalMs: 0,
      maxBuffer: 3,
      fetch: fetchImpl
    });
    for (let i = 0; i < 10; i += 1) {
      sensor.record(event);
    }
    await sensor.flush();
    await sensor.flush();
    // Bounded: a host application must not be made to leak memory by our sensor.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
    const sent = fetchImpl.mock.calls[0]?.[1].body;
    const body = JSON.parse(typeof sent === "string" ? sent : "{}") as { events: unknown[] };
    expect(body.events.length).toBeLessThanOrEqual(3);
  });
});
