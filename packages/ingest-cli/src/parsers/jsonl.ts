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
    // A log that does not record response size is a log, not a broken one: the
    // ingest schema defaults bytes to 0. buildRawLogEvent refuses an event
    // without it — right for apache and nginx, where a missing size means a
    // malformed line, and wrong here, where the field simply was not mapped.
    bytes: fieldMap["bytes"] === undefined ? 0 : getMappedValue("bytes"),
    referer: getMappedValue("referer"),
    ua: getMappedValue("ua"),
    responseMs: parseOptionalMilliseconds(getMappedValue("responseMs"))
  });
}
