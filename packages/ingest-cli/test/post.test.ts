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

    expect(summary).toEqual({ rejected: 0, requests: 2, sent: 5001 });
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
    ).resolves.toEqual({ rejected: 0, requests: 1, sent: 1 });
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

describe("postEvents when it fails part way", () => {
  it("says how many events it had already delivered", async () => {
    // It posts in chunks of 5000 and throws on the first chunk that fails. A
    // caller holding the events has to know which of them the server already
    // committed: putting all of them back re-sends the accepted ones, and the
    // events table has no unique key, so the rows double and every AI-crawler
    // count for that window is inflated.
    let call = 0;
    const fetchMock: FetchLike = () => {
      call += 1;
      return Promise.resolve(
        call === 1 ? new Response(null, { status: 204 }) : new Response("full", { status: 503 })
      );
    };

    const error = await postEvents(makeEvents(7000), {
      fetch: fetchMock,
      key: "test-key",
      maxRetries: 0,
      url: "https://analytics.example.com/"
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as { delivered?: number }).delivered).toBe(5000);
  });

  it("reports nothing delivered when the very first chunk fails", async () => {
    const fetchMock: FetchLike = () => Promise.resolve(new Response("nope", { status: 503 }));
    const error = await postEvents(makeEvents(7000), {
      fetch: fetchMock,
      key: "test-key",
      maxRetries: 0,
      url: "https://analytics.example.com/"
    }).catch((caught: unknown) => caught);

    expect((error as { delivered?: number }).delivered).toBe(0);
  });
});

describe("postEvents and per-event rejections", () => {
  it("counts what the server accepted, not what was handed to it", async () => {
    // /api/ingest reads events one at a time now: a batch can come back 202
    // with some of it rejected. Reporting "sent: everything" makes those drops
    // invisible in the CLI's summary and in the tailer's heartbeat — the exact
    // silence these counters exist to break.
    const fetchMock: FetchLike = () =>
      Promise.resolve(
        new Response(JSON.stringify({ accepted: 8, rejected: 2, issues: [{ index: 3, message: "bad ts" }] }), {
          status: 202,
          headers: { "content-type": "application/json" }
        })
      );

    const summary = await postEvents(makeEvents(10), {
      fetch: fetchMock,
      key: "test-key",
      url: "https://analytics.example.com/"
    });

    expect(summary.sent).toBe(8);
    expect(summary.rejected).toBe(2);
  });

  it("still counts everything when the server says nothing about rejections", async () => {
    const fetchMock: FetchLike = () => Promise.resolve(new Response(null, { status: 204 }));
    const summary = await postEvents(makeEvents(10), {
      fetch: fetchMock,
      key: "test-key",
      url: "https://analytics.example.com/"
    });
    expect(summary.sent).toBe(10);
    expect(summary.rejected).toBe(0);
  });
});
