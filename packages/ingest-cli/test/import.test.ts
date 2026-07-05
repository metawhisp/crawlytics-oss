import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { RawLogEvent } from "../src/index.js";
import { importLogFile, type ImportPoster } from "../src/import.js";

describe("importLogFile", () => {
  it("parses a fixture, dedupes repeated raw lines, and posts batches", async () => {
    const batches: RawLogEvent[][] = [];
    const poster: ImportPoster = (events) => {
      batches.push([...events]);
      return Promise.resolve();
    };

    const summary = await importLogFile({
      batchSize: 3,
      file: fixturePath("apache.log"),
      format: "apache",
      key: "test-key",
      poster,
      url: "https://analytics.example.com"
    });

    expect(summary).toEqual({
      batchesPosted: 3,
      eventsSent: 7,
      linesRead: 10,
      skipped: 3
    });
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(batches.flat()).toHaveLength(7);
    expect(batches.flat().filter((event) => event.path === "/robots.txt")).toHaveLength(1);
  });
});

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}
