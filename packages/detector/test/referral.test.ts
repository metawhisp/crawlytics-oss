import { describe, expect, it } from "vitest";

import { classifyReferral } from "../src/index.js";

describe("classifyReferral: referer header", () => {
  const cases: Array<[string, string | null]> = [
    ["https://chatgpt.com/", "chatgpt"],
    ["https://chatgpt.com/c/abc-123", "chatgpt"],
    ["https://chat.openai.com/c/abc", "chatgpt"],
    ["https://www.perplexity.ai/search?q=best+crm", "perplexity"],
    ["https://perplexity.ai/", "perplexity"],
    ["https://gemini.google.com/app", "gemini"],
    ["https://bard.google.com/", "gemini"],
    ["https://claude.ai/chat/123", "claude"],
    ["https://copilot.microsoft.com/", "copilot"],
    ["https://www.bing.com/chat?q=x", "copilot"],
    ["https://www.bing.com/search?q=x", null],
    ["https://chat.deepseek.com/", "deepseek"],
    ["https://grok.com/share/abc", "grok"],
    ["https://meta.ai/", "meta"],
    ["https://www.meta.ai/", "meta"],
    ["https://you.com/search?q=x", "you"],
    ["https://chat.mistral.ai/chat", "mistral"],
    ["https://www.google.com/search?q=x", null],
    ["https://example.com/page", null],
    ["chatgpt.com", "chatgpt"],
    ["not a url at all", null],
    ["android-app://com.google.android.gm", null]
  ];

  it.each(cases)("%s -> %s", (referer, expected) => {
    expect(classifyReferral(referer)).toBe(expected);
  });

  it("returns null for empty input", () => {
    expect(classifyReferral(null)).toBeNull();
    expect(classifyReferral(undefined)).toBeNull();
    expect(classifyReferral("")).toBeNull();
  });
});

describe("classifyReferral: utm fallback (referrer stripped)", () => {
  it("detects ChatGPT's documented utm_source", () => {
    expect(classifyReferral(null, "utm_source=chatgpt.com")).toBe("chatgpt");
    expect(classifyReferral(null, "?utm_source=chatgpt.com&utm_medium=referral")).toBe("chatgpt");
  });

  it("detects other assistant utm_source values", () => {
    expect(classifyReferral(null, "utm_source=perplexity")).toBe("perplexity");
    expect(classifyReferral(null, "utm_source=deepseek")).toBe("deepseek");
  });

  it("prefers the referer when both are present", () => {
    expect(classifyReferral("https://claude.ai/chat/1", "utm_source=chatgpt.com")).toBe("claude");
  });

  it("ignores non-AI utm sources", () => {
    expect(classifyReferral(null, "utm_source=newsletter")).toBeNull();
    expect(classifyReferral(null, "utm_source=google")).toBeNull();
  });
});
