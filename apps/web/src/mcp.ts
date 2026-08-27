/** Pure helpers for the MCP connection snippets shown in Setup, kept out of the
 * component so they can be tested without a DOM. */

/** Stand-in shown before a key is minted, so the shape of the setup is visible. */
export const MCP_KEY_PLACEHOLDER = "cwr_YOUR_KEY";

/** The MCP endpoint of THIS dashboard. Derived from the browser origin so a
 * self-hoster on any domain or port gets a snippet that actually works. */
export function mcpEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/u, "")}/mcp`;
}

/** Verified against `claude mcp add --help` (Claude Code 2.x). */
export function claudeCodeCommand(endpoint: string, key: string): string {
  return `claude mcp add --transport http crawlytics ${endpoint} --header "Authorization: Bearer ${key}"`;
}

/** Fallback for any client that takes a URL plus custom headers. */
export function genericClientConfig(endpoint: string, key: string): string {
  return `URL:    ${endpoint}\nHeader: Authorization: Bearer ${key}`;
}
