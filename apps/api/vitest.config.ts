import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The migration tests drop and recreate the app tables, so DB test files must not overlap.
    fileParallelism: false,
  },
});
