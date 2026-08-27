import { defineConfig } from "vitest/config";

// Integration tests: one throwaway ClickHouse container, one shared fixture.
// Serial by design — every test reads the same seeded dataset.
export default defineConfig({
  test: {
    include: ["test-integration/**/*.test.ts"],
    globalSetup: ["test-integration/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false
  }
});
