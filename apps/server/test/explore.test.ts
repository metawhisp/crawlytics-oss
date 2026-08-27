import { describe, expect, it, vi } from "vitest";

import { EXPLORE_DIMENSIONS, EXPLORE_METRICS, exploreQuery } from "../src/explore.js";

function fakeClient(rows: unknown[]) {
  const captured: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
  return {
    captured,
    query: vi.fn((options: { query: string; query_params?: Record<string, unknown> }) => {
      captured.push(options);
      return Promise.resolve({ json: () => Promise.resolve(rows) });
    })
  };
}

describe("exploreQuery", () => {
  it("builds a parameterized breakdown for every metric × dimension", async () => {
    for (const metric of Object.keys(EXPLORE_METRICS)) {
      for (const dimension of Object.keys(EXPLORE_DIMENSIONS)) {
        const client = fakeClient([{ key: "gptbot", value: "5" }]);
        const rows = await exploreQuery(client, {
          site: "acme",
          hours: 24,
          metric,
          dimension,
          filters: {}
        });
        expect(rows[0]).toEqual({ key: "gptbot", value: 5 });
        const captured = client.captured[0];
        expect(captured?.query_params).toMatchObject({ site: "acme", hours: 24 });
        expect(captured?.query).not.toContain("acme");
      }
    }
  });

  it("applies whitelisted filters as parameters", async () => {
    const client = fakeClient([]);
    await exploreQuery(client, {
      site: "s",
      hours: 24,
      metric: "hits",
      dimension: "bot_id",
      filters: { actor_type: "ai_training", verification: "spoofed", country: "NL" }
    });
    const captured = client.captured[0];
    expect(captured?.query).toContain("actor_type = {f_actor_type:String}");
    expect(captured?.query).toContain("verification = {f_verification:String}");
    expect(captured?.query).toContain("country = {f_country:String}");
    expect(captured?.query_params).toMatchObject({
      f_actor_type: "ai_training",
      f_verification: "spoofed",
      f_country: "NL"
    });
  });

  it("rejects Object.prototype keys — a truthiness lookup would splice a function into the SQL", async () => {
    const client = fakeClient([]);
    for (const inherited of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      await expect(
        exploreQuery(client, { site: "s", hours: 1, metric: inherited, dimension: "bot_id", filters: {} })
      ).rejects.toThrow(/metric/u);
      await expect(
        exploreQuery(client, { site: "s", hours: 1, metric: "hits", dimension: inherited, filters: {} })
      ).rejects.toThrow(/dimension/u);
      await expect(
        exploreQuery(client, { site: "s", hours: 1, metric: "hits", dimension: "bot_id", filters: { [inherited]: "x" } })
      ).rejects.toThrow(/filter/u);
    }
    expect(client.captured).toHaveLength(0);
  });

  it("rejects unknown metric, dimension and filter keys", async () => {
    const client = fakeClient([]);
    await expect(
      exploreQuery(client, { site: "s", hours: 1, metric: "drop table", dimension: "bot_id", filters: {} })
    ).rejects.toThrow(/metric/);
    await expect(
      exploreQuery(client, { site: "s", hours: 1, metric: "hits", dimension: "ua; --", filters: {} })
    ).rejects.toThrow(/dimension/);
    await expect(
      exploreQuery(client, {
        site: "s",
        hours: 1,
        metric: "hits",
        dimension: "bot_id",
        filters: { evil: "x" }
      })
    ).rejects.toThrow(/filter/);
  });
});
