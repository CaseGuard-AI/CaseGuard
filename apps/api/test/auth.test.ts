import pg from "pg";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { expectContract } from "./contract.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

const alice = { email: "Alice@Example.com", password: "correct horse battery", name: "Alice" };

function refreshCookie(res: Response): string {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const cookie = cookies.find((c) => c.startsWith("cg_refresh="));
  expect(cookie, "no cg_refresh cookie").toBeDefined();
  return cookie!;
}

const cookieValue = (setCookie: string) => setCookie.split(";")[0]!;

describe.skipIf(!url)("auth (api.v1 /auth/*)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  const refreshRows = async () =>
    Number((await pool.query("SELECT count(*) FROM app.refresh_tokens")).rows[0].count);

  const register = (body: object = alice) => request(app).post("/api/v1/auth/register").send(body);
  const login = (body: object = alice) => request(app).post("/api/v1/auth/login").send(body);
  const refresh = (cookie?: string) => {
    const req = request(app).post("/api/v1/auth/refresh");
    return cookie ? req.set("Cookie", cookieValue(cookie)) : req;
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    app = createApp({
      env: {
        CORS_ORIGIN: "http://localhost:3000",
        JWT_SECRET: "j".repeat(32),
        RESET_URL_BASE: "http://localhost:3000/reset-password",
      },
      logger: createLogger("silent", false),
      db: pool,
      orm: createDb(pool),
      ai: { info: async () => ({ service: "caseguard-ai", version: "test" }) } as AppDeps["ai"],
      mailer: { send: async () => {} },
    });
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  describe("register", () => {
    it("201 with a Session and the refresh cookie", async () => {
      const res = await register();
      expect(res.status).toBe(201);
      expectContract(res, "post", "/auth/register");
      expect(res.body.user).toMatchObject({ name: "Alice", role: "lawyer", locale: "en" });
      expect(res.body.user).not.toHaveProperty("passwordHash");
      expect(res.body.expiresIn).toBe(900);
      const cookie = refreshCookie(res);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    });

    it("registers a Researcher, and the token carries the role (FR-AUTH-2)", async () => {
      const res = await register({ ...alice, role: "researcher" });
      expect(res.status).toBe(201);
      expectContract(res, "post", "/auth/register");
      expect(res.body.user.role).toBe("researcher");
      const me = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${res.body.accessToken}`);
      expect(me.body.role).toBe("researcher");
      const { rows } = await pool.query("SELECT role FROM app.users");
      expect(rows).toEqual([{ role: "researcher" }]);
    });

    it("registers a Lawyer when asked explicitly", async () => {
      const res = await register({ ...alice, role: "lawyer" });
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe("lawyer");
    });

    // Nobody self-registers as admin: the body is rejected and no account is created.
    it.each(["admin", "user", "superuser", ""])("400 for role %j", async (role) => {
      const res = await register({ ...alice, role });
      expect(res.status).toBe(400);
      expectContract(res, "post", "/auth/register");
      expect(res.body.errors).toContainEqual(expect.objectContaining({ path: "role" }));
      expect(Number((await pool.query("SELECT count(*) FROM app.users")).rows[0].count)).toBe(0);
    });

    it("409 for an email that exists in another case", async () => {
      await register();
      const res = await register({ ...alice, email: "alice@EXAMPLE.com" });
      expect(res.status).toBe(409);
      expectContract(res, "post", "/auth/register");
    });

    it("400 with field errors for a short password", async () => {
      const res = await register({ ...alice, password: "short" });
      expect(res.status).toBe(400);
      expectContract(res, "post", "/auth/register");
      expect(res.body.errors).toContainEqual(expect.objectContaining({ path: "password" }));
    });
  });

  describe("login", () => {
    beforeEach(async () => {
      await register();
    });

    it("200 with a Session, case-insensitive email", async () => {
      const res = await login({ ...alice, email: "alice@example.com" });
      expect(res.status).toBe(200);
      expectContract(res, "post", "/auth/login");
      refreshCookie(res);
    });

    it("invalid credentials get 401 and create no session (FR-AUTH-1)", async () => {
      const before = await refreshRows();
      const wrongPassword = await login({ ...alice, password: "wrong password!" });
      const unknownEmail = await login({ ...alice, email: "nobody@example.com" });
      for (const res of [wrongPassword, unknownEmail]) {
        expect(res.status).toBe(401);
        expectContract(res, "post", "/auth/login");
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
      expect(wrongPassword.body.detail).toBe(unknownEmail.body.detail);
      expect(await refreshRows()).toBe(before);
    });

    it("429 with Retry-After after 10 failed attempts (SEC-15)", async () => {
      for (let i = 0; i < 10; i++) {
        expect((await login({ ...alice, password: "wrong password!" })).status).toBe(401);
      }
      const res = await login();
      expect(res.status).toBe(429);
      expectContract(res, "post", "/auth/login");
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("refresh", () => {
    it("rotates: the new cookie works, the old one no longer does", async () => {
      const first = refreshCookie(await register());
      const res = await refresh(first);
      expect(res.status).toBe(200);
      expectContract(res, "post", "/auth/refresh");
      const second = refreshCookie(res);
      expect(cookieValue(second)).not.toBe(cookieValue(first));
      expect((await refresh(second)).status).toBe(200);
    });

    it("reusing a rotated token revokes the whole family", async () => {
      const first = refreshCookie(await register());
      const second = refreshCookie(await refresh(first));
      const reuse = await refresh(first);
      expect(reuse.status).toBe(401);
      expectContract(reuse, "post", "/auth/refresh");
      expect((await refresh(second)).status).toBe(401);
    });

    it("401 without a cookie", async () => {
      const res = await refresh();
      expect(res.status).toBe(401);
      expectContract(res, "post", "/auth/refresh");
    });

    // #83: refresh used to share register's 20 per IP, so page reloads could lock out a sign-up.
    it("has its own budget: 25 refreshes from one IP succeed, and register still works", async () => {
      let cookie = refreshCookie(await register());
      for (let i = 0; i < 25; i++) {
        const res = await refresh(cookie);
        expect(res.status, `refresh ${i + 1}`).toBe(200);
        cookie = refreshCookie(res);
      }
      const bob = { email: "bob@example.com", password: "another long password", name: "Bob" };
      expect((await register(bob)).status).toBe(201);
    });

    it("429 with Retry-After after 120 refreshes from one IP (SEC-15)", async () => {
      for (let i = 0; i < 120; i++) {
        expect((await refresh()).status).toBe(401);
      }
      const res = await refresh();
      expect(res.status).toBe(429);
      expectContract(res, "post", "/auth/refresh");
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("logout", () => {
    it("204, clears the cookie, and the refresh token stops working", async () => {
      const cookie = refreshCookie(await register());
      const res = await request(app).post("/api/v1/auth/logout").set("Cookie", cookieValue(cookie));
      expect(res.status).toBe(204);
      expectContract(res, "post", "/auth/logout");
      expect(refreshCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect((await refresh(cookie)).status).toBe(401);
    });

    it("401 without a cookie", async () => {
      const res = await request(app).post("/api/v1/auth/logout");
      expect(res.status).toBe(401);
      expectContract(res, "post", "/auth/logout");
    });
  });

  describe("me", () => {
    it("200 with the signed-in User", async () => {
      const { body } = await register();
      const res = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${body.accessToken}`);
      expect(res.status).toBe(200);
      expectContract(res, "get", "/auth/me");
      expect(res.body).toEqual(body.user);
    });

    it("401 without a token", async () => {
      const res = await request(app).get("/api/v1/auth/me");
      expect(res.status).toBe(401);
      expectContract(res, "get", "/auth/me");
    });
  });
});
