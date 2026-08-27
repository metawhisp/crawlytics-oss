/**
 * Minimal MCP server over JSON-RPC 2.0, sized to what this server actually
 * offers: tools only — no resources, prompts, sampling or server-initiated
 * messages, so there is no session state and no SSE stream to keep alive.
 *
 * Responses go back as plain `application/json`, which the Streamable HTTP
 * transport explicitly allows for a request that produces a single response.
 *
 * Error split follows the spec's intent:
 *  - protocol-level problems (bad envelope, unknown method, unknown tool) are
 *    JSON-RPC `error` objects;
 *  - a tool that runs and fails (bad arguments, ClickHouse down) comes back as
 *    a normal result with `isError: true`, so the model sees it and can retry.
 */
import { MCP_TOOLS, McpUserError, findTool, type McpToolContext } from "./tools.js";

export const MCP_LATEST_PROTOCOL_VERSION = "2025-06-18";

/** Versions we can speak over Streamable HTTP. 2024-11-05 is deliberately NOT
 * here: that revision used the older HTTP+SSE transport, which this server does
 * not implement — advertising it would promise a shape we cannot serve. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [MCP_LATEST_PROTOCOL_VERSION, "2025-03-26"];

const SERVER_INFO = {
  name: "crawlytics",
  title: "Crawlytics — AI traffic analytics",
  version: "1.0.0"
};

const INSTRUCTIONS = [
  "Crawlytics reports how AI crawlers and assistants interact with ONE website.",
  "Every figure is measured from that site's real server traffic — never simulated prompts.",
  "The site is fixed by the API key used for this connection; there is no site argument.",
  "Bots are split into: ai_training (collects content to train models), ai_search (indexes",
  "content for AI answers) and ai_fetcher (retrieves a page live while answering a user —",
  "the strongest signal that a page is being cited right now).",
  "Start with get_overview, then get_citations for what AI cites and get_crawl_health for",
  "what to fix. All tools are read-only; the generators return text to publish, and change",
  "nothing on the server."
].join(" ");

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

const fail = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON-RPC ids are string | number | null; anything else is not addressable. */
function messageId(message: Record<string, unknown>): string | number | null {
  const id = message["id"];
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** Notifications carry no id at all — the spec forbids replying to them. */
function isNotification(message: Record<string, unknown>): boolean {
  return !Object.hasOwn(message, "id") || message["id"] === undefined;
}

function negotiateVersion(params: unknown): string {
  const requested = isRecord(params) ? params["protocolVersion"] : undefined;
  return typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_LATEST_PROTOCOL_VERSION;
}

async function callTool(
  id: string | number | null,
  params: unknown,
  ctx: McpToolContext
): Promise<JsonRpcResponse> {
  const name = isRecord(params) ? params["name"] : undefined;
  if (typeof name !== "string" || name === "") {
    return fail(id, INVALID_PARAMS, "tools/call requires a string \"name\"");
  }
  const tool = findTool(name);
  if (!tool) {
    return fail(id, INVALID_PARAMS, `unknown tool: ${name}`);
  }
  const args = isRecord(params) ? params["arguments"] : undefined;
  try {
    const output = await tool.run(ctx, args ?? {});
    return ok(id, {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      isError: false
    });
  } catch (error) {
    // A tool failure is data for the model, not a broken transport — but only
    // errors we raised ourselves are safe to echo. A ClickHouse/client failure
    // can carry SQL, schema or host names, so it is logged server-side and the
    // model gets a generic line instead.
    if (error instanceof McpUserError) {
      return ok(id, { content: [{ type: "text", text: `Tool ${name} failed: ${error.message}` }], isError: true });
    }
    ctx.onError?.(error, name);
    return ok(id, {
      content: [{ type: "text", text: `Tool ${name} failed: internal error (details are in the server log)` }],
      isError: true
    });
  }
}

/** Handles one JSON-RPC message. Returns null when the message is a
 * notification and therefore must not be answered. */
export async function handleMcpMessage(message: unknown, ctx: McpToolContext): Promise<JsonRpcResponse | null> {
  if (!isRecord(message) || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") {
    return fail(isRecord(message) ? messageId(message) : null, INVALID_REQUEST, "invalid JSON-RPC 2.0 request");
  }

  const method = message["method"];
  if (isNotification(message)) {
    return null;
  }

  const id = messageId(message);
  const params = message["params"];

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      });
    case "tools/call":
      return callTool(id, params, ctx);
    default:
      return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
  }
}

/** Handles a whole POST body and reports the HTTP status to answer with.
 * Batch arrays are rejected (removed in 2025-06-18, and unbounded work per request). */
export async function handleMcpPayload(
  payload: unknown,
  ctx: McpToolContext
): Promise<{ status: number; body?: unknown }> {
  if (Array.isArray(payload)) {
    // Batching was removed in 2025-06-18, and accepting it here would let one
    // rate-limited HTTP request carry an unbounded number of database-backed
    // tool calls. One message per POST.
    return {
      status: 400,
      body: fail(null, INVALID_REQUEST, "JSON-RPC batching is not supported: send one message per request")
    };
  }

  const response = await handleMcpMessage(payload, ctx);
  if (!response) {
    return { status: 202 };
  }
  // A malformed envelope is a client error; everything else is a 200 carrying
  // either a result or a JSON-RPC error the client is expected to read.
  const status = response.error?.code === INVALID_REQUEST ? 400 : 200;
  return { status, body: response };
}
