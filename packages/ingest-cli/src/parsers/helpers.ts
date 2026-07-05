import type { RawLogEvent } from "../types.js";

export type JsonRecord = Record<string, unknown>;

interface RawLogEventParts {
  ts: unknown;
  ip: unknown;
  method: unknown;
  path: unknown;
  status: unknown;
  bytes: unknown;
  ua: unknown;
  referer: unknown;
  responseMs?: number | undefined;
}

const TOKEN_METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/;
const NUMERIC_STRING_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;
const BIG_INTEGER_PATTERN = /^\d{16,}$/;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonRecord(line: string): JsonRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function getFirstField(record: JsonRecord, names: readonly string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(record, name)) {
      return record[name];
    }
  }

  return undefined;
}

export function getValueAtPath(record: JsonRecord, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = record;

  for (const segment of segments) {
    if (segment.length === 0) {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number(segment);

      if (!Number.isInteger(index) || index < 0) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

export function getFirstHeader(headers: unknown, names: readonly string[]): unknown {
  if (!isRecord(headers)) {
    return undefined;
  }

  for (const name of names) {
    const value = headers[name];
    if (Array.isArray(value)) {
      return value[0];
    }

    if (value !== undefined) {
      return value;
    }
  }

  const lowerNames = names.map((name) => name.toLowerCase());

  for (const [key, value] of Object.entries(headers)) {
    if (!lowerNames.includes(key.toLowerCase())) {
      continue;
    }

    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  return undefined;
}

export function buildRawLogEvent(parts: RawLogEventParts): RawLogEvent | null {
  const ts = normalizeTimestamp(parts.ts);
  const ip = parseRequiredString(parts.ip);
  const method = parseMethod(parts.method);
  const path = parsePath(parts.path);
  const status = parseStatus(parts.status);
  const bytes = parseBytes(parts.bytes);

  if (
    ts === null ||
    ip === null ||
    method === null ||
    path === null ||
    status === null ||
    bytes === null
  ) {
    return null;
  }

  const base = {
    ts,
    ip,
    method,
    path,
    status,
    bytes,
    ua: parseLogString(parts.ua),
    referer: parseLogString(parts.referer)
  };

  return parts.responseMs === undefined ? base : { ...base, responseMs: parts.responseMs };
}

export function parseLogString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value === "-" ? "" : value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }

  return "";
}

export function parseRequiredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === "-" ? null : trimmed;
}

export function parseMethod(value: unknown): string | null {
  const raw = parseRequiredString(value);
  if (raw === null) {
    return null;
  }

  const method = raw.toUpperCase();
  return TOKEN_METHOD_PATTERN.test(method) ? method : null;
}

export function parsePath(value: unknown): string | null {
  const raw = parseRequiredString(value);
  if (raw === null) {
    return null;
  }

  if (/\s/u.test(raw)) {
    return null;
  }

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const parsed = new URL(raw);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }

  return raw;
}

export function parseStatus(value: unknown): number | null {
  const parsed = parseInteger(value);
  if (parsed === null) {
    return null;
  }

  return parsed >= 100 && parsed <= 999 ? parsed : null;
}

export function parseBytes(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "-") {
    return 0;
  }

  const parsed = parseInteger(value);
  if (parsed === null) {
    return null;
  }

  return parsed >= 0 ? parsed : null;
}

export function parseOptionalMilliseconds(value: unknown): number | undefined {
  const milliseconds = parseOptionalNonNegativeNumber(value);
  return milliseconds === undefined ? undefined : roundMilliseconds(milliseconds);
}

export function parseOptionalSecondsAsMilliseconds(value: unknown): number | undefined {
  const seconds = parseOptionalNonNegativeNumber(value);
  return seconds === undefined ? undefined : roundMilliseconds(seconds * 1000);
}

export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "number") {
    return normalizeNumericTimestamp(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const raw = value.trim();
  if (raw.length === 0 || raw === "-") {
    return null;
  }

  if (BIG_INTEGER_PATTERN.test(raw)) {
    return normalizeEpochNanoseconds(raw);
  }

  if (NUMERIC_STRING_PATTERN.test(raw)) {
    return normalizeNumericTimestamp(Number(raw));
  }

  const millis = Date.parse(raw);
  return Number.isNaN(millis) ? null : isoFromMilliseconds(millis);
}

export function parseNginxLocalTime(value: string): string | null {
  const match =
    /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
      value
    );

  if (match === null) {
    return null;
  }

  const [, dayText, monthText, yearText, hourText, minuteText, secondText, sign, tzHourText, tzMinuteText] =
    match;
  const month = parseMonth(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const tzHour = Number(tzHourText);
  const tzMinute = Number(tzMinuteText);

  if (
    month === null ||
    !isValidDateTimePart(day, 1, 31) ||
    !isValidDateTimePart(hour, 0, 23) ||
    !isValidDateTimePart(minute, 0, 59) ||
    !isValidDateTimePart(second, 0, 59) ||
    !isValidDateTimePart(tzHour, 0, 23) ||
    !isValidDateTimePart(tzMinute, 0, 59)
  ) {
    return null;
  }

  const localMillis = Date.UTC(year, month, day, hour, minute, second);
  const localDate = new Date(localMillis);
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second
  ) {
    return null;
  }

  const offsetMillis = (tzHour * 60 + tzMinute) * 60 * 1000;
  const utcMillis = sign === "+" ? localMillis - offsetMillis : localMillis + offsetMillis;
  return isoFromMilliseconds(utcMillis);
}

function parseInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  return Number(trimmed);
}

function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === "-") {
      return undefined;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  return undefined;
}

function normalizeNumericTimestamp(value: number): string | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000_000_000) {
    return isoFromMilliseconds(value / 1_000_000);
  }

  if (absolute >= 1_000_000_000_000) {
    return isoFromMilliseconds(value);
  }

  return isoFromMilliseconds(value * 1000);
}

function normalizeEpochNanoseconds(value: string): string | null {
  try {
    const nanos = BigInt(value);
    const millis = nanos / 1_000_000n;
    if (millis > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }

    return isoFromMilliseconds(Number(millis));
  } catch {
    return null;
  }
}

function isoFromMilliseconds(value: number): string | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseMonth(value: string | undefined): number | null {
  switch (value) {
    case "Jan":
      return 0;
    case "Feb":
      return 1;
    case "Mar":
      return 2;
    case "Apr":
      return 3;
    case "May":
      return 4;
    case "Jun":
      return 5;
    case "Jul":
      return 6;
    case "Aug":
      return 7;
    case "Sep":
      return 8;
    case "Oct":
      return 9;
    case "Nov":
      return 10;
    case "Dec":
      return 11;
    default:
      return null;
  }
}

function isValidDateTimePart(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
