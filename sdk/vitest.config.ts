import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    // LM-OTS key generation hashes ~1,000 times per key; keep slow CI machines green.
    testTimeout: 60_000,
  },
});
