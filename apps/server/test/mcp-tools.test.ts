import { describe, expect, it, vi } from "vitest";

import { createMemoryStore } from "../src/metadata/index.js";
import { MCP_TOOLS, findTool, runTool, type McpTool, type McpToolContext } from "../src/mcp/tools.js";
import type { StatsStore } from "../src/stats.js";

/** Fails loudly instead of a non-null assertion: a renamed tool should break
 * the test with a clear message, not a TypeError deep inside runTool. */
function tool(name: string): McpTool {
  const found = findTool(name);
  if (!found) {
    throw new Error(`no such tool: ${name}`);
  }
  return found;
}

function fakeStats(): StatsStore & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const rec =
    (name: string, value: unknown) =>
    (...args: unknown[]): Promise<unknown> => {
      calls.push([name, args]);
      return Promise.resolve(value);
    };
  return {
    calls,
    // overview() also carries the dashboard's GLOBAL site list — the shape that
    // leaked other tenants through MCP before the whitelist.
    overview: rec("overview", {
      kpis: { aiHits: 1 },
      prevKpis: { aiHits: 0 },
      timeseries: [],
      topBots: [],
      topPages: [],
      referrals: [],
      recent: [],
      sites: ["acme", "rival", "another-customer"]
    }),
    bots: rec("bots", [{ botId: "gptbot" }]),
    botDetail: rec("botDetail", { timeseries: [] }),
    pages: rec("pages", [{ pathGroup: "/x" }]),
    security: rec("security", { spoofedByBot: [] }),
    pagesDaily: rec("pagesDaily", { dates: [], pages: [], series: [] }),
    aiLandingPages: rec("aiLandingPages", [{ page: "/x" }]),
    citations: rec("citations", { pages: [], bySource: [], byOperator: [], feed: [] }),
    crawlHealth: rec("crawlHealth", { broken: [], blindSpots: [] }),
    crawlToRefer: rec("crawlToRefer", { rows: [] })
  } as unknown as StatsStore & { calls: Array<[string, unknown[]]> };
}

async function makeCtx(overrides: Partial<McpToolContext> = {}): Promise<McpToolContext> {
  const metadata = createMemoryStore();
  await metadata.createSite({ id: "acme", domain: "acme.test" });
  return {
    siteId: "acme",
    stats: fakeStats(),
    metadata,
    bots: [
      { bot_id: "gptbot", ua_patterns: ["GPTBot"], actor_type: "ai_training", operator: "openai" },
      { bot_id: "perplexitybot", ua_patterns: ["PerplexityBot"], actor_type: "ai_search", operator: "perplexity" }
    ] as McpToolContext["bots"],
    ...overrides
  };
}

describe("mcp tool catalog", () => {
  it("exposes read + generator tools with well-formed JSON Schemas", () => {
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(12);
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    for (const tool of MCP_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema["type"]).toBe("object");
      expect(tool.inputSchema["properties"]).toBeTypeOf("object");
    }
    expect(names).toContain("get_citations");
    expect(names).toContain("get_crawl_health");
    expect(names).toContain("generate_robots_txt");
  });

  it("never exposes a write tool (read-only + pure generators only)", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.name).toMatch(/^(get_|explore$|generate_)/u);
    }
  });

  it("никакой тул не принимает site — сайт берётся из ключа", () => {
    for (const tool of MCP_TOOLS) {
      const properties = tool.inputSchema["properties"] as Record<string, unknown>;
      expect(Object.keys(properties)).not.toContain("site");
      expect(Object.keys(properties)).not.toContain("site_id");
    }
  });
});

