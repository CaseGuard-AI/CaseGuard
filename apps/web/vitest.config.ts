import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    // The first test in a file pays for a cold `await import(...)` of the forms; on a loaded
    // machine that alone can pass the 5 s default. With every file importing in parallel workers
    // it reached 15-17 s locally (#86), so allow 30 s.
    testTimeout: 30_000,
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
