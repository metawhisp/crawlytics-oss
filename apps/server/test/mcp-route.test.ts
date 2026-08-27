import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { createMemoryStore } from "../src/metadata/memory-store.js";

const KPIS = { aiHits: 1, uniqueBots: 1, verified: 1, spoofed: 0, aiReferrals: 0, botErrors: 0 };

function fakeStats() {
  return {
    overview: vi.fn((site: string) =>
      Promise.resolve({
        kpis: KPIS,
        prevKpis: KPIS,
        timeseries: [],
        topBots: [],
        topPages: [],
        referrals: [],
        recent: [],
        sites: [site]
      })
    ),
    bots: vi.fn(() => Promise.resolve([])),
    botDetail: vi.fn(() => Promise.resolve({ timeseries: [], topPages: [], statuses: [], sources: [], countries: [] })),
    pages: vi.fn(() => Promise.resolve([])),
    security: vi.fn(() => Promise.resolve({ spoofedByBot: [], spoofedSources: [] })),
    pagesDaily: vi.fn(() => Promise.resolve({ dates: [], pages: [], series: [] })),
    aiLandingPages: vi.fn(() => Promise.resolve([])),
    citations: vi.fn(() => Promise.resolve({ pages: [], bySource: [], byOperator: [], feed: [], infra: [] })),
    crawlHealth: vi.fn(() => Promise.resolve({ broken: [], blindSpots: [] })),
    crawlToRefer: vi.fn(() => Promise.resolve({ rows: [] }))
  };
}

async function makeApp(options: { dashboardEnabled?: boolean; rateLimit?: number } = {}) {
  const metadata = createMemoryStore();
  await metadata.createSite({ id: "acme", domain: "acme.test" });
  await metadata.createSite({ id: "rival", domain: "rival.test" });
  await metadata.createKey({ siteId: "acme", scope: "read", key: "cwr_acme" });
  await metadata.createKey({ siteId: "rival", scope: "read", key: "cwr_rival" });
  await metadata.createKey({ siteId: "acme", scope: "ingest", key: "cwi_acme" });
  const resolveReadKey = vi.spyOn(metadata, "resolveReadKey");
  const stats = fakeStats();
  const app = buildApp({
    metadata,
    batcher: { push: () => true, size: 0 },
    stats,
    dashboardEnabled: options.dashboardEnabled ?? true,
    // The full image always serves the shell (the SPA is baked in); the license
    // may still be missing, which is exactly the gated case under test.
    serveDashboard: true,
    dashboardPassword: "dashboard-secret",
    ...(options.rateLimit === undefined ? {} : { mcpRateLimitPerMinute: options.rateLimit })
  });
  return { app, stats, resolveReadKey };
}

const rpc = (method: string, params?: unknown, id: string | number = 1): unknown => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params })
});

const post = (app: Awaited<ReturnType<typeof makeApp>>["app"], key: string | null, payload: unknown) =>
  app.inject({
    method: "POST",
    url: "/mcp",
    ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
    payload: payload as Record<string, unknown>
  });

describe("POST /mcp auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const { app } = await makeApp();
    const response = await post(app, null, rpc("initialize"));
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(/Bearer/u);
  });

  it("rejects a non-Bearer Authorization header", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Basic cwr_acme" },
      payload: rpc("initialize") as Record<string, unknown>
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unknown key", async () => {
    const { app } = await makeApp();
    expect((await post(app, "cwr_nope", rpc("initialize"))).statusCode).toBe(401);
  });

  it("REJECTS an ingest-scoped key — ingest must never read analytics", async () => {
    const { app, stats } = await makeApp();
    const response = await post(app, "cwi_acme", rpc("tools/call", { name: "get_overview" }));
    expect(response.statusCode).toBe(401);
    expect(stats.overview).not.toHaveBeenCalled();
  });

  it("rejects the dashboard password as a key", async () => {
    const { app } = await makeApp();
    expect((await post(app, "dashboard-secret", rpc("initialize"))).statusCode).toBe(401);
  });

  it("accepts a valid read key and completes the MCP handshake", async () => {
    const { app } = await makeApp();
    const response = await post(app, "cwr_acme", rpc("initialize", { protocolVersion: "2025-06-18" }));
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/u);
    const body: { result: { serverInfo: { name: string }; capabilities: unknown } } = response.json();
    expect(body.result.serverInfo.name).toBe("crawlytics");
    expect(body.result.capabilities).toHaveProperty("tools");
  });
});

describe("POST /mcp tenant isolation", () => {
  it("scopes tool calls to the site the key belongs to", async () => {
    const { app, stats } = await makeApp();
    await post(app, "cwr_acme", rpc("tools/call", { name: "get_overview", arguments: { hours: 24 } }));
    expect(stats.overview).toHaveBeenCalledWith("acme", 24);
  });

  it("gives a different key its own site, not the first one", async () => {
    const { app, stats } = await makeApp();
    await post(app, "cwr_rival", rpc("tools/call", { name: "get_overview" }));
    expect(stats.overview).toHaveBeenCalledWith("rival", 24);
  });

  it("ignores a site argument smuggled into the tool call", async () => {
    const { app, stats } = await makeApp();
    await post(app, "cwr_rival", rpc("tools/call", { name: "get_overview", arguments: { site: "acme", hours: 24 } }));
    expect(stats.overview).toHaveBeenCalledWith("rival", 24);
    expect(stats.overview).not.toHaveBeenCalledWith("acme", 24);
  });
});

