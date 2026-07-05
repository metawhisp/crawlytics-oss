import { describe, expect, it } from "vitest";

import { parseLine, parseNginxCombined } from "../src/index.js";

describe("@crawlytics/ingest-cli public API", () => {
  it("exports parser functions", () => {
    const line =
      '203.0.113.10 - - [10/Jun/2026:03:22:01 +0300] "GET / HTTP/1.1" 200 1 "-" "-"';

    expect(parseLine(line, "nginx-combined")).toEqual(parseNginxCombined(line));
  });
});
