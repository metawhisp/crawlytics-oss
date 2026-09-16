import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RawLogEvent } from "../src/index.js";
import { formatImportSummary, importExitCode } from "../src/import.js";
import { formatTailHeartbeat, tailLogFile, type TailPoster } from "../src/tail.js";

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

describe("tailLogFile when the server refuses", () => {
  // The server batcher restores its batch unconditionally, with a comment
  // saying these events were accepted so losing them is never an option. The
  // CLI sensor that feeds it did the opposite: `batch.splice(...)` ran BEFORE
  // the await, the read offset had already moved past those lines, and a
  // rejected post left them referenced by nothing at all.
  it("keeps the events a refused post never delivered", async () => {
    const file = await createTempLog();
    const delivered: string[] = [];
    let refuse = true;
    const poster: TailPoster = (events) => {
      if (refuse) {
        return Promise.reject(new Error("ingest buffer full, retry later"));
      }
      delivered.push(...events.map((event) => event.path));
      return Promise.resolve();
    };

    const tail = tailLogFile({
      autoStart: false,
      batchSize: 1,
      file,
      format: "apache",
      flushIntervalMs: 0,
      key: "test-key",
      poster,
      url: "https://analytics.example.com"
    });

    await appendFile(file, `${FIRST_LINE}\n`);
    await tail.pump();
    expect(delivered).toEqual([]);

    refuse = false;
    await tail.flush();
    expect(delivered).toEqual(["/robots.txt"]);
  });

  it("stays alive instead of dying on the first refusal", async () => {
    const file = await createTempLog();
    const poster: TailPoster = () => Promise.reject(new Error("connection refused"));

    const tail = tailLogFile({
      autoStart: false,
      batchSize: 1,
      file,
      format: "apache",
      flushIntervalMs: 0,
      key: "test-key",
      poster,
      url: "https://analytics.example.com"
    });

    await appendFile(file, `${FIRST_LINE}\n`);
    // A throw out of pump() reaches the scheduler, which stops the tailer and
    // rejects `done` — so one blip of the server ends log collection until
    // somebody notices.
    await expect(tail.pump()).resolves.toBeDefined();
    const summary = await tail.stop();
    expect(summary.eventsSent).toBe(0);
    expect(summary.undelivered).toBe(1);
  });

  it("counts what it had to drop rather than dropping it quietly", async () => {
    const file = await createTempLog();
    const poster: TailPoster = () => Promise.reject(new Error("down"));

    const tail = tailLogFile({
      autoStart: false,
      batchSize: 1,
      file,
      format: "apache",
      flushIntervalMs: 0,
      key: "test-key",
      maxBuffer: 2,
      poster,
      url: "https://analytics.example.com"
    });

    for (let i = 0; i < 5; i += 1) {
      await appendFile(file, `${FIRST_LINE}\n`);
      await tail.pump();
    }
    const summary = await tail.stop();
    expect(summary.dropped).toBeGreaterThan(0);
    expect(summary.undelivered).toBe(2);
  });
});

async function createTempLog(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crawlytics-tail-"));
  tempDirs.push(directory);
  const file = join(directory, "access.log");
  await writeFile(file, "");
  return file;
}

describe("tailLogFile when the server will never take it", () => {
  it("drops a batch the server refused permanently instead of retrying it forever", async () => {
    // Keeping everything the server refuses is right for 429 and 5xx and wrong
    // for 400: the batch cannot become valid by waiting, so holding it would
    // block every line behind it until the buffer filled and the whole tail
    // stopped. The node sensor already draws this line (serverWantsItBack);
    // this is the same line, drawn here.
    const file = await createTempLog();
    const poster: TailPoster = () =>
      Promise.reject(Object.assign(new Error("Ingest POST failed with HTTP 400"), { status: 400 }));

    const tail = tailLogFile({
      autoStart: false,
      batchSize: 1,
      file,
      format: "apache",
      flushIntervalMs: 0,
      key: "test-key",
      poster,
      url: "https://analytics.example.com"
    });

    await appendFile(file, `${FIRST_LINE}\n`);
    await tail.pump();
    const summary = await tail.stop();
    expect(summary.undelivered).toBe(0);
    expect(summary.dropped).toBe(1);
  });

  it("but still keeps one the server asked it to send again", async () => {
    const file = await createTempLog();
    const poster: TailPoster = () =>
      Promise.reject(Object.assign(new Error("Ingest POST failed with HTTP 429"), { status: 429 }));

    const tail = tailLogFile({
      autoStart: false,
      batchSize: 1,
      file,
      format: "apache",
      flushIntervalMs: 0,
      key: "test-key",
      poster,
      url: "https://analytics.example.com"
    });

    await appendFile(file, `${FIRST_LINE}\n`);
    await tail.pump();
    const summary = await tail.stop();
    expect(summary.undelivered).toBe(1);
    expect(summary.dropped).toBe(0);
  });
});

