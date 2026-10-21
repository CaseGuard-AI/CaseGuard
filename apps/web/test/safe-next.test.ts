import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/research")).toBe("/research");
    expect(safeNext("/cases/42?tab=documents")).toBe("/cases/42?tab=documents");
  });

  it("falls back to the dashboard for anything else", () => {
    for (const value of [
      null,
      undefined,
      "",
      "research",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\u0000",
      "/login",
      "/register?next=/x",
    ]) {
      expect(safeNext(value), String(value)).toBe("/");
    }
  });
});
