import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseLine, type LogFormat, type RawLogEvent } from "../src/index.js";

interface ParserCase {
  fieldMap?: Record<string, string>;
  format: LogFormat;
  nullCount: number;
}

const JSONL_FIELD_MAP = {
  bytes: "response.bytes",
  ip: "client.ip",
  method: "http.method",
  path: "http.target",
  referer: "headers.referer",
  responseMs: "timing.responseMs",
  status: "response.status",
  ts: "when",
  ua: "headers.ua"
} satisfies Record<string, string>;

const CASES: readonly ParserCase[] = [
  { format: "apache", nullCount: 2 },
  { format: "nginx-combined", nullCount: 2 },
  { format: "nginx-json", nullCount: 1 },
  { format: "caddy-json", nullCount: 1 },
  { format: "cloudflare-ndjson", nullCount: 1 },
  { fieldMap: JSONL_FIELD_MAP, format: "jsonl", nullCount: 1 }
];

describe("log parsers", () => {
  for (const parserCase of CASES) {
    it(`parses ${parserCase.format} fixture lines against the golden file`, () => {
      const lines = readFixtureLines(parserCase.format);
      const expected = readExpectedEvents(parserCase.format);
      const parsed = lines.map((line) => parseLine(line, parserCase.format, parserCase.fieldMap));
      const actual = parsed.filter((event): event is RawLogEvent => event !== null);
      const nullCount = parsed.length - actual.length;

      expect(lines.length).toBeGreaterThanOrEqual(8);
      expect(actual).toEqual(expected);
      expect(nullCount).toBe(lines.length - expected.length);
      expect(nullCount).toBe(parserCase.nullCount);
      expect(nullCount).toBeGreaterThan(0);
    });
  }

  it("never throws for garbage input", () => {
    for (const parserCase of CASES) {
      for (let index = 0; index < 50; index += 1) {
        const garbage = randomBytes(32).toString("latin1");

        expect(() => parseLine(garbage, parserCase.format, parserCase.fieldMap)).not.toThrow();
      }
    }
  });

  it("converts nginx local time offsets to the same instant", () => {
    const event = parseLine(
      '203.0.113.10 - - [10/Jun/2026:03:22:01 +0300] "GET / HTTP/1.1" 200 1 "-" "-"',
      "nginx-combined"
    );

    if (event === null) {
      throw new Error("expected nginx timezone fixture to parse");
    }

    expect(event.ts).toBe("2026-06-10T00:22:01.000Z");
    expect(new Date(event.ts).getTime()).toBe(Date.UTC(2026, 5, 10, 0, 22, 1));
  });
});

function fixtureUrl(name: string): URL {
  return new URL(`./fixtures/${name}`, import.meta.url);
}

function readExpectedEvents(format: LogFormat): RawLogEvent[] {
  const parsed: unknown = JSON.parse(
    readFileSync(fixtureUrl(`${format}.expected.json`), "utf8")
  );

  if (!isRawLogEventArray(parsed)) {
    throw new Error(`invalid expected fixture for ${format}`);
  }

  return parsed;
}

function readFixtureLines(format: LogFormat): string[] {
  const text = readFileSync(fixtureUrl(`${format}.log`), "utf8").trimEnd();

  return text.length === 0 ? [] : text.split(/\r?\n/u);
}

function isRawLogEventArray(value: unknown): value is RawLogEvent[] {
  return Array.isArray(value) && value.every(isRawLogEvent);
}

function isRawLogEvent(value: unknown): value is RawLogEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.ts === "string" &&
    typeof record.ip === "string" &&
    typeof record.method === "string" &&
    typeof record.path === "string" &&
    typeof record.status === "number" &&
    typeof record.bytes === "number" &&
    typeof record.ua === "string" &&
    typeof record.referer === "string" &&
    (record.responseMs === undefined || typeof record.responseMs === "number")
  );
}