describe("POST /mcp protocol surface", () => {
  it("lists tools", async () => {
    const { app } = await makeApp();
    const response = await post(app, "cwr_acme", rpc("tools/list"));
    const body: { result: { tools: Array<{ name: string }> } } = response.json();
    expect(body.result.tools.map((tool) => tool.name)).toContain("get_crawl_health");
  });

  it("answers a notification with 202 and an empty body", async () => {
    const { app } = await makeApp();
    const response = await post(app, "cwr_acme", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("");
  });

  it("returns 400 for a malformed envelope", async () => {
    const { app } = await makeApp();
    expect((await post(app, "cwr_acme", { hello: "world" })).statusCode).toBe(400);
  });

  it("surfaces a tool failure as isError instead of a 500", async () => {
    const { app, stats } = await makeApp();
    stats.citations.mockRejectedValueOnce(new Error("clickhouse down"));
    const response = await post(app, "cwr_acme", rpc("tools/call", { name: "get_citations" }));
    expect(response.statusCode).toBe(200);
    const body: { result: { isError: boolean; content: Array<{ text: string }> } } = response.json();
    expect(body.result.isError).toBe(true);
  });

  it("rejects GET and DELETE (no server-initiated stream, no sessions)", async () => {
    const { app } = await makeApp();
    for (const method of ["GET", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/mcp", headers: { authorization: "Bearer cwr_acme" } });
      expect(response.statusCode).toBe(405);
    }
  });
});

describe("POST /mcp transport hardening", () => {
  it("rejects a JSON-RPC batch with 400", async () => {
    const { app, stats } = await makeApp();
    const response = await post(app, "cwr_acme", [rpc("tools/call", { name: "get_overview" }, 1)]);
    expect(response.statusCode).toBe(400);
    expect(stats.overview).not.toHaveBeenCalled();
  });

  it("rejects a foreign browser Origin (DNS rebinding) but allows CLI clients with none", async () => {
    const { app } = await makeApp();
    const foreign = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer cwr_acme", origin: "https://evil.example", host: "analytics.example" },
      payload: rpc("ping") as Record<string, unknown>
    });
    expect(foreign.statusCode).toBe(403);

    const sameOrigin = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer cwr_acme", origin: "https://analytics.example", host: "analytics.example" },
      payload: rpc("ping") as Record<string, unknown>
    });
    expect(sameOrigin.statusCode).toBe(200);

    // no Origin at all — Claude Code and other non-browser clients
    expect((await post(app, "cwr_acme", rpc("ping"))).statusCode).toBe(200);
  });

  it("rejects an MCP-Protocol-Version it never agreed to", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer cwr_acme", "mcp-protocol-version": "2024-11-05" },
      payload: rpc("ping") as Record<string, unknown>
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts a negotiated version header", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer cwr_acme", "mcp-protocol-version": "2025-06-18" },
      payload: rpc("ping") as Record<string, unknown>
    });
    expect(response.statusCode).toBe(200);
  });

  it("does not echo internal query failures back to the client", async () => {
    const { app, stats } = await makeApp();
    stats.citations.mockRejectedValueOnce(new Error("DB::Exception at clickhouse-1:9000"));
    const response = await post(app, "cwr_acme", rpc("tools/call", { name: "get_citations" }));
    const body: { result: { isError: boolean; content: Array<{ text: string }> } } = response.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).not.toMatch(/clickhouse-1|DB::Exception/u);
  });
});

describe("POST /mcp gating and limits", () => {
  it("is locked while the dashboard has no valid license", async () => {
    const { app } = await makeApp({ dashboardEnabled: false });
    expect((await post(app, "cwr_acme", rpc("initialize"))).statusCode).toBe(403);
  });

  it("rate-limits per key and reports retry-after", async () => {
    const { app } = await makeApp({ rateLimit: 3 });
    for (let index = 0; index < 3; index += 1) {
      expect((await post(app, "cwr_acme", rpc("ping"))).statusCode).toBe(200);
    }
    const limited = await post(app, "cwr_acme", rpc("ping"));
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("rate-limits each key independently", async () => {
    const { app } = await makeApp({ rateLimit: 2 });
    await post(app, "cwr_acme", rpc("ping"));
    await post(app, "cwr_acme", rpc("ping"));
    expect((await post(app, "cwr_acme", rpc("ping"))).statusCode).toBe(429);
    expect((await post(app, "cwr_rival", rpc("ping"))).statusCode).toBe(200);
  });

  it("throttles an unauthenticated flood BEFORE it reaches the key lookup", async () => {
    // per-IP budget is 4x the per-key one
    const { app, resolveReadKey } = await makeApp({ rateLimit: 2 });
    for (let index = 0; index < 8; index += 1) {
      await post(app, "cwr_nope", rpc("ping"));
    }
    resolveReadKey.mockClear();
    const flooded = await post(app, "cwr_nope", rpc("ping"));
    expect(flooded.statusCode).toBe(429);
    // the whole point: the over-limit request must not cost a store lookup
    expect(resolveReadKey).not.toHaveBeenCalled();
  });

  it("rejects an oversized body without parsing it as MCP", async () => {
    const { app, resolveReadKey } = await makeApp();
    resolveReadKey.mockClear();
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer cwr_acme", "content-type": "application/json" },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(400_000) } })
    });
    expect(response.statusCode).toBe(413);
    expect(resolveReadKey).not.toHaveBeenCalled();
  });

  it("does not spend rate-limit budget on unauthenticated requests", async () => {
    const { app } = await makeApp({ rateLimit: 2 });
    await post(app, "cwr_nope", rpc("ping"));
    await post(app, "cwr_nope", rpc("ping"));
    await post(app, "cwr_nope", rpc("ping"));
    expect((await post(app, "cwr_acme", rpc("ping"))).statusCode).toBe(200);
  });
});
