import express from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { requireAuth, requireRole } from "../src/auth/middleware.js";
import { createDb, type Db } from "../src/db/client.js";
import { createOrPromoteAdmin, parseCliArgs } from "../src/db/create-admin.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { errorHandler } from "../src/middleware/errors.js";
import { documentDeps } from "./stubs.js";

describe("create-admin arguments", () => {
  it("parses --email and --name", () => {
    expect(parseCliArgs(["--email", " Root@Example.com ", "--name", "Root"])).toEqual({
      email: "Root@Example.com",
      name: "Root",
    });
  });

  it("refuses a password passed as an argument", () => {
    expect(() => parseCliArgs(["--email", "a@example.com", "--password", "x"])).toThrow(
      /Never pass a password/,
    );
    expect(() => parseCliArgs(["--email", "a@example.com", "--password=x"])).toThrow(
      /Never pass a password/,
    );
  });

  it("requires a valid --email and rejects unknown options", () => {
    expect(() => parseCliArgs([])).toThrow(/--email is required/);
    expect(() => parseCliArgs(["--email", "nope"])).toThrow();
    expect(() => parseCliArgs(["--email", "a@example.com", "--role", "admin"])).toThrow();
  });
});

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

describe.skipIf(!url)("createOrPromoteAdmin", () => {
  const SECRET = "j".repeat(32);
  const PASSWORD = "correct horse battery";
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createApp>;

  // A stand-in admin-only endpoint: the contract's admin routes land with #55.
  const adminOnly = express();
  adminOnly.get("/admin-only", requireAuth(SECRET), requireRole("admin"), (_req, res) => {
    res.json({ ok: true });
  });
  adminOnly.use(errorHandler);

  const login = (email: string, password = PASSWORD) =>
    request(app).post("/api/v1/auth/login").send({ email, password });

  async function adminOnlyStatus(email: string) {
    const { body } = await login(email);
    const res = await request(adminOnly)
      .get("/admin-only")
      .set("Authorization", `Bearer ${body.accessToken}`);
    return res.status;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
    db = createDb(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
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
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  it("promotes an existing user, matching the email case-insensitively, without a password", async () => {
    await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "bob@example.com", password: PASSWORD, name: "Bob" });
    expect(await adminOnlyStatus("bob@example.com")).toBe(403);

    const getPassword = vi.fn(async () => "unused password");
    const result = await createOrPromoteAdmin(db, { email: "BOB@example.com" }, getPassword);
    expect(result.action).toBe("promoted");
    expect(result.user.role).toBe("admin");
    expect(getPassword).not.toHaveBeenCalled();

    // A fresh sign-in carries the admin role and passes requireRole("admin") (FR-AUTH-2).
    expect(await adminOnlyStatus("bob@example.com")).toBe(200);
  });

  it("creates a new admin who can sign in", async () => {
    const result = await createOrPromoteAdmin(
      db,
      { email: "root@example.com", name: "Root" },
      async () => PASSWORD,
    );
    expect(result.action).toBe("created");
    expect(result.user).toMatchObject({ role: "admin", name: "Root" });
    expect((await login("root@example.com")).body.user.role).toBe("admin");
    expect(await adminOnlyStatus("root@example.com")).toBe(200);
  });

  it("leaves an existing admin unchanged", async () => {
    const args = { email: "root@example.com", name: "Root" };
    await createOrPromoteAdmin(db, args, async () => PASSWORD);
    expect((await createOrPromoteAdmin(db, args, async () => PASSWORD)).action).toBe("unchanged");
  });

  it("needs --name and a valid password to create a user", async () => {
    await expect(
      createOrPromoteAdmin(db, { email: "new@example.com" }, async () => PASSWORD),
    ).rejects.toThrow(/pass --name/);
    await expect(
      createOrPromoteAdmin(db, { email: "new@example.com", name: "New" }, async () => "short"),
    ).rejects.toThrow();
    const { rowCount } = await pool.query("SELECT 1 FROM app.users");
    expect(rowCount).toBe(0);
  });
});
