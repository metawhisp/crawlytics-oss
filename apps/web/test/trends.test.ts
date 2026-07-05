import { describe, expect, it } from "vitest";

import type { PagesDaily } from "../src/api.js";
import { buildLineSeries, defaultSelected, MAX_SELECTED, toggleSelected } from "../src/trends.js";

const pages = Array.from({ length: 12 }, (_, i) => ({ page: `/p${String(i)}`, total: 120 - i * 10 }));

describe("defaultSelected", () => {
  it("pre-selects the top-10 most popular pages, in order", () => {
    const sel = defaultSelected(pages);
    expect(sel).toHaveLength(MAX_SELECTED);
    expect(sel[0]).toBe("/p0");
    expect(sel[9]).toBe("/p9");
    expect(sel).not.toContain("/p10");
  });

  it("returns all pages when there are fewer than the cap", () => {
    expect(defaultSelected(pages.slice(0, 3))).toEqual(["/p0", "/p1", "/p2"]);
  });

  it("returns an empty array when there are no pages", () => {
    expect(defaultSelected([])).toEqual([]);
  });
});

describe("toggleSelected", () => {
  it("removes a selected page", () => {
    expect(toggleSelected(["/a", "/b"], "/a")).toEqual(["/b"]);
  });

  it("adds an unselected page when under the cap", () => {
    expect(toggleSelected(["/a"], "/b")).toEqual(["/a", "/b"]);
  });

  it("ignores adding past the cap (no-op)", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `/p${String(i)}`);
    expect(toggleSelected(ten, "/new")).toEqual(ten);
  });

  it("still allows removing when at the cap", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `/p${String(i)}`);
    expect(toggleSelected(ten, "/p0")).toHaveLength(9);
  });
});

describe("buildLineSeries", () => {
  const data: PagesDaily = {
    dates: ["2026-06-01", "2026-06-02"],
    pages: [
      { page: "/a", total: 30 },
      { page: "/b", total: 20 },
      { page: "/c", total: 10 }
    ],
    series: [
      { page: "/a", hits: [10, 20] },
      { page: "/b", hits: [5, 15] },
      { page: "/c", hits: [4, 6] }
    ]
  };

  it("keeps only selected pages, preserving popularity order", () => {
    expect(buildLineSeries(data, ["/c", "/a"])).toEqual([
      { name: "/a", data: [10, 20] },
      { name: "/c", data: [4, 6] }
    ]);
  });

  it("returns nothing when no pages are selected", () => {
    expect(buildLineSeries(data, [])).toEqual([]);
  });
});
