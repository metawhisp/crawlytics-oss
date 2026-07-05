import type { RawLogEvent } from "../types.js";
import {
  buildRawLogEvent,
  getFirstField,
  parseJsonRecord,
  parseOptionalSecondsAsMilliseconds
} from "./helpers.js";

export function parseNginxJson(line: string): RawLogEvent | null {
  const record = parseJsonRecord(line);
  if (record === null) {
    return null;
  }

  return buildRawLogEvent({
    ts: getFirstField(record, ["time_iso8601", "time", "timestamp", "ts"]),
    ip: getFirstField(record, ["remote_addr", "ip"]),
    method: getFirstField(record, ["request_method", "method"]),
    path: getFirstField(record, ["request_uri", "uri", "path"]),
    status: getFirstField(record, ["status"]),
    bytes: getFirstField(record, ["body_bytes_sent", "bytes"]),
    referer: getFirstField(record, ["http_referer", "referer", "referrer"]),
    ua: getFirstField(record, ["http_user_agent", "user_agent", "ua"]),
    responseMs: parseOptionalSecondsAsMilliseconds(getFirstField(record, ["request_time"]))
  });
}
