import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RawLogEvent } from "../src/index.js";
import { tailLogFile, type TailPoster } from "../src/tail.js";

const FIRST_LINE =
  '203.0.113.10 - frank [10/Jun/2026:03:22:01 +0300] "GET /robots.txt HTTP/1.1" 200 412 "-" "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot"';
const SECOND_LINE =
  '2001:db8::1 - - [10/Jun/2026:03:23:02 +0300] "GET /blog/ai-crawlers?utm_source=chatgpt.com HTTP/2" 200 2048 "https://chatgpt.com/" "Mozilla/5.0"';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("tailLogFile", () => {
  it("picks up appended lines across two manual pumps", async () => {
    const file = await createTempLog();
    const batches: RawLogEvent[][] = [];
    const poster: TailPoster = (events) => {
      batches.push([...events]);
      return Promise.resolve();
    };

    const tail = tailLogFile({
      autoStart: false,
      batchSize: 2,
      file,
      format: "apache",
      key: "test-key",
      poster,
      url: "https://analytics.example.com"
    });

    await appendFile(file, `${FIRST_LINE}\n`);
    await tail.pump();
    expect(batches).toEqual([]);

    await appendFile(file, `${SECOND_LINE}\n`);
    await tail.pump();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((event) => event.path)).toEqual([
      "/robots.txt",
      "/blog/ai-crawlers?utm_source=chatgpt.com"
    ]);
    expect(tail.getSummary()).toMatchObject({
      batchesPosted: 1,
      eventsSent: 2,
      linesRead: 2,
      skipped: 0
    });
  });

  it("re-reads from offset 0 after truncation", async () => {
    const file = await createTempLog();
    const batches: RawLogEvent[][] = [];
    const poster: TailPoster = (events) => {
      batches.push([...events]);
      return Promise.resolve();
    };

    const tail = tailLogFile({
      autoStart: false,
      batchSize: 1,
      file,
      format: "apache",
      key: "test-key",
      poster,
      startOffset: 0,
      url: "https://analytics.example.com"
    });

    await appendFile(file, `${FIRST_LINE}\n`);
    await tail.pump();
    await truncate(file, 0);
    await appendFile(file, `${SECOND_LINE}\n`);
    await tail.pump();

    expect(batches.map((batch) => batch.map((event) => event.path))).toEqual([
      ["/robots.txt"],
      ["/blog/ai-crawlers?utm_source=chatgpt.com"]
    ]);
  });
});

async function createTempLog(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crawlytics-tail-"));
  tempDirs.push(directory);
  const file = join(directory, "access.log");
  await writeFile(file, "");
  return file;
}
