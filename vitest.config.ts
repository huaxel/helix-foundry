import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: "forks",
    fileParallelism: false,
  },
});
