import type { RawLogEvent } from "../types.js";
import {
  buildRawLogEvent,
  getValueAtPath,
  parseJsonRecord,
  parseOptionalMilliseconds
} from "./helpers.js";

export function parseJsonl(line: string, fieldMap: Record<string, string>): RawLogEvent | null {
  const record = parseJsonRecord(line);
  if (record === null) {
    return null;
  }

  const getMappedValue = (key: keyof RawLogEvent): unknown => {
    const path = fieldMap[key];
    return path === undefined ? undefined : getValueAtPath(record, path);
  };

  return buildRawLogEvent({
    ts: getMappedValue("ts"),
    ip: getMappedValue("ip"),
    method: getMappedValue("method"),
    path: getMappedValue("path"),
    status: getMappedValue("status"),
    bytes: getMappedValue("bytes"),
    referer: getMappedValue("referer"),
    ua: getMappedValue("ua"),
    responseMs: parseOptionalMilliseconds(getMappedValue("responseMs"))
  });
}
