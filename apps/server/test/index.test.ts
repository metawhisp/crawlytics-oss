import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { shutdownExitCode } from "../src/index.js";
import { createBatcher } from "../src/batcher.js";
import { createMemoryStore } from "../src/metadata/memory-store.js";

const VALID_EVENT = {
  ts: "2026-06-10T03:22:01.000Z",
  ip: "203.0.113.10",
  method: "GET",
  path: "/robots.txt",
  status: 200,
  bytes: 412,
  ua: "GPTBot/1.3",
  referer: ""
};

async function makeApp(push: (siteId: string, events: unknown[]) => boolean = () => true) {
  const metadata = createMemoryStore();
  await metadata.createSite({ id: "site-1" });
  await metadata.createKey({ siteId: "site-1", scope: "ingest", key: "k-live-1" });
  return buildApp({
    metadata,
    batcher: { push, size: 0 }
  });
}

describe("POST /api/ingest", () => {
  it("tells a full server's clients when to come back", async () => {
    // Counting in-flight events against the cap means 429 happens sooner and
    // more often. A sensor that is told only "no" has to guess; ingest-cli
    // already honours Retry-After, and guessing is how events get dropped.
    const app = await makeApp(() => false);
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer k-live-1" },
      payload: { events: [VALID_EVENT] }
    });
    expect(response.statusCode).toBe(429);
    // The value, not just its presence: it has to agree with the node sensor's
    // first back-off step, and "defined" would stay green if someone made it
    // 5000 by reaching for milliseconds.
    expect(response.headers["retry-after"]).toBe("5");
  });

  it("rejects missing or unknown API keys", async () => {
    const app = await makeApp();
    const noAuth = await app.inject({ method: "POST", url: "/api/ingest", payload: { events: [VALID_EVENT] } });
    expect(noAuth.statusCode).toBe(401);

    const badKey = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer nope" },
      payload: { events: [VALID_EVENT] }
    });
    expect(badKey.statusCode).toBe(401);
  });

  it("rejects malformed payloads with 400", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer k-live-1" },
      payload: { events: [{ ...VALID_EVENT, ts: "not-a-date" }] }
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts a valid batch with 202 and forwards it to the batcher", async () => {
    const push = vi.fn(() => true);
    const app = await makeApp(push);
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer k-live-1" },
      payload: { events: [VALID_EVENT, { ...VALID_EVENT, path: "/x" }] }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 2 });
    expect(push).toHaveBeenCalledWith("site-1", expect.any(Array));
  });

  it("one bad event does not cost the batch it arrived in", async () => {
    // The batch was validated atomically, so a single over-long path or a
    // timestamp a log line produced in a shape zod does not take rejected all
    // 5000 with HTTP 400 — and no sensor treats 400 as recoverable, so the
    // whole batch was dropped on the floor. A log tailer reading a file it does
    // not control cannot promise every line is clean.
    const push = vi.fn((siteId: string, events: unknown[]) => Boolean(siteId) || events.length >= 0);
    const app = await makeApp(push);
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer k-live-1" },
      payload: {
        events: [VALID_EVENT, { ...VALID_EVENT, ts: "not-a-date" }, { ...VALID_EVENT, path: "/x" }]
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 2, rejected: 1 });
    const forwarded = push.mock.calls[0]?.[1];
    expect(forwarded).toHaveLength(2);
  });

  it("says which events it could not read, so the sender can fix them", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer k-live-1" },
      payload: { events: [VALID_EVENT, { ...VALID_EVENT, ts: "not-a-date" }] }
    });
    const body: { issues?: Array<{ index: number }> } = response.json();
    expect(body.issues?.[0]?.index).toBe(1);
  });

  it("still refuses a batch in which nothing at all is readable", async () => {
    // A sensor sending the wrong shape entirely must hear about it rather than
    // getting 202 for a batch that delivered nothing.
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer k-live-1" },
      payload: { events: [{ ...VALID_EVENT, ts: "not-a-date" }] }
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 429 when the buffer is full", async () => {
    const app = await makeApp(() => false);
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer k-live-1" },
      payload: { events: [VALID_EVENT] }
    });
    expect(response.statusCode).toBe(429);
  });

  it("exposes a health endpoint", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
  });
});

describe("readiness and ingest metrics", () => {
  it("/readyz is 200 without a probe and 503 when the probe fails", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);

    const metadata = createMemoryStore();
    const down = buildApp({
      metadata,
      batcher: { push: () => true, size: 0 },
      checkReady: () => Promise.resolve(false)
    });
    expect((await down.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);

    const erroring = buildApp({
      metadata,
      batcher: { push: () => true, size: 0 },
      checkReady: () => Promise.reject(new Error("probe down"))
    });
    expect((await erroring.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
  });

  it("/healthz counts accepted events and rejected requests", async () => {
    const app = await makeApp();
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer k-live-1" },
      payload: { events: [VALID_EVENT, { ...VALID_EVENT, path: "/x" }] }
    });
    await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: "Bearer nope" },
      payload: { events: [VALID_EVENT] }
    });
    const health = (await app.inject({ method: "GET", url: "/healthz" })).json<{
      acceptedEvents: number;
      acceptedBatches: number;
      rejectedRequests: number;
      lastIngestAt: string | null;
    }>();
    expect(health.acceptedEvents).toBe(2);
    expect(health.acceptedBatches).toBe(1);
    expect(health.rejectedRequests).toBe(1);
    expect(typeof health.lastIngestAt).toBe("string");
  });
});

