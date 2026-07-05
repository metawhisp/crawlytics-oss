import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
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
