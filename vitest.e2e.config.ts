import { defineConfig } from "vitest/config";

// E2E tests require network access to testnet - skip in CI
const isCI = process.env.CI === "true" || process.env.CI === "1";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: isCI ? [] : ["test/e2e/**/*.test.ts"],
    testTimeout: 120000, // 2 minutes default timeout
    hookTimeout: 120000,
    // Run tests sequentially to avoid relay/nametag conflicts
    sequence: {
      concurrent: false,
    },
  },
});