describe("mcp tool execution", () => {
  it("passes the context site id into the stats layer", async () => {
    const ctx = await makeCtx();
    await runTool(tool("get_overview"), ctx, { hours: 48 });
    const calls = (ctx.stats as unknown as { calls: Array<[string, unknown[]]> }).calls;
    expect(calls[0]).toEqual(["overview", ["acme", 48]]);
  });

  it("IGNORES a site argument injected by the model (tenant isolation)", async () => {
    const ctx = await makeCtx();
    await runTool(tool("get_overview"), ctx, { hours: 24, site: "victim", site_id: "victim" });
    const calls = (ctx.stats as unknown as { calls: Array<[string, unknown[]]> }).calls;
    expect(calls[0]).toEqual(["overview", ["acme", 24]]);
  });

  it("applies defaults when the model omits arguments", async () => {
    const ctx = await makeCtx();
    await runTool(tool("get_overview"), ctx, {});
    await runTool(tool("get_citations"), ctx, {});
    const calls = (ctx.stats as unknown as { calls: Array<[string, unknown[]]> }).calls;
    expect(calls[0]).toEqual(["overview", ["acme", 24]]);
    expect(calls[1]).toEqual(["citations", ["acme", 30, 50]]);
  });

  it("coerces numeric strings (models often send strings)", async () => {
    const ctx = await makeCtx();
    await runTool(tool("get_citations"), ctx, { days: "7", limit: "5" });
    const calls = (ctx.stats as unknown as { calls: Array<[string, unknown[]]> }).calls;
    expect(calls[0]).toEqual(["citations", ["acme", 7, 5]]);
  });

  it("rejects out-of-range arguments instead of hitting the database", async () => {
    const ctx = await makeCtx();
    await expect(runTool(tool("get_overview"), ctx, { hours: 0 })).rejects.toThrow(/hours/iu);
    await expect(runTool(tool("get_overview"), ctx, { hours: 100000 })).rejects.toThrow(/hours/iu);
    await expect(runTool(tool("get_citations"), ctx, { days: -1 })).rejects.toThrow(/days/iu);
    expect((ctx.stats as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });

  it("requires bot_id for get_bot_detail", async () => {
    const ctx = await makeCtx();
    await expect(runTool(tool("get_bot_detail"), ctx, {})).rejects.toThrow(/bot_id/iu);
  });

  it("explore validates metric/dimension against the whitelist", async () => {
    const client = { query: vi.fn(() => Promise.resolve({ json: () => Promise.resolve([{ key: "a", value: 1 }]) })) };
    const ctx = await makeCtx({ chClient: client });
    const rows = await runTool(tool("explore"), ctx, { metric: "hits", dimension: "operator" });
    expect(rows).toEqual({ rows: [{ key: "a", value: 1 }] });
    await expect(runTool(tool("explore"), ctx, { metric: "nope", dimension: "operator" })).rejects.toThrow(/metric/iu);
    await expect(runTool(tool("explore"), ctx, { metric: "hits", dimension: "nope" })).rejects.toThrow(/dimension/iu);
  });

  it("explore fails cleanly when no ClickHouse client is wired", async () => {
    const ctx = await makeCtx();
    await expect(runTool(tool("explore"), ctx, { metric: "hits", dimension: "operator" })).rejects.toThrow(/unavailable/iu);
  });

  it("explore binds the context site, not a model-supplied one", async () => {
    const captured: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
    const client = {
      query: vi.fn((options: { query: string; query_params?: Record<string, unknown> }) => {
        captured.push(options);
        return Promise.resolve({ json: () => Promise.resolve([]) });
      })
    };
    const ctx = await makeCtx({ chClient: client });
    await runTool(tool("explore"), ctx, { metric: "hits", dimension: "operator", site: "victim" });
    expect(captured[0]?.query_params?.["site"]).toBe("acme");
  });

  it("generates robots.txt with deny-training defaults", async () => {
    const ctx = await makeCtx();
    const result = (await runTool(tool("generate_robots_txt"), ctx, {})) as { robotsTxt: string };
    expect(result.robotsTxt).toMatch(/User-agent: GPTBot\nDisallow: \//u);
    expect(result.robotsTxt).toMatch(/User-agent: PerplexityBot\nAllow: \//u);
  });

  it("honours an explicit robots policy", async () => {
    const ctx = await makeCtx();
    const result = (await runTool(tool("generate_robots_txt"), ctx, {
      training: "allow",
      search: "deny",
      fetch: "deny"
    })) as { robotsTxt: string };
    expect(result.robotsTxt).toMatch(/User-agent: GPTBot\nAllow: \//u);
    expect(result.robotsTxt).toMatch(/User-agent: PerplexityBot\nDisallow: \//u);
  });

  it("rejects an invalid robots policy value", async () => {
    const ctx = await makeCtx();
    await expect(runTool(tool("generate_robots_txt"), ctx, { training: "maybe" })).rejects.toThrow(/training/iu);
  });

  it("generates llms.txt from the site domain registered for the key", async () => {
    const ctx = await makeCtx();
    const result = (await runTool(tool("generate_llms_txt"), ctx, {})) as { llmsTxt: string };
    expect(result.llmsTxt).toContain("acme.test");
  });

  it("falls back to a placeholder host when the site has no domain", async () => {
    const metadata = createMemoryStore();
    await metadata.createSite({ id: "acme" });
    const ctx = await makeCtx({ metadata });
    const result = (await runTool(tool("generate_llms_txt"), ctx, {})) as { llmsTxt: string };
    expect(result.llmsTxt.length).toBeGreaterThan(20);
  });

  it("NEVER exposes the instance-wide site list through get_overview (tenant leak)", async () => {
    const ctx = await makeCtx();
    const result = (await runTool(tool("get_overview"), ctx, {})) as Record<string, unknown>;
    expect(result["sites"]).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("rival");
    expect(JSON.stringify(result)).not.toContain("another-customer");
    expect(result["site"]).toBe("acme");
    expect(result["kpis"]).toEqual({ aiHits: 1 });
  });

  it("drops unknown explore filter keys instead of passing them to the query builder", async () => {
    const captured: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
    const client = {
      query: vi.fn((options: { query: string; query_params?: Record<string, unknown> }) => {
        captured.push(options);
        return Promise.resolve({ json: () => Promise.resolve([]) });
      })
    };
    const ctx = await makeCtx({ chClient: client });
    await runTool(tool("explore"), ctx, {
      metric: "hits",
      dimension: "operator",
      filters: { operator: "openai", evil: "x" }
    });
    expect(captured[0]?.query_params?.["f_operator"]).toBe("openai");
    expect(captured[0]?.query_params?.["f_evil"]).toBeUndefined();
  });

  it("ADVERTISES explore filters as a closed set with length caps", () => {
    const properties = tool("explore").inputSchema["properties"] as Record<string, Record<string, unknown>>;
    const filters = properties["filters"] as Record<string, unknown>;
    expect(filters["additionalProperties"]).toBe(false);
    const allowed = filters["properties"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(allowed).sort()).toEqual(["actor_type", "bot_id", "country", "operator", "verification"]);
    for (const spec of Object.values(allowed)) {
      expect(spec["type"]).toBe("string");
      expect(spec["maxLength"]).toBe(200);
    }
  });

  it("rejects an oversized explore filter value", async () => {
    const client = { query: vi.fn(() => Promise.resolve({ json: () => Promise.resolve([]) })) };
    const ctx = await makeCtx({ chClient: client });
    await expect(
      runTool(tool("explore"), ctx, { metric: "hits", dimension: "operator", filters: { operator: "x".repeat(500) } })
    ).rejects.toThrow(/operator/u);
  });

  it("findTool returns undefined for an unknown name", () => {
    expect(findTool("drop_tables")).toBeUndefined();
  });
});
