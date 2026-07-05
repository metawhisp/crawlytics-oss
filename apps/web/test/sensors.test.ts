import { describe, expect, it } from "vitest";

import { curlSnippet, workerSnippet } from "../src/sensors.js";

const INGEST = "https://analytics.example.com/api/ingest";
const KEY = "cwi_testkey123";

describe("curlSnippet", () => {
  it("targets the ingest URL with the bearer key", () => {
    const snippet = curlSnippet(INGEST, KEY);
    expect(snippet).toContain(`"${INGEST}"`);
    expect(snippet).toContain(`Bearer ${KEY}`);
  });

  it("embeds a parseable, well-formed ingest batch", () => {
    const snippet = curlSnippet(INGEST, KEY);
    const json = snippet.slice(snippet.indexOf("{"), snippet.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { events: Array<Record<string, unknown>> };
    expect(parsed.events).toHaveLength(1);
    const event = parsed.events[0] ?? {};
    expect(event).toMatchObject({ method: "GET", status: 200, ua: "GPTBot/1.3" });
    expect(Number.isNaN(Date.parse(String(event["ts"])))).toBe(false);
  });
});

describe("workerSnippet", () => {
  it("bakes in the ingest URL and key with no unfilled template holes", () => {
    const snippet = workerSnippet(INGEST, KEY);
    expect(snippet).toContain(`const INGEST = "${INGEST}"`);
    expect(snippet).toContain(`Bearer ${KEY}`);
    expect(snippet).not.toMatch(/\$\{/u); // every placeholder was substituted
  });

  it("keeps the published sensor's safety behaviour", () => {
    const snippet = workerSnippet(INGEST, KEY);
    expect(snippet).toContain("ctx.waitUntil"); // background report
    expect(snippet).toContain("cf-connecting-ip");
    expect(snippet).toContain("url.host !== new URL(INGEST).host"); // no self-report loop
    expect(snippet).toContain(".catch(() => {})"); // fail-open
  });
});
