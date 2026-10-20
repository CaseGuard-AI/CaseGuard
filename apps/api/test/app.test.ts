import pg from "pg";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { parseEnv } from "../src/config/env.js";
import { createLogger } from "../src/lib/logger.js";

const upAi: AppDeps["ai"] = { info: async () => ({ service: "caseguard-ai", version: "test" }) };
const downAi: AppDeps["ai"] = {
  info: async () => {
    throw new Error("down");
  },
};
const upDb: AppDeps["db"] = { query: (async () => ({ rows: [] })) as never };

function app(overrides: Partial<AppDeps> = {}) {
  return createApp({
    env: { CORS_ORIGIN: "http://localhost:3000", JWT_SECRET: "x".repeat(32) },
    logger: createLogger("silent", false),
    db: upDb,
    orm: {} as AppDeps["orm"],
    ai: upAi,
    ...overrides,
  });
}

describe("health", () => {
  it("GET /api/v1/health is ok", async () => {
    const res = await request(app()).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /api/v1/ready is 200 when DB and AI are up", async () => {
    const res = await request(app()).get("/api/v1/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: "up", ai: "up" });
  });

  it("GET /api/v1/ready is 503 when the AI service is down", async () => {
    const res = await request(app({ ai: downAi })).get("/api/v1/ready");
    expect(res.status).toBe(503);
    expect(res.body.ai).toBe("down");
  });
});

describe("errors", () => {
  it("unknown routes return RFC 9457 problem+json", async () => {
    const res = await request(app()).get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ title: "Not Found", status: 404 });
  });

  it("sets security headers and hides x-powered-by", async () => {
    const res = await request(app()).get("/api/v1/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("env", () => {
  it("rejects a short AI_SERVICE_TOKEN with a readable message", () => {
    expect(() =>
      parseEnv({
        API_DATABASE_URL: "postgresql://x@localhost/db",
        AI_SERVICE_TOKEN: "short",
        JWT_SECRET: "x".repeat(32),
      }),
    ).toThrow(/AI_SERVICE_TOKEN/);
  });
});

// Runs where a Postgres is available (CI sets DATABASE_URL).
describe.skipIf(!process.env.DATABASE_URL)("database", () => {
  it("ready reports database up against a real Postgres", async () => {
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const res = await request(app({ db })).get("/api/v1/ready");
      expect(res.body.database).toBe("up");
    } finally {
      await db.end();
    }
  });
});