describe("createBatcher", () => {
  const item = (path: string) => ({ ...VALID_EVENT, path });

  it("buffers and flushes everything to the processor", async () => {
    const process = vi.fn((events: Array<{ siteId: string }>) => {
      void events;
      return Promise.resolve();
    });
    const batcher = createBatcher({ process, flushIntervalMs: 0 });
    expect(batcher.push("site-1", [item("/a"), item("/b")])).toBe(true);
    expect(batcher.size).toBe(2);

    await batcher.flush();
    expect(batcher.size).toBe(0);
    expect(process).toHaveBeenCalledTimes(1);
    const batch = process.mock.calls[0]?.[0];
    expect(batch).toHaveLength(2);
    expect(batch?.[0]?.siteId).toBe("site-1");
  });

  it("auto-flushes when flushSize is reached", async () => {
    const process = vi.fn(() => Promise.resolve());
    const batcher = createBatcher({ process, flushSize: 2, flushIntervalMs: 0 });
    batcher.push("site-1", [item("/a"), item("/b"), item("/c")]);
    await vi.waitFor(() => {
      expect(process).toHaveBeenCalled();
    });
    expect(batcher.size).toBe(0);
  });

  it("rejects pushes beyond maxBuffer", () => {
    const batcher = createBatcher({ process: () => Promise.resolve(), maxBuffer: 2, flushIntervalMs: 0 });
    expect(batcher.push("site-1", [item("/a"), item("/b")])).toBe(true);
    expect(batcher.push("site-1", [item("/c")])).toBe(false);
  });

  it("keeps events for retry when the processor fails", async () => {
    let failures = 1;
    const process = vi.fn(() => (failures-- > 0 ? Promise.reject(new Error("sink down")) : Promise.resolve()));
    const batcher = createBatcher({ process, flushIntervalMs: 0 });
    batcher.push("site-1", [item("/a")]);

    await batcher.flush();
    expect(batcher.size).toBe(1); // retained

    await batcher.flush();
    expect(batcher.size).toBe(0); // retried successfully
    expect(process).toHaveBeenCalledTimes(2);
  });

  it("counts in-flight events against the cap, and keeps every accepted one when the write fails", async () => {
    // The admission check used to look at the buffer alone. A batch handed to
    // process() is no longer in the buffer, so its events stopped counting and
    // new ones were accepted into space that was not free — and when the write
    // failed, the old batch was put back ONLY if it still fitted. Otherwise it
    // was dropped: events the ingest API had already answered 202 to.
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gate: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const process = vi.fn(() => {
      release?.();
      return held.then(() => Promise.reject(new Error("sink down")));
    });
    const batcher = createBatcher({ process, flushSize: 2, flushIntervalMs: 0, maxBuffer: 4 });

    // Two events fill flushSize and go out; the buffer is empty again.
    expect(batcher.push("site-1", [item("/a"), item("/b")])).toBe(true);
    await started;

    // THREE is the number that tells the two behaviours apart. Pushing two
    // passes either way (0+2 and 2+2 both fit in 4), so a test that pushes two
    // is green on the broken code — that mistake was already made once here.
    expect(batcher.push("site-1", [item("/c"), item("/d"), item("/e")])).toBe(false);
    expect(batcher.push("site-1", [item("/c"), item("/d")])).toBe(true);

    gate?.();
    await vi.waitFor(() => {
      expect(process).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      // Everything accepted is still here: the two that failed plus the two after.
      expect(batcher.size).toBe(4);
    });
  });

  it("reports what it could not hand over when it stops", async () => {
    // stop() resolved successfully even when the write failed, so a shutdown
    // could exit(0) on top of a full buffer without anyone being told.
    const process = vi.fn(() => Promise.reject(new Error("sink down")));
    const batcher = createBatcher({ process, flushIntervalMs: 0 });
    batcher.push("site-1", [item("/a"), item("/b")]);
    expect(await batcher.stop()).toMatchObject({ undelivered: 2 });
  });

  it("keeps the batch when the processor throws synchronously", async () => {
    // The contract above says a throw keeps the batch for retry. Attaching the
    // handlers to the returned promise only honours that for an async throw:
    // a synchronous one escapes before there is a promise to attach to, and the
    // batch is lost as an object while size still counts it as ours.
    let attempts = 0;
    const process = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("sink down");
      }
      return Promise.resolve();
    });
    const batcher = createBatcher({ process, flushIntervalMs: 0 });
    batcher.push("site-1", [item("/a"), item("/b")]);

    await batcher.flush();
    expect(batcher.size).toBe(2);

    await batcher.flush();
    expect(batcher.size).toBe(0);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it("does not let a shutdown that lost events look clean", () => {
    // An orchestrator reading only the exit code would restart quietly on top
    // of a hole. Pinned separately because the wiring in index.ts runs inside
    // the isMain block and no test can observe process.exit there.
    expect(shutdownExitCode({ undelivered: 0 })).toBe(0);
    expect(shutdownExitCode({ undelivered: 2 })).toBe(1);
  });

  it("flushes on the timer", async () => {
    vi.useFakeTimers();
    try {
      const process = vi.fn(() => Promise.resolve());
      const batcher = createBatcher({ process, flushIntervalMs: 1000 });
      batcher.push("site-1", [item("/a")]);
      await vi.advanceTimersByTimeAsync(1100);
      expect(process).toHaveBeenCalledTimes(1);
      await batcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
