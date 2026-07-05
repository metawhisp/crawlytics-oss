import type { RawLogEvent } from "../types.js";
import {
  buildRawLogEvent,
  getFirstField,
  getFirstHeader,
  getValueAtPath,
  parseJsonRecord,
  parseOptionalSecondsAsMilliseconds
} from "./helpers.js";

export function parseCaddyJson(line: string): RawLogEvent | null {
  const record = parseJsonRecord(line);
  if (record === null) {
    return null;
  }

  const headers = getValueAtPath(record, "request.headers");

  return buildRawLogEvent({
    ts: getFirstField(record, ["ts"]),
    ip: getValueAtPath(record, "request.remote_ip"),
    method: getValueAtPath(record, "request.method"),
    path: getValueAtPath(record, "request.uri"),
    status: getFirstField(record, ["status"]),
    bytes: getFirstField(record, ["size"]),
    referer: getFirstHeader(headers, ["Referer", "referer"]),
    ua: getFirstHeader(headers, ["User-Agent", "user-agent"]),
    responseMs: parseOptionalSecondsAsMilliseconds(getFirstField(record, ["duration"]))
  });
}
