import type { LogFormat, RawLogEvent } from "../types.js";
import { parseApache } from "./apache.js";
import { parseCaddyJson } from "./caddy-json.js";
import { parseCloudflareNdjson } from "./cloudflare-ndjson.js";
import { parseJsonl } from "./jsonl.js";
import { parseNginxCombined } from "./nginx-combined.js";
import { parseNginxJson } from "./nginx-json.js";

export function parseLine(
  line: string,
  format: LogFormat,
  fieldMap?: Record<string, string>
): RawLogEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    switch (format) {
      case "apache":
        return parseApache(trimmed);
      case "nginx-combined":
        return parseNginxCombined(trimmed);
      case "nginx-json":
        return parseNginxJson(trimmed);
      case "caddy-json":
        return parseCaddyJson(trimmed);
      case "cloudflare-ndjson":
        return parseCloudflareNdjson(trimmed);
      case "jsonl":
        return fieldMap === undefined ? null : parseJsonl(trimmed, fieldMap);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export { parseApache } from "./apache.js";
export { parseCaddyJson } from "./caddy-json.js";
export { parseCloudflareNdjson } from "./cloudflare-ndjson.js";
export { parseJsonl } from "./jsonl.js";
export { parseNginxCombined } from "./nginx-combined.js";
export { parseNginxJson } from "./nginx-json.js";
