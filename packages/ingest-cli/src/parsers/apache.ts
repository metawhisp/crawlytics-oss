import type { RawLogEvent } from "../types.js";
import {
  parseBytes,
  parseLogString,
  parseMethod,
  parseNginxLocalTime,
  parsePath,
  parseStatus
} from "./helpers.js";

const APACHE_PATTERN =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "((?:\\.|[^"\\])*)" (\d{3}) (\d+|-)(?: "((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)")?$/;
const REQUEST_PATTERN = /^([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*) ([^\s]+) HTTP\/\d(?:\.\d)?$/;

export function parseApache(line: string): RawLogEvent | null {
  const match = APACHE_PATTERN.exec(line);
  if (match === null) {
    return null;
  }

  const [, ip, timeLocal, requestText, statusText, bytesText, refererText, uaText] = match;

  if (
    ip === undefined ||
    timeLocal === undefined ||
    requestText === undefined ||
    statusText === undefined ||
    bytesText === undefined
  ) {
    return null;
  }

  const request = parseRequest(unescapeLogField(requestText));
  const ts = parseNginxLocalTime(timeLocal);
  const status = parseStatus(statusText);
  const bytes = parseBytes(bytesText);

  if (request === null || ts === null || status === null || bytes === null) {
    return null;
  }

  return {
    ts,
    ip,
    method: request.method,
    path: request.path,
    status,
    bytes,
    ua: parseLogString(unescapeLogField(uaText)),
    referer: parseLogString(unescapeLogField(refererText))
  };
}

function parseRequest(value: string): { method: string; path: string } | null {
  const match = REQUEST_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  const [, methodText, pathText] = match;

  if (methodText === undefined || pathText === undefined) {
    return null;
  }

  const method = parseMethod(methodText);
  const path = parsePath(pathText);

  return method === null || path === null ? null : { method, path };
}

function unescapeLogField(value: string | undefined): string {
  return value === undefined ? "" : value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}
