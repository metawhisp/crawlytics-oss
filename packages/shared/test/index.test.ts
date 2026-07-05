import { describe, expect, it } from "vitest";

import { ingestBatchSchema, rawLogEventSchema } from "../src/index.js";

const VALID_EVENT = {
  ts: "2026-06-10T03:22:01.000Z",
  ip: "203.0.113.10",
  method: "GET",
  path: "/robots.txt",
  status: 200,
  bytes: 412,
  ua: "GPTBot/1.3",
  referer: ""
};

describe("rawLogEventSchema", () => {
  it("accepts a valid event and applies defaults", () => {
    const parsed = rawLogEventSchema.parse({
      ts: "2026-06-10T03:22:01+03:00",
      ip: "2001:db8::1",
      method: "POST",
      path: "/x?a=1",
      status: 503
    });
    expect(parsed.bytes).toBe(0);
    expect(parsed.ua).toBe("");
    expect(parsed.referer).toBe("");
  });

  it("rejects bad timestamps, statuses and missing fields", () => {
    expect(rawLogEventSchema.safeParse({ ...VALID_EVENT, ts: "yesterday" }).success).toBe(false);
    expect(rawLogEventSchema.safeParse({ ...VALID_EVENT, status: 1234 }).success).toBe(false);
    expect(rawLogEventSchema.safeParse({ ...VALID_EVENT, ip: "" }).success).toBe(false);
    const withoutPath = { ts: VALID_EVENT.ts, ip: VALID_EVENT.ip, method: VALID_EVENT.method, status: VALID_EVENT.status };
    expect(rawLogEventSchema.safeParse(withoutPath).success).toBe(false);
  });
});

describe("ingestBatchSchema", () => {
  it("requires 1..5000 events", () => {
    expect(ingestBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(ingestBatchSchema.safeParse({ events: [VALID_EVENT] }).success).toBe(true);
  });
});
