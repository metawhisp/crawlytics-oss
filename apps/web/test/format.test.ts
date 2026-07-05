import { describe, expect, it } from "vitest";

import { fmtNum, timeAgo, verifiedShare } from "../src/format.js";

describe("fmtNum", () => {
  it("formats magnitudes", () => {
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(999)).toBe("999");
    expect(fmtNum(1500)).toBe("1.5K");
    expect(fmtNum(25000)).toBe("25K");
    expect(fmtNum(2_400_000)).toBe("2.4M");
  });
});

describe("timeAgo", () => {
  const now = Date.UTC(2026, 5, 10, 20, 0, 0);
  it("renders relative time from ClickHouse UTC timestamps", () => {
    expect(timeAgo("2026-06-10 19:59:40", now)).toBe("now");
    expect(timeAgo("2026-06-10 19:31:00", now)).toBe("29m ago");
    expect(timeAgo("2026-06-10 02:00:00", now)).toBe("18h ago");
    expect(timeAgo("2026-06-01 02:00:00", now)).toBe("9d ago");
  });
  it("falls back to raw value on garbage", () => {
    expect(timeAgo("nope", now)).toBe("nope");
  });
});

describe("verifiedShare", () => {
  it("computes the share of verified among verifiable", () => {
    expect(verifiedShare(3, 1)).toBe("75%");
    expect(verifiedShare(0, 0)).toBe("—");
  });
});
