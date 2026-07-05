import { describe, expect, it } from "vitest";

import { RangeSet, extractCidrs, parseCidr, parseIp } from "../src/verify/cidr.js";

describe("parseIp", () => {
  it("parses IPv4", () => {
    expect(parseIp("0.0.0.0")).toEqual({ family: 4, value: 0n });
    expect(parseIp("255.255.255.255")).toEqual({ family: 4, value: 4294967295n });
    expect(parseIp("66.249.66.1")?.family).toBe(4);
  });

  it("parses IPv6 incl. compressed forms", () => {
    expect(parseIp("::1")).toEqual({ family: 6, value: 1n });
    expect(parseIp("2001:db8::")?.family).toBe(6);
    expect(parseIp("2a03:2880:f800:8::")?.family).toBe(6);
  });

  it("normalizes IPv4-mapped IPv6 to IPv4", () => {
    expect(parseIp("::ffff:192.0.2.128")).toEqual(parseIp("192.0.2.128"));
  });

  it("rejects garbage", () => {
    for (const bad of ["", "-", "256.1.1.1", "1.2.3", "1.2.3.4.5", "2001:::1", "::ffff:999.0.0.1", "abc"]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });
});

describe("parseCidr", () => {
  it("parses IPv4 CIDR", () => {
    const range = parseCidr("192.168.1.0/24");
    expect(range?.family).toBe(4);
    expect(range?.end ?? 0n).toBe((range?.start ?? 0n) + 255n);
  });

  it("parses IPv6 CIDR", () => {
    expect(parseCidr("2001:db8::/32")?.family).toBe(6);
  });

  it("treats a bare IP as a host route", () => {
    const range = parseCidr("66.249.66.1");
    expect(range?.start).toBe(range?.end);
  });

  it("rejects invalid prefixes", () => {
    for (const bad of ["1.2.3.0/33", "2001:db8::/129", "1.2.3.0/-1", "1.2.3.0/abc", "nope/24"]) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });
});

describe("RangeSet", () => {
  const set = new RangeSet(
    ["66.249.64.0/19", "192.168.1.0/24", "2001:db8::/32", "10.0.0.5"].map((cidr) => {
      const range = parseCidr(cidr);
      if (!range) throw new Error(`bad fixture ${cidr}`);
      return range;
    })
  );

  it("matches inside ranges across families", () => {
    expect(set.contains("66.249.66.1")).toBe(true);
    expect(set.contains("66.249.95.255")).toBe(true);
    expect(set.contains("192.168.1.42")).toBe(true);
    expect(set.contains("10.0.0.5")).toBe(true);
    expect(set.contains("2001:db8:dead::beef")).toBe(true);
    expect(set.contains("::ffff:66.249.66.1")).toBe(true);
  });

  it("rejects outside ranges", () => {
    expect(set.contains("66.249.96.0")).toBe(false);
    expect(set.contains("8.8.8.8")).toBe(false);
    expect(set.contains("10.0.0.6")).toBe(false);
    expect(set.contains("2001:db9::1")).toBe(false);
    expect(set.contains("not-an-ip")).toBe(false);
  });

  it("merges overlapping ranges", () => {
    const ranges = ["10.0.0.0/24", "10.0.0.128/25", "10.0.1.0/24"].map((c) => parseCidr(c));
    const merged = new RangeSet(ranges.filter((r) => r !== null));
    // 10.0.0.0/24 absorbs /25; 10.0.1.0/24 is adjacent -> merged into one span
    expect(merged.size).toBe(1);
    expect(merged.contains("10.0.0.200")).toBe(true);
    expect(merged.contains("10.0.1.255")).toBe(true);
    expect(merged.contains("10.0.2.0")).toBe(false);
  });
});

describe("extractCidrs", () => {
  it("extracts OpenAI-style prefix documents", () => {
    const doc = {
      creationTime: "2026-05-01T00:00:00.000000",
      prefixes: [
        { ipv4Prefix: "52.230.152.0/24" },
        { ipv4Prefix: "20.171.206.0/24" },
        { ipv6Prefix: "2a01:111::/32" }
      ]
    };
    expect(extractCidrs(doc)).toEqual(["52.230.152.0/24", "20.171.206.0/24", "2a01:111::/32"]);
  });

  it("extracts from arbitrary nested shapes and dedupes", () => {
    const doc = {
      meta: { note: "not 1.2.3.4/24 inside text should be ignored as part of a sentence? no — bare strings only" },
      a: ["17.0.0.0/8", { b: { c: "17.0.0.0/8" } }],
      d: "57.140.128.0/18",
      e: ["names", "v1.2", "2024-01-01", 42, null]
    };
    expect(extractCidrs(doc)).toEqual(["17.0.0.0/8", "57.140.128.0/18"]);
  });

  it("accepts bare IP strings as host routes", () => {
    expect(extractCidrs({ ips: ["66.249.66.1", "2001:db8::1"] })).toEqual(["66.249.66.1", "2001:db8::1"]);
  });

  it("returns empty for documents without addresses", () => {
    expect(extractCidrs({ hello: "world", n: 5 })).toEqual([]);
  });
});
