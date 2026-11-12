import pg from "pg";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { createMailer, type MailMessage, type Mailer } from "../src/lib/mailer.js";
import { expectContract } from "./contract.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;
const mailpit = process.env.MAILPIT_URL;

const RESET_URL_BASE = "http://localhost:3000/reset-password";
const alice = { email: "Alice@Example.com", password: "correct horse battery", name: "Alice" };
const NEW_PASSWORD = "a brand new password";

const tokenFrom = (text: string) => {
  const match = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(text);
  expect(match, "no reset link in the email").not.toBeNull();
  return match![1]!;
};

const refreshCookie = (res: Response) =>
  ([] as string[])
    .concat(res.headers["set-cookie"] ?? [])
    .find((c) => c.startsWith("cg_refresh="))!
    .split(";")[0]!;

describe.skipIf(!url)("password reset (api.v1 /auth/password-reset*)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let sent: MailMessage[];

  const resetRows = async () =>
    Number((await pool.query("SELECT count(*) FROM app.password_reset_tokens")).rows[0].count);

  function build(mailer: Mailer) {
    return createApp({
      env: { CORS_ORIGIN: "http://localhost:3000", JWT_SECRET: "j".repeat(32), RESET_URL_BASE },
      logger: createLogger("silent", false),
      db: pool,
      orm: createDb(pool),
      ai: { info: async () => ({ service: "caseguard-ai", version: "test" }) } as AppDeps["ai"],
      mailer,
    });
  }

  const requestReset = (email = alice.email) =>
    request(app).post("/api/v1/auth/password-reset").send({ email });
  const confirm = (token: string, password = NEW_PASSWORD) =>
    request(app).post("/api/v1/auth/password-reset/confirm").send({ token, password });
  const login = (password: string) =>
    request(app).post("/api/v1/auth/login").send({ email: alice.email, password });

  // The email is sent in the background after the 202, so wait for it.
  async function resetToken(): Promise<string> {
    const before = sent.length;
    const res = await requestReset();
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(sent.length).toBe(before + 1));
    return tokenFrom(sent.at(-1)!.text);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
  });

  let registered: Response;
  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    sent = [];
    app = build({ send: async (m) => void sent.push(m) });
    registered = await request(app).post("/api/v1/auth/register").send(alice);
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  describe("request", () => {
    it("202 and emails the user a single-use link", async () => {
      const res = await requestReset("alice@example.com");
      expect(res.status).toBe(202);
      expectContract(res, "post", "/auth/password-reset");
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({ to: alice.email, subject: "Reset your CaseGuard password" });
      expect(sent[0]!.text).toContain(`${RESET_URL_BASE}?token=`);
      expect(await resetRows()).toBe(1);
    });

    it("202 for an unknown email, with no email and no token", async () => {
      const res = await requestReset("nobody@example.com");
      expect(res.status).toBe(202);
      expectContract(res, "post", "/auth/password-reset");
      await new Promise((r) => setTimeout(r, 300));
      expect(sent).toHaveLength(0);
      expect(await resetRows()).toBe(0);
    });

    it("400 for an invalid email", async () => {
      const res = await request(app).post("/api/v1/auth/password-reset").send({ email: "nope" });
      expect(res.status).toBe(400);
      expectContract(res, "post", "/auth/password-reset");
    });

    it("429 with Retry-After after 5 requests for the same email (SEC-15)", async () => {
      for (let i = 0; i < 5; i++) expect((await requestReset()).status).toBe(202);
      const res = await requestReset();
      expect(res.status).toBe(429);
      expectContract(res, "post", "/auth/password-reset");
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      // The 5 accepted requests insert their tokens in the background. Wait for all 5 emails
      // (each is sent after its insert), or the next test's TRUNCATE can deadlock with an
      // insert that is still checking its foreign key.
      await vi.waitFor(() => expect(sent).toHaveLength(5));
    });
  });

  describe("confirm", () => {
    it("204 sets the new password and ends every session", async () => {
      const oldCookie = refreshCookie(registered);
      const res = await confirm(await resetToken());
      expect(res.status).toBe(204);
      expectContract(res, "post", "/auth/password-reset/confirm");

      const refresh = await request(app).post("/api/v1/auth/refresh").set("Cookie", oldCookie);
      expect(refresh.status).toBe(401);
      expect((await login(alice.password)).status).toBe(401);
      expect((await login(NEW_PASSWORD)).status).toBe(200);
    });

    it("400 when the token is used twice", async () => {
      const token = await resetToken();
      expect((await confirm(token)).status).toBe(204);
      const res = await confirm(token, "yet another password");
      expect(res.status).toBe(400);
      expectContract(res, "post", "/auth/password-reset/confirm");
    });

    it("400 for an expired token", async () => {
      const token = await resetToken();
      await pool.query("UPDATE app.password_reset_tokens SET expires_at = now() - interval '1 s'");
      expect((await confirm(token)).status).toBe(400);
    });

    it("400 for a token replaced by a newer request", async () => {
      const first = await resetToken();
      const second = await resetToken();
      expect((await confirm(first)).status).toBe(400);
      expect((await confirm(second)).status).toBe(204);
    });

    it("400 for an unknown token or a short password", async () => {
      const unknown = await confirm("not-a-real-token");
      expect(unknown.status).toBe(400);
      expectContract(unknown, "post", "/auth/password-reset/confirm");
      const short = await confirm(await resetToken(), "short");
      expect(short.status).toBe(400);
      expect(short.body.errors).toContainEqual(expect.objectContaining({ path: "password" }));
    });
  });

  // End to end with the real mailer: request → email in Mailpit → link → new password → sign in.
  describe.skipIf(!mailpit)("through Mailpit", () => {
    it("the emailed link resets the password", async () => {
      app = build(
        createMailer(
          {
            SMTP_HOST: new URL(mailpit!).hostname,
            SMTP_PORT: Number(process.env.MAILPIT_SMTP_PORT ?? 1025),
            SMTP_SECURE: false,
            SMTP_USER: undefined,
            SMTP_PASSWORD: undefined,
            MAIL_FROM: "CaseGuard <no-reply@caseguard.local>",
          },
          createLogger("silent", false),
        ),
      );
      const email = `reset-${Date.now()}@example.com`;
      await request(app)
        .post("/api/v1/auth/register")
        .send({ ...alice, email });
      expect((await requestReset(email)).status).toBe(202);

      const found = await vi.waitFor(
        async () => {
          const res = await fetch(
            `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
          );
          const { messages } = (await res.json()) as { messages: { ID: string }[] };
          expect(messages).toHaveLength(1);
          return messages[0]!;
        },
        { timeout: 5000, interval: 200 },
      );
      const message = (await (await fetch(`${mailpit}/api/v1/message/${found.ID}`)).json()) as {
        Text: string;
      };

      expect((await confirm(tokenFrom(message.Text))).status).toBe(204);
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email, password: NEW_PASSWORD });
      expect(res.status).toBe(200);
    });
  });
});
