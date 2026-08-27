import { describe, expect, it } from "vitest";

import { createMemoryStore } from "../src/metadata/index.js";
import {
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  handleMcpMessage,
  handleMcpPayload
} from "../src/mcp/protocol.js";
import { McpUserError, type McpToolContext } from "../src/mcp/tools.js";
import type { StatsStore } from "../src/stats.js";

function stats(overrides: Partial<StatsStore> = {}): StatsStore {
  const ok = (value: unknown) => (): Promise<unknown> => Promise.resolve(value);
  return {
    overview: ok({ kpis: { aiHits: 7 } }),
    bots: ok([]),
    botDetail: ok({}),
    pages: ok([]),
    security: ok({}),
    pagesDaily: ok({ dates: [], pages: [], series: [] }),
    aiLandingPages: ok([]),
    citations: ok({ pages: [], bySource: [], byOperator: [], feed: [], infra: [] }),
    crawlHealth: ok({ broken: [], blindSpots: [] }),
    crawlToRefer: ok({ rows: [] }),
    ...overrides
  } as unknown as StatsStore;
}

async function ctx(overrides: Partial<McpToolContext> = {}): Promise<McpToolContext> {
  const metadata = createMemoryStore();
  await metadata.createSite({ id: "acme", domain: "acme.test" });
  return { siteId: "acme", stats: stats(), metadata, bots: [], ...overrides };
}

const call = (method: string, params?: unknown, id: string | number = 1): unknown => ({
  jsonrpc: "2.0",
  id,
  ...(params === undefined ? {} : { params }),
  method
});

describe("mcp initialize", () => {
  it("echoes a protocol version it supports and advertises tools", async () => {
    const response = await handleMcpMessage(
      call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } }),
      await ctx()
    );
    const result = response?.result as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2025-03-26");
    expect(result["capabilities"]).toHaveProperty("tools");
    expect((result["serverInfo"] as Record<string, unknown>)["name"]).toBe("crawlytics");
    expect(result["instructions"]).toBeTypeOf("string");
  });

  it("falls back to its own latest version when the client asks for an unknown one", async () => {
    const response = await handleMcpMessage(call("initialize", { protocolVersion: "1999-01-01" }), await ctx());
    expect((response?.result as Record<string, unknown>)["protocolVersion"]).toBe(MCP_LATEST_PROTOCOL_VERSION);
  });

  it("advertises only versions it can actually serve over Streamable HTTP", () => {
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toContain("2025-06-18");
    // 2024-11-05 used the older HTTP+SSE transport, which this server has not implemented.
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).not.toContain("2024-11-05");
  });

  it("tolerates initialize without params", async () => {
    const response = await handleMcpMessage(call("initialize"), await ctx());
    expect((response?.result as Record<string, unknown>)["protocolVersion"]).toBe(MCP_LATEST_PROTOCOL_VERSION);
  });
});

describe("mcp core methods", () => {
  it("answers ping", async () => {
    const response = await handleMcpMessage(call("ping"), await ctx());
    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("lists tools with JSON Schemas", async () => {
    const response = await handleMcpMessage(call("tools/list"), await ctx());
    const tools = (response?.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.length).toBeGreaterThanOrEqual(12);
    expect(tools.map((tool) => tool["name"])).toContain("get_citations");
    for (const tool of tools) {
      expect(tool["inputSchema"]).toHaveProperty("type", "object");
    }
  });

  it("returns null for notifications (nothing to reply with)", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, await ctx())).toBeNull();
  });

  it("rejects unknown methods with -32601", async () => {
    const response = await handleMcpMessage(call("resources/list"), await ctx());
    expect(response?.error?.code).toBe(-32601);
  });

  it("rejects malformed messages with -32600", async () => {
    for (const bad of ["nope", 42, null, {}, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }]) {
      const response = await handleMcpMessage(bad, await ctx());
      expect(response?.error?.code).toBe(-32600);
    }
  });

  it("preserves the request id, including 0 and string ids", async () => {
    expect((await handleMcpMessage(call("ping", undefined, 0), await ctx()))?.id).toBe(0);
    expect((await handleMcpMessage(call("ping", undefined, "abc"), await ctx()))?.id).toBe("abc");
  });
});

