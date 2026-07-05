import { describe, expect, it } from "vitest";

import { dailyIpHash } from "../src/pipeline/ip-hash.js";
import { pathGroup, splitPathQuery } from "../src/pipeline/path-group.js";
import { createSessionizer } from "../src/pipeline/sessionizer.js";

describe("dailyIpHash", () => {
  it("is deterministic for the same ip/secret/day", () => {
    expect(dailyIpHash("203.0.113.10", "s3cret", "2026-06-10")).toBe(
      dailyIpHash("203.0.113.10", "s3cret", "2026-06-10")
    );
  });

  it("changes across days, secrets and ips", () => {
    const base = dailyIpHash("203.0.113.10", "s3cret", "2026-06-10");
    expect(dailyIpHash("203.0.113.10", "s3cret", "2026-06-11")).not.toBe(base);
    expect(dailyIpHash("203.0.113.10", "other", "2026-06-10")).not.toBe(base);
    expect(dailyIpHash("203.0.113.11", "s3cret", "2026-06-10")).not.toBe(base);
  });

  it("returns a decimal string that fits UInt64", () => {
    const value = dailyIpHash("2001:db8::1", "s3cret", "2026-06-10");
    expect(value).toMatch(/^\d+$/);
    expect(BigInt(value) < 2n ** 64n).toBe(true);
  });
});

describe("splitPathQuery", () => {
  it("splits path and query", () => {
    expect(splitPathQuery("/blog/x?a=1&b=2")).toEqual({ pathname: "/blog/x", query: "a=1&b=2" });
    expect(splitPathQuery("/plain")).toEqual({ pathname: "/plain", query: "" });
  });
});

describe("pathGroup", () => {
  const cases: Array<[string, string]> = [
    ["/", "/"],
    ["/blog/my-post", "/blog/my-post"],
    ["/blog/my-post/", "/blog/my-post"],
    ["/users/12345/profile", "/users/:id/profile"],
    ["/orders/550e8400-e29b-41d4-a716-446655440000", "/orders/:id"],
    ["/cache/deadbeefcafe1234", "/cache/:id"],
    ["/docs/v2/api", "/docs/v2/api"],
    ["/file.txt", "/file.txt"],
    ["/a/" + "x".repeat(40), "/a/:id"]
  ];

  it.each(cases)("%s -> %s", (input, expected) => {
    expect(pathGroup(input)).toBe(expected);
  });
});

describe("createSessionizer", () => {
  it("keeps the same session inside the idle window and rolls it forward", () => {
    const sessions = createSessionizer({ windowMs: 30 * 60 * 1000 });
    const t0 = Date.UTC(2026, 5, 10, 12, 0, 0);
    const a = sessions.assign("site|hash|ua", t0);
    const b = sessions.assign("site|hash|ua", t0 + 10 * 60 * 1000);
    // rolling window: the second hit extends the session
    const c = sessions.assign("site|hash|ua", t0 + 35 * 60 * 1000);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("starts a new session after the idle window", () => {
    const sessions = createSessionizer({ windowMs: 30 * 60 * 1000 });
    const t0 = Date.UTC(2026, 5, 10, 12, 0, 0);
    const a = sessions.assign("k", t0);
    const b = sessions.assign("k", t0 + 31 * 60 * 1000);
    expect(b).not.toBe(a);
  });

  it("separates different visitors", () => {
    const sessions = createSessionizer();
    const t0 = Date.now();
    expect(sessions.assign("a", t0)).not.toBe(sessions.assign("b", t0));
  });

  it("returns decimal UInt64 strings", () => {
    const sessions = createSessionizer();
    const id = sessions.assign("k", Date.now());
    expect(id).toMatch(/^\d+$/);
    expect(BigInt(id) < 2n ** 64n).toBe(true);
  });

  it("evicts oldest keys at capacity and recovers gracefully", () => {
    const sessions = createSessionizer({ maxEntries: 2 });
    const t0 = Date.UTC(2026, 5, 10, 12, 0, 0);
    const a1 = sessions.assign("a", t0);
    sessions.assign("b", t0 + 1000);
    sessions.assign("c", t0 + 2000); // evicts "a"
    const a2 = sessions.assign("a", t0 + 3000); // new session for "a"
    expect(a2).not.toBe(a1);
  });
});
