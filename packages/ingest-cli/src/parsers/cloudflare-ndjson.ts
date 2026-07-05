import type { RawLogEvent } from "../types.js";
import {
  buildRawLogEvent,
  getFirstField,
  parseJsonRecord,
  parseOptionalMilliseconds
} from "./helpers.js";

export function parseCloudflareNdjson(line: string): RawLogEvent | null {
  const record = parseJsonRecord(line);
  if (record === null) {
    return null;
  }

  return buildRawLogEvent({
    ts: getFirstField(record, ["EdgeStartTimestamp"]),
    ip: getFirstField(record, ["ClientIP"]),
    method: getFirstField(record, ["ClientRequestMethod"]),
    path: getFirstField(record, ["ClientRequestURI"]),
    status: getFirstField(record, ["EdgeResponseStatus"]),
    bytes: getFirstField(record, ["EdgeResponseBytes"]),
    referer: getFirstField(record, ["ClientRequestReferer"]),
    ua: getFirstField(record, ["ClientRequestUserAgent"]),
    responseMs: parseOptionalMilliseconds(getFirstField(record, ["OriginResponseDurationMs"]))
  });
}
