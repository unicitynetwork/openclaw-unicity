import { defineConfig } from "vitest/config";

// E2E tests hit the live Unicity testnet2 (and the Docker test drives a real OpenClaw gateway), so they
// only run when explicitly requested. Gated on UNICITY_E2E rather than CI: the dev sandbox sets CI=true.
const enabled = process.env.UNICITY_E2E === "1";
if (!enabled) console.warn("[e2e] UNICITY_E2E is not 1: no e2e tests selected");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: enabled ? ["test/e2e/**/*.test.ts"] : [],
    passWithNoTests: !enabled,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Sequential: the suites share the live relay and testnet2 gateway throttle.
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
