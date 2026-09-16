import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/index.js";
import type { RawLogEvent } from "../src/types.js";

// The jsonl format is listed in --help and accepted by flag validation, but it
// needs a fieldMap the CLI had no way to supply — so parseLine returned null
// for every line, import exited 0, and "Imported 0 events from N lines" was the
// whole story. Advertised and unusable.

function capture() {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => lines.push(chunk) };
}

const FIXTURE = fileURLToPath(new URL("./fixtures/jsonl.log", import.meta.url));

const MAP =
  "ts=when,ip=client.ip,method=http.method,path=http.target," +
  "status=response.status,bytes=response.bytes,ua=headers.ua,referer=headers.referer";

describe("crawlytics import --format jsonl", () => {
  it("imports when told which field is which", async () => {
    const posted: RawLogEvent[] = [];
    const stdout = capture();
    const code = await runCli(
      ["import", "--key", "k", "--url", "https://a.example", "--format", "jsonl",
        "--file", FIXTURE, "--field-map", MAP],
      {
        stdout,
        poster: (events) => {
          posted.push(...events);
          return Promise.resolve();
        }
      }
    );

    expect(code).toBe(0);
    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0]?.path).toBe("/robots.txt");
  });

  it("refuses jsonl with no map instead of skipping every line", async () => {
    const stderr = capture();
    const code = await runCli(
      ["import", "--key", "k", "--url", "https://a.example", "--format", "jsonl", "--file", FIXTURE],
      { stderr, poster: () => Promise.resolve() }
    );

    expect(code).toBe(1);
    expect(stderr.lines.join("\n")).toMatch(/field-map/);
  });

  it("refuses a map it cannot use rather than silently ignoring it", async () => {
    const stderr = capture();
    const code = await runCli(
      ["import", "--key", "k", "--url", "https://a.example", "--format", "jsonl",
        "--file", FIXTURE, "--field-map", "nonsense"],
      { stderr, poster: () => Promise.resolve() }
    );

    expect(code).toBe(1);
  });

  it("carries the map into the systemd unit it writes", async () => {
    // A unit generated without it would start a tailer that skips every line —
    // and that tailer prints nothing, so the operator sees "active (running)".
    const stdout = capture();
    const code = await runCli(
      ["systemd", "--key", "k", "--url", "https://a.example", "--format", "jsonl",
        "--file", "/var/log/app.jsonl", "--field-map", MAP],
      { stdout }
    );
    expect(code).toBe(0);
    expect(stdout.lines.join("")).toContain("--field-map");
  });

  it("imports when the log has no size field, as --help's own example allows", async () => {
    // bytes is optional in the map and in the ingest schema (it defaults to 0),
    // but buildRawLogEvent refused any event without it — so a map written
    // exactly like the example in --help skipped every line and exited 0. The
    // silent no-op this flag was added to remove, re-created by the flag.
    const posted: RawLogEvent[] = [];
    const stdout = capture();
    const code = await runCli(
      ["import", "--key", "k", "--url", "https://a.example", "--format", "jsonl",
        "--file", FIXTURE, "--field-map",
        "ts=when,ip=client.ip,method=http.method,path=http.target,status=response.status"],
      {
        stdout,
        poster: (events) => {
          posted.push(...events);
          return Promise.resolve();
        }
      }
    );

    expect(code).toBe(0);
    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0]?.bytes).toBe(0);
  });
});
