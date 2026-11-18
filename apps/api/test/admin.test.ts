import express from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { requireAiEnabled, requireAuth } from "../src/auth/middleware.js";
import { createDb, type Db } from "../src/db/client.js";
import { createOrPromoteAdmin } from "../src/db/create-admin.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { errorHandler } from "../src/middleware/errors.js";
import { expectContract } from "./contract.js";
import { documentDeps } from "./stubs.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

const SECRET = "j".repeat(32);
const PASSWORD = "correct horse battery";

describe.skipIf(!url)("admin (api.v1 /admin/*)", () => {
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;
  let userToken: string;
  let researcherToken: string;
  let userId: string;

  async function register(email: string, role: "lawyer" | "researcher" = "lawyer") {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: PASSWORD, name: email.split("@")[0], role });
    return res.body as { accessToken: string; user: { id: string } };
  }

  const asAdmin = (req: request.Test) => req.set("Authorization", `Bearer ${adminToken}`);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
    db = createDb(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.query("UPDATE app.providers SET enabled = (kind = 'local')");
    app = createApp({
      env: {
        CORS_ORIGIN: "http://localhost:3000",
        JWT_SECRET: SECRET,
        RESET_URL_BASE: "http://localhost:3000/reset-password",
      },
      logger: createLogger("silent", false),
      db: pool,
      orm: db,
      ai: { info: async () => ({ service: "caseguard-ai", version: "test" }) } as AppDeps["ai"],
      mailer: { send: async () => {} },
      ...documentDeps(),
    });
    await createOrPromoteAdmin(
      db,
      { email: "root@example.com", name: "Root" },
      async () => PASSWORD,
    );
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "root@example.com", password: PASSWORD });
    adminToken = login.body.accessToken;
    const user = await register("user@example.com");
    userToken = user.accessToken;
    userId = user.user.id;
    researcherToken = (await register("researcher@example.com", "researcher")).accessToken;
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.query("UPDATE app.providers SET enabled = (kind = 'local')");
    await pool.end();
  });

  describe("access", () => {
    const operations = [
      { method: "get", path: "/admin/users", url: () => "/api/v1/admin/users" },
      {
        method: "patch",
        path: "/admin/users/{userId}",
        url: () => `/api/v1/admin/users/${userId}`,
        body: { aiEnabled: false },
      },
      { method: "get", path: "/admin/providers", url: () => "/api/v1/admin/providers" },
      {
        method: "patch",
        path: "/admin/providers/{providerId}",
        url: () => "/api/v1/admin/providers/gemini",
        body: { enabled: true },
      },
    ] as const;

    for (const op of operations) {
      it(`${op.method.toUpperCase()} ${op.path}: 403 for a Lawyer or Researcher, 401 without a token (FR-AUTH-2)`, async () => {
        const send = (r: request.Test) => ("body" in op ? r.send(op.body) : r);
        for (const token of [userToken, researcherToken]) {
          const forbidden = await send(
            request(app)[op.method](op.url()).set("Authorization", `Bearer ${token}`),
          );
          expect(forbidden.status).toBe(403);
          expectContract(forbidden, op.method, op.path);
        }
        const anonymous = await send(request(app)[op.method](op.url()));
        expect(anonymous.status).toBe(401);
        expectContract(anonymous, op.method, op.path);
      });
    }

    it("a Lawyer's 403 changes nothing", async () => {
      await request(app)
        .patch("/api/v1/admin/providers/gemini")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ enabled: true });
      const { rows } = await pool.query("SELECT enabled FROM app.providers WHERE id = 'gemini'");
      expect(rows[0].enabled).toBe(false);
    });
  });

  describe("users", () => {
    it("lists users oldest first, page by page", async () => {
      await register("c@example.com");
      await register("d@example.com");
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await asAdmin(
          request(app)
            .get("/api/v1/admin/users")
            .query({ limit: 2, ...(cursor ? { cursor } : {}) }),
        );
        expect(res.status).toBe(200);
        expectContract(res, "get", "/admin/users");
        seen.push(...res.body.items.map((u: { email: string }) => u.email));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual([
        "root@example.com",
        "user@example.com",
        "researcher@example.com",
        "c@example.com",
        "d@example.com",
      ]);
    });

    it("400 for a bad cursor or limit", async () => {
      const badCursor = await asAdmin(request(app).get("/api/v1/admin/users?cursor=nope"));
      expect(badCursor.status).toBe(400);
      const badLimit = await asAdmin(request(app).get("/api/v1/admin/users?limit=500"));
      expect(badLimit.status).toBe(400);
    });

    it("turning AI off blocks the user's AI routes on their next request (FR-AUTH-3)", async () => {
      const aiRoute = express();
      aiRoute.get("/ai", requireAuth(SECRET), requireAiEnabled(db), (_req, res) => {
        res.json({ ok: true });
      });
      aiRoute.use(errorHandler);
      const callAi = () => request(aiRoute).get("/ai").set("Authorization", `Bearer ${userToken}`);
      expect((await callAi()).status).toBe(200);

      const off = await asAdmin(
        request(app).patch(`/api/v1/admin/users/${userId}`).send({ aiEnabled: false }),
      );
      expect(off.status).toBe(200);
      expectContract(off, "patch", "/admin/users/{userId}");
      expect(off.body).toMatchObject({ id: userId, aiEnabled: false });
      const blocked = await callAi();
      expect(blocked.status).toBe(403);
      expect(blocked.body.detail).toMatch(/AI features are disabled/);

      await asAdmin(request(app).patch(`/api/v1/admin/users/${userId}`).send({ aiEnabled: true }));
      expect((await callAi()).status).toBe(200);
    });

    it("404 for an unknown or malformed id; 400 for an extra field", async () => {
      const unknown = await asAdmin(
        request(app)
          .patch("/api/v1/admin/users/00000000-0000-4000-8000-000000000000")
          .send({ aiEnabled: false }),
      );
      expect(unknown.status).toBe(404);
      expectContract(unknown, "patch", "/admin/users/{userId}");
      const malformed = await asAdmin(
        request(app).patch("/api/v1/admin/users/not-a-uuid").send({ aiEnabled: false }),
      );
      expect(malformed.status).toBe(404);
      const extra = await asAdmin(
        request(app)
          .patch(`/api/v1/admin/users/${userId}`)
          .send({ aiEnabled: false, role: "admin" }),
      );
      expect(extra.status).toBe(400);
      expectContract(extra, "patch", "/admin/users/{userId}");
      const { rows } = await pool.query("SELECT role FROM app.users WHERE id = $1", [userId]);
      expect(rows[0].role).toBe("lawyer");
    });
  });

  describe("providers", () => {
    it("lists the seeded presets; only the local provider starts enabled (SEC-11)", async () => {
      const res = await asAdmin(request(app).get("/api/v1/admin/providers"));
      expect(res.status).toBe(200);
      expectContract(res, "get", "/admin/providers");
      const byId = Object.fromEntries(
        res.body.items.map((p: { id: string }) => [p.id, p] as const),
      );
      expect(Object.keys(byId).sort()).toEqual([
        "anthropic",
        "gemini",
        "groq",
        "nvidia-nim",
        "ollama",
        "openai",
        "openrouter",
      ]);
      expect(byId.ollama).toMatchObject({ kind: "local", enabled: true });
      expect(
        res.body.items
          .filter((p: { enabled: boolean }) => p.enabled)
          .map((p: { id: string }) => p.id),
      ).toEqual(["ollama"]);
    });

    it("switches a provider on and off", async () => {
      const on = await asAdmin(
        request(app).patch("/api/v1/admin/providers/gemini").send({ enabled: true }),
      );
      expect(on.status).toBe(200);
      expectContract(on, "patch", "/admin/providers/{providerId}");
      expect(on.body).toEqual({
        id: "gemini",
        name: "Google Gemini",
        kind: "cloud",
        enabled: true,
      });
      const off = await asAdmin(
        request(app).patch("/api/v1/admin/providers/gemini").send({ enabled: false }),
      );
      expect(off.body.enabled).toBe(false);
    });

    it("404 for an unknown provider; 400 for a bad body", async () => {
      const unknown = await asAdmin(
        request(app).patch("/api/v1/admin/providers/nope").send({ enabled: true }),
      );
      expect(unknown.status).toBe(404);
      expectContract(unknown, "patch", "/admin/providers/{providerId}");
      const bad = await asAdmin(
        request(app).patch("/api/v1/admin/providers/gemini").send({ enabled: "yes" }),
      );
      expect(bad.status).toBe(400);
      expectContract(bad, "patch", "/admin/providers/{providerId}");
    });
  });
});