describe("mcp tools/call", () => {
  it("returns tool output as JSON text content", async () => {
    const response = await handleMcpMessage(
      call("tools/call", { name: "get_overview", arguments: { hours: 24 } }),
      await ctx()
    );
    const result = response?.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]?.type).toBe("text");
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload["kpis"]).toEqual({ aiHits: 7 });
    expect(payload["site"]).toBe("acme");
  });

  it("works when the model omits the arguments object entirely", async () => {
    const response = await handleMcpMessage(call("tools/call", { name: "get_overview" }), await ctx());
    expect((response?.result as { isError: boolean }).isError).toBe(false);
  });

  it("rejects an unknown tool name with -32602", async () => {
    const response = await handleMcpMessage(call("tools/call", { name: "rm_rf" }), await ctx());
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toMatch(/rm_rf/u);
  });

  it("rejects a missing tool name with -32602", async () => {
    const response = await handleMcpMessage(call("tools/call", {}), await ctx());
    expect(response?.error?.code).toBe(-32602);
  });

  it("reports a failing tool as isError, not as a transport error", async () => {
    const response = await handleMcpMessage(
      call("tools/call", { name: "get_overview" }),
      await ctx({ stats: stats({ overview: () => Promise.reject(new Error("clickhouse down")) }) })
    );
    expect(response?.error).toBeUndefined();
    const result = response?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/get_overview/u);
  });

  it("reports invalid arguments as isError so the model can retry", async () => {
    const response = await handleMcpMessage(
      call("tools/call", { name: "get_overview", arguments: { hours: 99999 } }),
      await ctx()
    );
    const result = response?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/hours/u);
  });

  it("HIDES internal failure detail from the model and logs it server-side", async () => {
    const seen: Array<{ error: unknown; tool: string }> = [];
    const response = await handleMcpMessage(
      call("tools/call", { name: "get_overview" }),
      await ctx({
        stats: stats({
          overview: () => Promise.reject(new Error("Code: 62. DB::Exception: Syntax error in events at clickhouse-1:9000"))
        }),
        onError: (error, tool) => seen.push({ error, tool })
      })
    );
    const result = response?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).not.toMatch(/DB::Exception|clickhouse-1|events/u);
    expect(text).toMatch(/internal error/iu);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tool).toBe("get_overview");
  });

  it("still shows OUR own error messages, which are safe and actionable", async () => {
    const response = await handleMcpMessage(
      call("tools/call", { name: "get_overview" }),
      await ctx({ stats: stats({ overview: () => Promise.reject(new McpUserError("site has no data yet")) }) })
    );
    const result = response?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/site has no data yet/u);
  });
});

describe("mcp payload envelope", () => {
  it("returns 200 with a single response for a request", async () => {
    const out = await handleMcpPayload(call("ping"), await ctx());
    expect(out.status).toBe(200);
    expect((out.body as { result: unknown }).result).toEqual({});
  });

  it("returns 202 with no body when the payload is only notifications", async () => {
    const out = await handleMcpPayload({ jsonrpc: "2.0", method: "notifications/initialized" }, await ctx());
    expect(out.status).toBe(202);
    expect(out.body).toBeUndefined();
  });

  it("rejects batches — one rate-limited POST must not carry unbounded tool calls", async () => {
    for (const batch of [
      [call("ping", undefined, 1), call("ping", undefined, 2)],
      [{ jsonrpc: "2.0", method: "notifications/initialized" }],
      []
    ]) {
      const out = await handleMcpPayload(batch, await ctx());
      expect(out.status).toBe(400);
      expect((out.body as { error: { code: number; message: string } }).error.code).toBe(-32600);
      expect((out.body as { error: { message: string } }).error.message).toMatch(/batch/iu);
    }
  });

  it("does not run any tool while rejecting a batch", async () => {
    let called = 0;
    const context = await ctx({
      stats: stats({
        overview: (() => {
          called += 1;
          return Promise.resolve({});
        }) as unknown as StatsStore["overview"]
      })
    });
    await handleMcpPayload([call("tools/call", { name: "get_overview" }, 1)], context);
    expect(called).toBe(0);
  });
});
