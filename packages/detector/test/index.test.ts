import { describe, expect, it } from "vitest";

import { classifyReferral, createDetector } from "../src/index.js";

describe("@crawlytics/detector public API", () => {
  it("exposes createDetector and classifyReferral", () => {
    expect(typeof createDetector).toBe("function");
    expect(typeof classifyReferral).toBe("function");
  });
});
