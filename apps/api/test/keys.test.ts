import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AiClient, Answer, AnswerRequest } from "../src/clients/ai.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger, type Logger } from "../src/lib/logger.js";
import { expectContract } from "./contract.js";
import { documentDeps, noIngestion } from "./stubs.js";

// User API keys, the model list and the default model (FR-SET-2, SEC-4, SEC-11, ADR-0009).
// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

const PASSWORD = "correct horse battery";
// A fixed test encryption key (32 bytes, base64), as KEY_ENCRYPTION_KEY would hold.
const ENCRYPTION_KEY = Buffer.alloc(32, 0x5a).toString("base64");
// A recognisable provider key: it must never show up in a response, a row or a log line.
const TEST_KEY = "sk-test-NEVER-LOG-ME-7f3a9c1e5b2d";
const OTHER_KEY = "sk-test-replacement-key-9Qz4";

const KEY_PATH = "/me/keys/{providerId}";
const SETTINGS = "/me/settings";
const ASK = "/conversations/{conversationId}/messages";

const unanswerable = (req: AnswerRequest): Answer => ({
  requestId: req.requestId,
  answerable: false,
  language: "en",
  text: "The corpus has nothing on this.",
  citations: [],
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

describe.skipIf(!url)("user keys and models (api.v1 /me/keys, /models)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let calls: AnswerRequest[];
  let respond: (req: AnswerRequest) => Promise<unknown>;
  let alice: { token: string; userId: string };
  let bob: { token: string; userId: string };

  const ai: AiClient = {
    ...noIngestion,
    info: async () => ({ service: "caseguard-ai", version: "test" }),
    answer: async (req) => {
      calls.push(req);
      return (await respond(req)) as Answer;
    },
    getCitation: async () => {
      throw new Error("not used");
    },
    getSource: async () => {
      throw new Error("not used");
    },
  };

  function build(opts: { encryptionKey?: string | undefined; logger?: Logger } = {}) {
    const key = "encryptionKey" in opts ? opts.encryptionKey : ENCRYPTION_KEY;
    return createApp({
      env: {
        CORS_ORIGIN: "http://localhost:3000",
        JWT_SECRET: "j".repeat(32),
        RESET_URL_BASE: "http://localhost:3000/reset-password",
        ...(key ? { KEY_ENCRYPTION_KEY: key } : {}),
      },
      logger: opts.logger ?? createLogger("silent", false),
      db: pool,
      orm: createDb(pool),
      ai,
      mailer: { send: async () => {} },
      ...documentDeps(),
    });
  }

  async function register(email: string) {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: PASSWORD, name: email.split("@")[0] });
    return { token: res.body.accessToken as string, userId: res.body.user.id as string };
  }

  const as = (token = alice.token, on = app) => ({
    get: (path: string) =>
      request(on).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`),
    put: (path: string, body: unknown) =>
      request(on)
        .put(`/api/v1${path}`)
        .set("Authorization", `Bearer ${token}`)
        .send(body as object),
    patch: (path: string, body: unknown) =>
      request(on)
        .patch(`/api/v1${path}`)
        .set("Authorization", `Bearer ${token}`)
        .send(body as object),
    post: (path: string, body: object = {}) =>
      request(on).post(`/api/v1${path}`).set("Authorization", `Bearer ${token}`).send(body),
    del: (path: string) =>
      request(on).delete(`/api/v1${path}`).set("Authorization", `Bearer ${token}`),
  });

  const putKey = (providerId: string, apiKey: unknown = TEST_KEY, token = alice.token, on = app) =>
    as(token, on).put(`/me/keys/${providerId}`, { apiKey });

  const setProviders = (enabled: string[]) =>
    pool.query("UPDATE app.providers SET enabled = (id = ANY($1::text[]))", [enabled]);

  const keyRows = async () =>
    (await pool.query("SELECT * FROM app.user_api_keys ORDER BY provider_id")).rows;

  const audits = async () =>
    (await pool.query("SELECT * FROM app.ai_audit_records ORDER BY created_at")).rows;

  async function askOnce(token = alice.token, on = app) {
    const conv = await as(token, on).post("/conversations");
    return as(token, on).post(`/conversations/${conv.body.id}/messages`, {
      question: "What governs bail?",
    });
  }

  /** Every way a value could hide the key: text, and bytes read as text, hex or base64. */
  function expectNoSecret(value: unknown, secret = TEST_KEY) {
    const forms = [
      secret,
      Buffer.from(secret).toString("hex"),
      Buffer.from(secret).toString("base64"),
    ];
    const flat = JSON.stringify(value, (_k, v: unknown) => {
      if (v && typeof v === "object" && (v as { type?: string }).type === "Buffer") {
        const buf = Buffer.from((v as { data: number[] }).data);
        return [buf.toString("latin1"), buf.toString("utf8"), buf.toString("hex")].join("|");
      }
      return v;
    });
    for (const form of forms) expect(flat).not.toContain(form);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await setProviders(["ollama", "gemini"]);
    calls = [];
    respond = async (req) => unanswerable(req);
    app = build();
    alice = await register("alice@example.com");
    bob = await register("bob@example.com");
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await setProviders(["ollama"]); // the seeded default (#55)
    await pool.end();
  });

  describe("PUT and GET /me/keys", () => {
    it("saves a key and shows only its last four characters", async () => {
      const res = await putKey("gemini");
      expect(res.status).toBe(200);
      expectContract(res, "put", KEY_PATH);
      expect(res.body).toEqual({
        providerId: "gemini",
        last4: TEST_KEY.slice(-4),
        createdAt: expect.any(String),
        updatedAt: res.body.createdAt,
      });
      expectNoSecret(res.body);

      const list = await as().get("/me/keys");
      expect(list.status).toBe(200);
      expectContract(list, "get", "/me/keys");
      expect(list.body).toEqual([res.body]);
      expectNoSecret(list.body);
    });

    it("stores only ciphertext: the raw row never contains the key", async () => {
      await putKey("gemini");
      const rows = await keyRows();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.user_id).toBe(alice.userId);
      expect(row.last4).toBe(TEST_KEY.slice(-4));
      expect(row.iv).toHaveLength(12);
      expect(row.auth_tag).toHaveLength(16);
      expect(row.ciphertext).toHaveLength(Buffer.byteLength(TEST_KEY));
      expectNoSecret(row);
      // Also checked in SQL, in case the driver ever decoded bytea differently.
      const { rowCount } = await pool.query(
        `SELECT 1 FROM app.user_api_keys
         WHERE position(convert_to($1, 'UTF8') in ciphertext) > 0
            OR encode(ciphertext, 'escape') LIKE '%' || $1 || '%'`,
        [TEST_KEY],
      );
      expect(rowCount).toBe(0);
    });

    it("replacing a key keeps createdAt and moves updatedAt", async () => {
      const first = await putKey("gemini");
      const before = (await keyRows())[0];
      await tick();
      const second = await putKey("gemini", OTHER_KEY);
      expect(second.status).toBe(200);
      expectContract(second, "put", KEY_PATH);
      expect(second.body.createdAt).toBe(first.body.createdAt);
      expect(Date.parse(second.body.updatedAt)).toBeGreaterThan(Date.parse(first.body.updatedAt));
      expect(second.body.last4).toBe(OTHER_KEY.slice(-4));
      const rows = await keyRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].iv.equals(before.iv)).toBe(false);
      expectNoSecret(rows, OTHER_KEY);
    });

    it("lists keys ordered by provider, including a since-disabled provider's", async () => {
      await setProviders(["ollama", "gemini", "groq", "anthropic"]);
      await putKey("groq");
      await putKey("anthropic");
      await putKey("gemini");
      await setProviders(["ollama"]);
      const res = await as().get("/me/keys");
      expectContract(res, "get", "/me/keys");
      expect(res.body.map((k: { providerId: string }) => k.providerId)).toEqual([
        "anthropic",
        "gemini",
        "groq",
      ]);
    });

    it.each([
      ["a disabled provider", "groq"],
      ["an unknown provider", "nope"],
      ["a local provider", "ollama"],
      ["a malformed id", "Not_An_Id"],
    ])("403 for %s, and nothing is stored", async (_, providerId) => {
      const res = await putKey(providerId);
      expect(res.status).toBe(403);
      expectContract(res, "put", KEY_PATH);
      expect(await keyRows()).toEqual([]);
    });

    it.each([
      ["no apiKey", {}],
      ["a short key", { apiKey: "short" }],
      ["a 513-character key", { apiKey: "k".repeat(513) }],
      ["a non-string key", { apiKey: 12345678 }],
      ["an extra field", { apiKey: TEST_KEY, providerId: "groq" }],
    ])("400 for %s, and nothing is stored", async (_, body) => {
      const res = await as().put("/me/keys/gemini", body);
      expect(res.status).toBe(400);
      expectContract(res, "put", KEY_PATH);
      expect(await keyRows()).toEqual([]);
      expectNoSecret(res.body);
    });

    it("503 without KEY_ENCRYPTION_KEY; reads still work", async () => {
      const keyless = build({ encryptionKey: undefined });
      const res = await putKey("gemini", TEST_KEY, alice.token, keyless);
      expect(res.status).toBe(503);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.body).toMatchObject({ status: 503, title: "Service Unavailable" });
      expect(await keyRows()).toEqual([]);
      const list = await as(alice.token, keyless).get("/me/keys");
      expect(list.status).toBe(200);
      expect(list.body).toEqual([]);
    });

    it("keeps each user's keys their own (FR-AUTH-4)", async () => {
      await putKey("gemini");
      expect((await as(bob.token).get("/me/keys")).body).toEqual([]);
      const del = await as(bob.token).del("/me/keys/gemini");
      expect(del.status).toBe(404);
      expect(await keyRows()).toHaveLength(1);
    });

    it("needs a token", async () => {
      for (const res of [
        await request(app).get("/api/v1/me/keys"),
        await request(app).put("/api/v1/me/keys/gemini").send({ apiKey: TEST_KEY }),
        await request(app).delete("/api/v1/me/keys/gemini"),
        await request(app).get("/api/v1/models"),
      ]) {
        expect(res.status).toBe(401);
      }
      expectContract(await request(app).get("/api/v1/me/keys"), "get", "/me/keys");
      expect(await keyRows()).toEqual([]);
    });
  });

  describe("DELETE /me/keys/{providerId}", () => {
    it("204, then 404", async () => {
      await putKey("gemini");
      const res = await as().del("/me/keys/gemini");
      expect(res.status).toBe(204);
      expectContract(res, "delete", KEY_PATH);
      expect(await keyRows()).toEqual([]);
      const again = await as().del("/me/keys/gemini");
      expect(again.status).toBe(404);
      expectContract(again, "delete", KEY_PATH);
    });

    it("works after the provider is disabled", async () => {
      await putKey("gemini");
      await setProviders(["ollama"]);
      expect((await as().del("/me/keys/gemini")).status).toBe(204);
      expect(await keyRows()).toEqual([]);
    });

    it("404 for an unknown or malformed provider", async () => {
      for (const id of ["nope", "Not_An_Id"]) {
        const res = await as().del(`/me/keys/${id}`);
        expect(res.status).toBe(404);
        expectContract(res, "delete", KEY_PATH);
      }
    });
  });

  describe("GET /models", () => {
    it("lists enabled providers by name, with models and hasKey", async () => {
      await setProviders(["ollama", "gemini", "openai"]);
      await putKey("gemini");
      // A stray row for the keyless local provider still doesn't count as a key.
      await pool.query(
        `INSERT INTO app.user_api_keys (user_id, provider_id, ciphertext, iv, auth_tag, last4)
         VALUES ($1, 'ollama', '\\x00', '\\x00', '\\x00', 'abcd')`,
        [alice.userId],
      );
      const res = await as().get("/models");
      expect(res.status).toBe(200);
      expectContract(res, "get", "/models");
      expect(res.body.map((p: { name: string }) => p.name)).toEqual([
        "Google Gemini",
        "Ollama (local)",
        "OpenAI",
      ]);
      const byId = Object.fromEntries(
        res.body.map((p: { providerId: string }) => [p.providerId, p]),
      );
      expect(byId.gemini).toMatchObject({ kind: "cloud", hasKey: true });
      expect(byId.gemini.models).toContain("gemini-2.5-flash");
      expect(byId.openai).toMatchObject({ kind: "cloud", hasKey: false });
      expect(byId.ollama).toEqual({
        providerId: "ollama",
        name: "Ollama (local)",
        kind: "local",
        models: [],
        hasKey: false,
      });
      // Bob has no keys.
      const bobs = await as(bob.token).get("/models");
      expect(bobs.body.every((p: { hasKey: boolean }) => !p.hasKey)).toBe(true);
    });
  });

  describe("defaultModel in /me/settings", () => {
    const choice = { providerId: "gemini", model: "gemini-2.5-flash" };
    const stored = async () =>
      (
        await pool.query(
          "SELECT theme, default_provider_id, default_model FROM app.users WHERE id = $1",
          [alice.userId],
        )
      ).rows[0];

    it("GET always carries defaultModel, null until chosen", async () => {
      const res = await as().get(SETTINGS);
      expectContract(res, "get", SETTINGS);
      expect(res.body.defaultModel).toBeNull();
    });

    it("sets, reads back and clears with null", async () => {
      const res = await as().patch(SETTINGS, { defaultModel: choice });
      expect(res.status).toBe(200);
      expectContract(res, "patch", SETTINGS);
      expect(res.body.defaultModel).toEqual(choice);
      const got = await as().get(SETTINGS);
      expectContract(got, "get", SETTINGS);
      expect(got.body.defaultModel).toEqual(choice);

      const cleared = await as().patch(SETTINGS, { defaultModel: null });
      expect(cleared.status).toBe(200);
      expectContract(cleared, "patch", SETTINGS);
      expect(cleared.body.defaultModel).toBeNull();
      expect(await stored()).toMatchObject({ default_provider_id: null, default_model: null });
    });

    it("other fields leave the choice alone", async () => {
      await as().patch(SETTINGS, { defaultModel: choice });
      const res = await as().patch(SETTINGS, { theme: "dark" });
      expect(res.body.defaultModel).toEqual(choice);
    });

    it.each([
      ["a disabled provider", { providerId: "groq", model: "llama-3.3-70b-versatile" }],
      ["an unknown provider", { providerId: "nope", model: "x" }],
    ])("403 for %s, and nothing changes", async (_, defaultModel) => {
      const before = await stored();
      const res = await as().patch(SETTINGS, { theme: "dark", defaultModel });
      expect(res.status).toBe(403);
      expectContract(res, "patch", SETTINGS);
      expect(await stored()).toEqual(before);
    });

    it.each([
      ["a model the provider doesn't offer", { providerId: "gemini", model: "gpt-4o" }],
      ["any model for a provider with none listed", { providerId: "ollama", model: "llama3.2" }],
    ])("400 for %s, and nothing changes", async (_, defaultModel) => {
      const before = await stored();
      const res = await as().patch(SETTINGS, { theme: "dark", defaultModel });
      expect(res.status).toBe(400);
      expectContract(res, "patch", SETTINGS);
      expect(res.body.errors).toEqual([
        { path: "defaultModel.model", message: expect.any(String) },
      ]);
      expect(await stored()).toEqual(before);
    });
  });

  describe("asking with the user's key (ADR-0009)", () => {
    const choice = { providerId: "gemini", model: "gemini-2.5-flash" };

    it("sends the credential, and the audit row has provider and model but no key", async () => {
      await putKey("gemini");
      await as().patch(SETTINGS, { defaultModel: choice });
      const res = await askOnce();
      expect(res.status).toBe(201);
      expectContract(res, "post", ASK);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.credential).toEqual({ ...choice, apiKey: TEST_KEY });
      expect(calls[0]!.allowedProviders).toEqual(["gemini", "ollama"]);

      const [audit] = await audits();
      expect(audit).toMatchObject({ provider_id: "gemini", model: "gemini-2.5-flash" });
      expectNoSecret(audit);
      expectNoSecret((await pool.query("SELECT * FROM app.messages")).rows);
      expectNoSecret(res.body);
    });

    it("audits provider and model on a failed answer too, without the key", async () => {
      await putKey("gemini");
      await as().patch(SETTINGS, { defaultModel: choice });
      respond = async () => {
        throw new Error("upstream 500");
      };
      const res = await askOnce();
      expect(res.status).toBe(503);
      const [audit] = await audits();
      expect(audit).toMatchObject({ outcome: "error", provider_id: "gemini", model: choice.model });
      expectNoSecret(audit);
    });

    it("sends no credential without a key", async () => {
      await as().patch(SETTINGS, { defaultModel: choice });
      expect((await askOnce()).status).toBe(201);
      expect(calls[0]).not.toHaveProperty("credential");
      expect((await audits())[0]).toMatchObject({ provider_id: null, model: null });
    });

    it("sends no credential without a default model", async () => {
      await putKey("gemini");
      expect((await askOnce()).status).toBe(201);
      expect(calls[0]).not.toHaveProperty("credential");
    });

    it("sends no credential once the provider is disabled (SEC-11)", async () => {
      await putKey("gemini");
      await as().patch(SETTINGS, { defaultModel: choice });
      await setProviders(["ollama"]);
      expect((await askOnce()).status).toBe(201);
      expect(calls[0]).not.toHaveProperty("credential");
      expect(calls[0]!.allowedProviders).toEqual(["ollama"]);
    });

    it("sends no credential when the api has no encryption key, or a different one", async () => {
      await putKey("gemini");
      await as().patch(SETTINGS, { defaultModel: choice });
      const keyless = build({ encryptionKey: undefined });
      expect((await askOnce(alice.token, keyless)).status).toBe(201);
      const rotated = build({ encryptionKey: randomBytes(32).toString("base64") });
      expect((await askOnce(alice.token, rotated)).status).toBe(201);
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call).not.toHaveProperty("credential");
    });

    it("never uses another user's key", async () => {
      await putKey("gemini");
      await as(bob.token).patch(SETTINGS, { defaultModel: choice });
      expect((await askOnce(bob.token)).status).toBe(201);
      expect(calls[0]).not.toHaveProperty("credential");
    });
  });

  it("never writes the key to the logs (SEC-4)", async () => {
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, done) {
        out += String(chunk);
        done();
      },
    });
    const logged = build({ logger: createLogger("trace", false, sink) });
    expect((await putKey("gemini", TEST_KEY, alice.token, logged)).status).toBe(200);
    expect((await putKey("gemini", "short", alice.token, logged)).status).toBe(400);
    await as(alice.token, logged).patch(SETTINGS, {
      defaultModel: { providerId: "gemini", model: "gemini-2.5-flash" },
    });
    expect((await askOnce(alice.token, logged)).status).toBe(201);
    expect(calls[0]!.credential?.apiKey).toBe(TEST_KEY);
    respond = async () => {
      throw new Error("upstream 500");
    };
    expect((await askOnce(alice.token, logged)).status).toBe(503);

    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("research answer failed"); // the error path logged
    expect(out).not.toContain(TEST_KEY);
    expect(out).not.toContain(Buffer.from(TEST_KEY).toString("base64"));
  });
});
