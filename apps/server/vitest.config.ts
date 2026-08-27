import { defineConfig } from "vitest/config";

// Unit tests only. Integration tests live in test-integration/ and need docker;
// they run through vitest.integration.config.ts so `pnpm test` stays fast.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"]
  }
});