describe("tailLogFile when only part of the post landed", () => {
  // The poster splits anything over 5000 into several requests and stops at the
  // first failure. Restoring the whole buffer re-sends the chunks the server
  // already committed — and the events table has no unique key, so those rows
  // double and every count for that window is inflated. Trading loss for
  // duplication is not a fix; the node sensor restores from the failing chunk
  // onward (giveBack) and this is the same rule.
  function eventsOf(count: number, prefix: string) {
    return Array.from({ length: count }, (_, i) => `${prefix}${String(i)}`);
  }

  it("keeps only what the server did not take", async () => {
    const file = await createTempLog();
    const seen: string[] = [];
    let failFrom: number | null = 2;
    const poster: TailPoster = (events) => {
      if (failFrom === null) {
        seen.push(...events.map((event) => event.path));
        return Promise.resolve();
      }
      seen.push(...events.slice(0, failFrom).map((event) => event.path));
      const delivered = failFrom;
      failFrom = null;
      return Promise.reject(
        Object.assign(new Error("Ingest POST failed with HTTP 503"), { status: 503, delivered })
      );
    };

    const tail = tailLogFile({
      autoStart: false,
      batchSize: 5,
      file,
      format: "apache",
      flushIntervalMs: 0,
      key: "test-key",
      poster,
      url: "https://analytics.example.com"
    });

    for (let i = 0; i < 5; i += 1) {
      await appendFile(file, `${FIRST_LINE}\n`);
    }
    await tail.pump();
    // Two of the five reached the server; three are still ours.
    expect(tail.getSummary().undelivered).toBe(3);
    await tail.flush();
    expect(seen).toHaveLength(5);
    expect(eventsOf(0, "")).toEqual([]);
  });

  it("drops only the chunk the server refused for good", async () => {
    const file = await createTempLog();
    const poster: TailPoster = () =>
      Promise.reject(
        Object.assign(new Error("Ingest POST failed with HTTP 400"), { status: 400, delivered: 2 })
      );

    const tail = tailLogFile({
      autoStart: false,
      batchSize: 5,
      chunkSize: 1,
      file,
      format: "apache",
      // High on purpose: the batchSize flush is the one under test, and a
      // due-by-time flush at the end of the same pump would post the restored
      // remainder again and muddle the numbers.
      flushIntervalMs: 60_000,
      key: "test-key",
      poster,
      url: "https://analytics.example.com"
    });

    for (let i = 0; i < 5; i += 1) {
      await appendFile(file, `${FIRST_LINE}\n`);
    }
    await tail.pump();
    const summary = tail.getSummary();
    // Two delivered, one chunk (one event here) refused for good, two still held.
    expect(summary.eventsSent).toBe(2);
    expect(summary.dropped).toBe(1);
    expect(summary.undelivered).toBe(2);
  });
});

describe("what the operator can see", () => {
  it("an import that recognised nothing does not read as success", () => {
    // "Imported 0 events from 400 lines (400 skipped)." was printed with exit
    // code 0 — the same shape as a good run, from a wrong --format. A log
    // sensor that silently recognises nothing is the failure mode this product
    // exists to prevent in other people's sites.
    const summary = { batchesPosted: 0, bytesRead: 12, rejected: 0, eventsSent: 0, linesRead: 400, skipped: 400 };
    expect(formatImportSummary(summary)).toMatch(/не|not|no events|check|формат|--format/i);
    expect(importExitCode(summary)).toBe(1);
  });

  it("an import that recognised something is still a success", () => {
    const summary = { batchesPosted: 1, bytesRead: 12, rejected: 0, eventsSent: 399, linesRead: 400, skipped: 1 };
    expect(importExitCode(summary)).toBe(0);
  });

  it("an empty file is not a parsing failure", () => {
    const summary = { batchesPosted: 0, bytesRead: 0, rejected: 0, eventsSent: 0, linesRead: 0, skipped: 0 };
    expect(importExitCode(summary)).toBe(0);
  });

  it("the tailer says out loud what it is doing, including nothing", () => {
    // `crawlytics tail` printed no line, ever: under systemd it showed
    // "active (running)" whether it was delivering everything or skipping
    // every line of a log it could not parse.
    const line = formatTailHeartbeat({
      batchesPosted: 0,
      bytesRead: 900,
      dropped: 0,
      eventsSent: 0,
      linesRead: 300,
      rejected: 0,
      skipped: 300,
      undelivered: 0
    });
    expect(line).toMatch(/300/);
    expect(line).toMatch(/skip|пропущ/i);
  });
});
