import { describe, expect, it } from "vitest";

import { loadCompiledBots } from "@crawlytics/registry";

import { createDetector } from "../src/index.js";

const HUMAN_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36"
];

const BOT_UAS = [
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  "python-requests/2.31.0"
];

// 70% human / 30% bot mix, every UA unique so the LRU cache cannot help.
function buildCorpus(size: number): string[] {
  const corpus: string[] = [];
  for (let i = 0; i < size; i += 1) {
    const base = i % 10 < 7 ? HUMAN_UAS[i % HUMAN_UAS.length] : BOT_UAS[i % BOT_UAS.length];
    corpus.push(`${base ?? ""} uniq/${String(i)}`);
  }
  return corpus;
}

describe.skipIf(process.env["SKIP_BENCH"] === "1")("classification throughput", () => {
  it("sustains >= 50K cold classifications/sec on one core", () => {
    const detector = createDetector(loadCompiledBots(), { cacheSize: 0 });
    const corpus = buildCorpus(30_000);

    for (let i = 0; i < 3_000; i += 1) {
      detector.classify(corpus[i]);
    }

    const start = performance.now();
    for (const ua of corpus) {
      detector.classify(ua);
    }
    const elapsedMs = performance.now() - start;
    const opsPerSec = (corpus.length / elapsedMs) * 1000;

    console.info(`detector throughput: ${Math.round(opsPerSec).toLocaleString()} ops/sec`);
    expect(opsPerSec).toBeGreaterThan(50_000);
  }, 60_000);
});
