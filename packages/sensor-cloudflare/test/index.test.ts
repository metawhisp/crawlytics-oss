import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { buildEvent, report } from "../src/index.js";
import type { SensorEnv } from "../src/index.js";

const ENV: SensorEnv = {
  TRACECONTROL_URL: "https://tunnel.example.com",
  TRACECONTROL_KEY: "tc-key"
};

function makeRequest(overrides: Record<string, string> = {}): Request {
  return new Request("https://example.com/blog/post?utm_source=chatgpt.com", {
    method: "GET",
    headers: {
      "cf-connecting-ip": "52.230.152.17",
      "user-agent": "GPTBot/1.3",
      referer: "https://chatgpt.com/",
      ...overrides
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildEvent", () => {
  it("maps request/response to a raw ingest event", () => {
    const response = new Response("x", { status: 404, headers: { "content-length": "5120" } });
    const event = buildEvent(makeRequest(), response, 1_750_000_000_000, 1_750_000_000_042);

    expect(event).toEqual({
      ts: new Date(1_750_000_000_000).toISOString(),
      ip: "52.230.152.17",
      method: "GET",
      path: "/blog/post?utm_source=chatgpt.com",
      status: 404,
      bytes: 5120,
      ua: "GPTBot/1.3",
      referer: "https://chatgpt.com/",
      responseMs: 42
    });
  });

  it("attaches Cloudflare geo/network info when present", () => {
    const request = makeRequest();
    Object.defineProperty(request, "cf", {
      value: { country: "NL", asn: 13335, asOrganization: "Cloudflare" }
    });
    const event = buildEvent(request, new Response("ok"), 1000, 1001);
    expect(event.country).toBe("NL");
    expect(event.asn).toBe(13335);
    expect(event.asOrg).toBe("Cloudflare");
  });

  it("tolerates missing headers", () => {
    const request = new Request("https://example.com/");
    const event = buildEvent(request, new Response("ok"), 1000, 1001);
    expect(event.ip).toBe("0.0.0.0");
    expect(event.ua).toBe("");
    expect(event.referer).toBe("");
    expect(event.bytes).toBe(0);
  });
});

describe("report", () => {
  it("posts a single-event batch with the bearer key", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 202 })));
    vi.stubGlobal("fetch", fetchMock);

    await report(buildEvent(makeRequest(), new Response("ok"), 1000, 1030), ENV);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tunnel.example.com/api/ingest");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tc-key");
    const body = JSON.parse(init.body as string) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });

  it("never throws, even when ingest is down (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("tunnel down"))));
    await expect(
      report(buildEvent(makeRequest(), new Response("ok"), 1000, 1030), ENV)
    ).resolves.toBeUndefined();
  });
});

describe("worker.fetch", () => {
  it("returns the origin response and reports via waitUntil", async () => {
    const origin = new Response("origin-body", { status: 201 });
    const fetchMock = vi.fn(() => Promise.resolve(origin));
    vi.stubGlobal("fetch", fetchMock);

    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => waited.push(promise) };

    const response = await worker.fetch(makeRequest(), ENV, ctx);

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("origin-body");
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    // first call = origin passthrough, second = ingest report
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never clones the response it hands back", async () => {
    // report() only ever read status and content-length, but it was handed
    // response.clone() — a second branch of the body stream that nobody read
    // and nobody cancelled. On a large or streaming response that copy simply
    // accumulates, in a sensor sitting on the hot path of someone's site.
    const origin = new Response("origin-body", { status: 200 });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(origin)));
    const cloneSpy = vi.spyOn(Response.prototype, "clone");

    const waited: Promise<unknown>[] = [];
    await worker.fetch(makeRequest(), ENV, { waitUntil: (p: Promise<unknown>) => waited.push(p) });
    await Promise.all(waited);

    expect(cloneSpy).not.toHaveBeenCalled();
    cloneSpy.mockRestore();
  });

  it("still answers when cloning would have thrown", async () => {
    // The stronger form of the same check: a response whose clone() is not
    // usable must not stop the site being served.
    const origin = new Response("origin-body", { status: 200 });
    Object.defineProperty(origin, "clone", {
      value: () => {
        throw new Error("clone must not be called");
      }
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(origin)));

    const waited: Promise<unknown>[] = [];
    const response = await worker.fetch(makeRequest(), ENV, {
      waitUntil: (p: Promise<unknown>) => waited.push(p)
    });
    await Promise.all(waited);
    expect(await response.text()).toBe("origin-body");
  });

  it("skips reporting its own ingest calls if misconfigured on the same host", async () => {
    const origin = new Response("ok");
    const fetchMock = vi.fn(() => Promise.resolve(origin));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = { waitUntil: () => undefined };

    const request = new Request("https://tunnel.example.com/api/ingest", { method: "POST" });
    await worker.fetch(request, ENV, ctx);
    // passthrough only, no report loop
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
