import { describe, expect, it } from "vitest";

import { MCP_KEY_PLACEHOLDER, claudeCodeCommand, genericClientConfig, mcpEndpoint } from "../src/mcp.js";

describe("mcpEndpoint", () => {
  it("appends /mcp to the dashboard origin", () => {
    expect(mcpEndpoint("https://analytics.example.com")).toBe("https://analytics.example.com/mcp");
  });

  it("does not double the slash when the origin has a trailing one", () => {
    expect(mcpEndpoint("https://analytics.example.com/")).toBe("https://analytics.example.com/mcp");
    expect(mcpEndpoint("https://analytics.example.com///")).toBe("https://analytics.example.com/mcp");
  });

  it("keeps a non-default port (self-hosters run on :3000 etc.)", () => {
    expect(mcpEndpoint("http://localhost:3000")).toBe("http://localhost:3000/mcp");
  });
});

describe("connection snippets", () => {
  const endpoint = "https://analytics.example.com/mcp";

  it("builds a Claude Code command with an http transport and a quoted auth header", () => {
    const command = claudeCodeCommand(endpoint, "cwr_abc123");
    expect(command).toContain("--transport http");
    expect(command).toContain(endpoint);
    expect(command).toContain('--header "Authorization: Bearer cwr_abc123"');
  });

  it("puts the key inside the quotes so the shell keeps the header in one argument", () => {
    const command = claudeCodeCommand(endpoint, "cwr_abc123");
    const header = /--header "([^"]+)"/u.exec(command)?.[1];
    expect(header).toBe("Authorization: Bearer cwr_abc123");
  });

  it("uses a visible placeholder before a real key exists", () => {
    expect(claudeCodeCommand(endpoint, MCP_KEY_PLACEHOLDER)).toContain(MCP_KEY_PLACEHOLDER);
    expect(MCP_KEY_PLACEHOLDER.startsWith("cwr_")).toBe(true);
  });

  it("offers a client-agnostic URL + header pair", () => {
    const config = genericClientConfig(endpoint, "cwr_abc123");
    expect(config.split("\n")).toHaveLength(2);
    expect(config).toContain(endpoint);
    expect(config).toContain("Authorization: Bearer cwr_abc123");
  });
});
