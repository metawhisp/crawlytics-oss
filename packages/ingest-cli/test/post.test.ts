import { describe, expect, it } from "vitest";

import type { RawLogEvent } from "../src/index.js";
import { postEvents, type FetchLike } from "../src/post.js";

describe("postEvents", () => {
  it("chunks requests at the ingest schema max", async () => {
    const requests: RequestInit[] = [];
    const fetchMock: FetchLike = (_url, init) => {
      requests.push(init);
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const summary = await postEvents(makeEvents(5001), {
      fetch: fetchMock,
      key: "test-key",
      url: "https://analytics.example.com/"
    });

    expect(summary).toEqual({ requests: 2, sent: 5001 });
    expect(requests).toHaveLength(2);
    expect(readPostedEvents(requests[0])).toHaveLength(5000);
    expect(readPostedEvents(requests[1])).toHaveLength(1);
    expect(requests[0]?.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json"
    });
  });

  it("retries HTTP 429 and then succeeds", async () => {
    let calls = 0;
    const fetchMock: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: calls === 1 ? 429 : 204 }));
    };

    await expect(
      postEvents(makeEvents(1), {
        baseDelayMs: 0,
        fetch: fetchMock,
        key: "test-key",
        url: "https://analytics.example.com"
      })
    ).resolves.toEqual({ requests: 1, sent: 1 });
    expect(calls).toBe(2);
  });

  it("surfaces non-retryable 4xx responses", async () => {
    const fetchMock: FetchLike = () =>
      Promise.resolve(new Response("bad key", { status: 401, statusText: "Unauthorized" }));

    await expect(
      postEvents(makeEvents(1), {
        baseDelayMs: 0,
        fetch: fetchMock,
        key: "bad-key",
        url: "https://analytics.example.com"
      })
    ).rejects.toThrow("HTTP 401 Unauthorized: bad key");
  });
});

function makeEvents(count: number): RawLogEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    ts: "2026-06-10T00:22:01.000Z",
    ip: `203.0.113.${String(index % 255)}`,
    method: "GET",
    path: `/robots.txt?i=${String(index)}`,
    status: 200,
    bytes: 412,
    ua: "Mozilla/5.0",
    referer: ""
  }));
}

function readPostedEvents(init: RequestInit | undefined): unknown[] {
  if (init === undefined || typeof init.body !== "string") {
    throw new Error("expected JSON body");
  }

  const parsed = JSON.parse(init.body) as { events?: unknown };
  if (!Array.isArray(parsed.events)) {
    throw new Error("expected events array");
  }

  return parsed.events;
}
