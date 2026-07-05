import { describe, expect, it } from "vitest";

import { refererOrigin } from "../src/pipeline/redact.js";

describe("refererOrigin", () => {
  it("keeps only the origin and drops path, query, and fragment", () => {
    expect(refererOrigin("https://chatgpt.com/c/abc?token=secret#frag")).toBe("https://chatgpt.com");
    expect(refererOrigin("https://chatgpt.com/")).toBe("https://chatgpt.com");
  });

  it("strips credentials and lowercases the host", () => {
    expect(refererOrigin("https://user:pass@ChatGPT.COM/x")).toBe("https://chatgpt.com");
  });

  it("preserves a non-default port", () => {
    expect(refererOrigin("http://example.com:8080/path?q=1")).toBe("http://example.com:8080");
  });

  it("returns empty for empty, non-http, malformed, or bare-host input", () => {
    expect(refererOrigin("")).toBe("");
    expect(refererOrigin("ftp://example.com/")).toBe("");
    expect(refererOrigin("javascript:alert(1)")).toBe("");
    expect(refererOrigin("not a url")).toBe("");
    expect(refererOrigin("chatgpt.com")).toBe(""); // no scheme -> unparseable
  });

  it("rejects an absurdly long origin (length cap)", () => {
    const huge = `https://${"a".repeat(300)}.com/`;
    expect(refererOrigin(huge)).toBe("");
  });

  it("normalizes IDN to punycode and keeps IPv6 brackets + non-default ports", () => {
    expect(refererOrigin("https://bücher.example/x?q=1")).toBe("https://xn--bcher-kva.example");
    expect(refererOrigin("http://[2001:db8::1]:8080/x?q=1")).toBe("http://[2001:db8::1]:8080");
  });

  it("omits the default port", () => {
    expect(refererOrigin("https://example.com:443/x")).toBe("https://example.com");
    expect(refererOrigin("http://example.com:80/x")).toBe("http://example.com");
  });

  it("neutralizes a header-injection attempt in the referer (origin only)", () => {
    expect(refererOrigin("https://chatgpt.com/\nSet-Cookie: a=b")).toBe("https://chatgpt.com");
    expect(refererOrigin("https://exa mple.com")).toBe(""); // malformed host -> empty
  });
});
