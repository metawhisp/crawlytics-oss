import { describe, expect, it } from "vitest";

import { App } from "../src/index.js";

describe("@crawlytics/web", () => {
  it("exports the App component", () => {
    expect(typeof App).toBe("function");
  });
});
