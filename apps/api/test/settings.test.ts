import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { expectContract } from "./contract.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

const SECRET = "j".repeat(32);
const PASSWORD = "correct horse battery";
const PATH = "/me/settings";

describe.skipIf(!url)("settings (api.v1 /me/settings)", () => {
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let userId: string;

  async function register(email: string, locale: "en" | "ur" = "ur") {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: PASSWORD, name: "Ayesha Khan", locale });
    return res.body as { accessToken: string; user: { id: string } };
  }

  const get = (as = token) =>
    request(app).get(`/api/v1${PATH}`).set("Authorization", `Bearer ${as}`);
  const patch = (body: unknown, as = token) =>
    request(app)
      .patch(`/api/v1${PATH}`)
      .set("Authorization", `Bearer ${as}`)
      .send(body as object);
  // The stored settings, shaped like the contract's UserSettings.
  const row = async (id = userId) =>
    (
      await pool.query(
        `SELECT name, locale, theme,
           CASE WHEN default_provider_id IS NULL THEN NULL
             ELSE json_build_object('providerId', default_provider_id, 'model', default_model)
           END AS "defaultModel"
         FROM app.users WHERE id = $1`,
        [id],
      )
    ).rows[0];

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
    });
    const user = await register("ayesha@example.com");
    token = user.accessToken;
    userId = user.user.id;
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  describe("GET", () => {
    it("returns the name and locale from registration, theme system and no model", async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expectContract(res, "get", PATH);
      expect(res.body).toEqual({
        name: "Ayesha Khan",
        locale: "ur",
        theme: "system",
        defaultModel: null,
      });
    });

    it("needs a token", async () => {
      const res = await request(app).get(`/api/v1${PATH}`);
      expect(res.status).toBe(401);
      expectContract(res, "get", PATH);
    });
  });

  describe("PATCH", () => {
    it.each(
      [
        [{ theme: "dark" }, { name: "Ayesha Khan", locale: "ur", theme: "dark" }],
        [{ locale: "en" }, { name: "Ayesha Khan", locale: "en", theme: "system" }],
        [{ name: "Ayesha K." }, { name: "Ayesha K.", locale: "ur", theme: "system" }],
        [
          { name: "A. Khan", locale: "en", theme: "light" },
          { name: "A. Khan", locale: "en", theme: "light" },
        ],
        [{ defaultModel: null }, { name: "Ayesha Khan", locale: "ur", theme: "system" }],
      ].map(([body, settings]) => [body, { ...settings, defaultModel: null }] as const),
    )("changes only what is sent: %j", async (body, expected) => {
      const res = await patch(body);
      expect(res.status).toBe(200);
      expectContract(res, "patch", PATH);
      expect(res.body).toEqual(expected);
      expect((await get()).body).toEqual(expected);
      expect(await row()).toEqual(expected);
    });

    it("trims the name, as at registration", async () => {
      const res = await patch({ name: "  Ayesha  " });
      expect(res.body.name).toBe("Ayesha");
    });

    it("shows the new name and locale in /auth/me", async () => {
      await patch({ name: "A. Khan", locale: "en" });
      const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
      expect(me.body).toMatchObject({ name: "A. Khan", locale: "en" });
    });

    it.each([
      ["an empty body", {}],
      ["role", { role: "admin" }],
      ["email", { email: "x@example.com" }],
      ["aiEnabled", { aiEnabled: false }],
      ["a known field next to an unknown one", { theme: "dark", role: "admin" }],
      ["an unknown theme", { theme: "blue" }],
      ["an unknown locale", { locale: "fr" }],
      ["an empty name", { name: "" }],
      ["a blank name", { name: "   " }],
      ["a 121-character name", { name: "a".repeat(121) }],
      ["a non-object body", ["theme", "dark"]],
      ["a defaultModel without a model", { defaultModel: { providerId: "gemini" } }],
      ["a defaultModel with an empty model", { defaultModel: { providerId: "gemini", model: "" } }],
      [
        "a defaultModel with an extra field",
        { defaultModel: { providerId: "gemini", model: "gemini-2.5-flash", apiKey: "x" } },
      ],
      ["a defaultModel that is a string", { defaultModel: "gemini-2.5-flash" }],
    ])("rejects %s with 400 and changes nothing", async (_, body) => {
      const before = await row();
      const res = await patch(body);
      expect(res.status).toBe(400);
      expectContract(res, "patch", PATH);
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(await row()).toEqual(before);
    });

    it("needs a token", async () => {
      const res = await request(app).patch(`/api/v1${PATH}`).send({ theme: "dark" });
      expect(res.status).toBe(401);
      expectContract(res, "patch", PATH);
      expect((await row()).theme).toBe("system");
    });
  });

  it("only ever changes the caller's own settings (FR-AUTH-4)", async () => {
    const other = await register("other@example.com", "en");
    await patch({ theme: "dark", name: "Changed" });
    const untouched = { name: "Ayesha Khan", locale: "en", theme: "system", defaultModel: null };
    expect(await row(other.user.id)).toEqual(untouched);
    const res = await get(other.accessToken);
    expect(res.body).toEqual(untouched);
  });

  it("gives 401 once the user no longer exists", async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    const res = await get();
    expect(res.status).toBe(401);
    expectContract(res, "get", PATH);
    const changed = await patch({ theme: "dark" });
    expect(changed.status).toBe(401);
    expectContract(changed, "patch", PATH);
  });
});
