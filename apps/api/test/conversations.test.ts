import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AiClient, Answer, AnswerRequest } from "../src/clients/ai.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { expectContract } from "./contract.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
// services/ai's research/answer arrives with #20, so the AI here is a fake that follows ai.v1.
const url = process.env.APP_TEST_DATABASE_URL;

const PASSWORD = "correct horse battery";
const CITATION_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";

const verifiedAnswer = (req: AnswerRequest): Answer => ({
  requestId: req.requestId,
  answerable: true,
  language: "en",
  text: `Bail is governed by s. 497 CrPC [[c:${CITATION_ID}]].`,
  citations: [
    {
      id: CITATION_ID,
      sourceId: SOURCE_ID,
      claim: "Bail is governed by s. 497 CrPC",
      locator: "s. 497",
      verification: {
        status: "verified",
        flags: [],
        lastVerifiedAt: "2026-10-01T00:00:00.000Z",
        checks: { existence: "pass", support: "pass", currency: "current" },
      },
    },
  ],
});

describe.skipIf(!url)("conversations (api.v1 /conversations*)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let calls: AnswerRequest[];
  let respond: (req: AnswerRequest) => Promise<unknown>;
  let alice: { token: string; userId: string; accountId: string };
  let bob: { token: string };

  const ai: AiClient = {
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

  async function register(email: string) {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: PASSWORD, name: email.split("@")[0] });
    return {
      token: res.body.accessToken as string,
      userId: res.body.user.id as string,
      accountId: (
        await pool.query<{ account_id: string }>("SELECT account_id FROM app.users WHERE id = $1", [
          res.body.user.id,
        ])
      ).rows[0]!.account_id,
    };
  }

  const as = (token: string) => ({
    get: (path: string) =>
      request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`),
    post: (path: string, body?: object) =>
      request(app)
        .post(`/api/v1${path}`)
        .set("Authorization", `Bearer ${token}`)
        .send(body ?? {}),
    patch: (path: string, body: object) =>
      request(app).patch(`/api/v1${path}`).set("Authorization", `Bearer ${token}`).send(body),
  });

  async function newCase(token = alice.token, title = "State v. Ahmed") {
    const res = await as(token).post("/cases", { title });
    return res.body.id as string;
  }

  async function newConversation(token = alice.token, title?: string) {
    const res = await as(token).post("/conversations", title ? { title } : {});
    return res.body.id as string;
  }

  const ask = (
    id: string,
    body: object = { question: "What governs bail?" },
    token = alice.token,
  ) => as(token).post(`/conversations/${id}/messages`, body);

  const audits = async () =>
    (
      await pool.query(
        "SELECT *, law_as_of::text AS law_as_of FROM app.ai_audit_records ORDER BY created_at",
      )
    ).rows;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
  });

  const setProviders = (enabled: string[]) =>
    pool.query("UPDATE app.providers SET enabled = (id = ANY($1::text[]))", [enabled]);

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await setProviders(["ollama"]); // the seeded default (#55)
    calls = [];
    respond = async (req) => verifiedAnswer(req);
    app = createApp({
      env: {
        CORS_ORIGIN: "http://localhost:3000",
        JWT_SECRET: "j".repeat(32),
        RESET_URL_BASE: "http://localhost:3000/reset-password",
      },
      logger: createLogger("silent", false),
      db: pool,
      orm: createDb(pool),
      ai,
      mailer: { send: async () => {} },
    });
    alice = await register("alice@example.com");
    bob = await register("bob@example.com");
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await setProviders(["ollama"]);
    await pool.end();
  });

  describe("create and list", () => {
    it("201 creates an empty conversation", async () => {
      const res = await as(alice.token).post("/conversations", { title: "Bail research" });
      expect(res.status).toBe(201);
      expectContract(res, "post", "/conversations");
      expect(res.body).toMatchObject({ title: "Bail research", caseId: null, messages: [] });
    });

    it("201 saved to the user's own active case (FR-CASE-5)", async () => {
      const caseId = await newCase();
      const res = await as(alice.token).post("/conversations", { caseId });
      expect(res.status).toBe(201);
      expectContract(res, "post", "/conversations");
      expect(res.body.caseId).toBe(caseId);
    });

    it("400 on caseId for another user's case, an archived case or an unknown id (FR-AUTH-4)", async () => {
      const archived = await newCase(alice.token, "archived");
      await as(alice.token).post(`/cases/${archived}/archive`);
      for (const caseId of [
        await newCase(bob.token),
        archived,
        "33333333-3333-4333-8333-333333333333",
      ]) {
        const res = await as(alice.token).post("/conversations", { caseId });
        expect(res.status).toBe(400);
        expectContract(res, "post", "/conversations");
        expect(res.body.errors[0].path).toBe("caseId");
      }
      expect((await as(alice.token).get("/conversations")).body.items).toEqual([]);
    });

    it("filters the list by case; another user's case id gives an empty page (FR-CASE-4)", async () => {
      const caseId = await newCase();
      const saved = (await as(alice.token).post("/conversations", { caseId, title: "saved" })).body
        .id as string;
      await newConversation(alice.token, "loose");
      const bobsCase = await newCase(bob.token);
      await as(bob.token).post("/conversations", { caseId: bobsCase });

      const res = await as(alice.token).get(`/conversations?caseId=${caseId}`);
      expect(res.status).toBe(200);
      expectContract(res, "get", "/conversations");
      expect(res.body.items.map((c: { id: string }) => c.id)).toEqual([saved]);
      const foreign = await as(alice.token).get(`/conversations?caseId=${bobsCase}`);
      expect(foreign.body).toEqual({ items: [], nextCursor: null });
      const bad = await as(alice.token).get("/conversations?caseId=nope");
      // listConversations declares no 400 in api.v1 yet (a bad cursor is a 400 too).
      expect(bad.status).toBe(400);
    });

    it("lists only the user's own conversations, most recently active first, page by page", async () => {
      const first = await newConversation(alice.token, "first");
      await newConversation(alice.token, "second");
      await newConversation(alice.token, "third");
      await newConversation(bob.token, "bob's");
      await ask(first); // activity moves it to the top

      const titles: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await as(alice.token).get(
          `/conversations?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        );
        expect(res.status).toBe(200);
        expectContract(res, "get", "/conversations");
        titles.push(...res.body.items.map((c: { title: string }) => c.title));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(titles).toEqual(["first", "third", "second"]);
    });

    it("401 without a token", async () => {
      const res = await request(app).get("/api/v1/conversations");
      expect(res.status).toBe(401);
      expectContract(res, "get", "/conversations");
    });
  });

  describe("save to a case (PATCH /conversations/{id}, FR-CASE-5)", () => {
    const PATH = "/conversations/{conversationId}";

    it("attaches and detaches, moving the conversation to the top", async () => {
      const id = await newConversation(alice.token, "older");
      await newConversation(alice.token, "newer");
      const caseId = await newCase();

      const attached = await as(alice.token).patch(`/conversations/${id}`, { caseId });
      expect(attached.status).toBe(200);
      expectContract(attached, "patch", PATH);
      expect(attached.body).toMatchObject({ id, caseId, title: "older" });
      const list = await as(alice.token).get("/conversations");
      expect(list.body.items[0].id).toBe(id);

      const detached = await as(alice.token).patch(`/conversations/${id}`, { caseId: null });
      expect(detached.status).toBe(200);
      expectContract(detached, "patch", PATH);
      expect(detached.body.caseId).toBeNull();
    });

    it("400 for another user's case or an archived one, leaving the conversation as it was", async () => {
      const id = await newConversation();
      const archived = await newCase(alice.token, "archived");
      await as(alice.token).post(`/cases/${archived}/archive`);
      for (const caseId of [await newCase(bob.token), archived]) {
        const res = await as(alice.token).patch(`/conversations/${id}`, { caseId });
        expect(res.status).toBe(400);
        expectContract(res, "patch", PATH);
        expect(res.body.errors[0].path).toBe("caseId");
      }
      expect((await as(alice.token).get(`/conversations/${id}`)).body.caseId).toBeNull();
    });

    it("400 for a body without caseId or with other fields", async () => {
      const id = await newConversation();
      for (const body of [{}, { caseId: null, title: "x" }]) {
        const res = await as(alice.token).patch(`/conversations/${id}`, body);
        expect(res.status).toBe(400);
        expectContract(res, "patch", PATH);
      }
    });

    it("404 for another user's conversation, even with the caller's own case", async () => {
      const id = await newConversation(bob.token);
      const res = await as(alice.token).patch(`/conversations/${id}`, { caseId: await newCase() });
      expect(res.status).toBe(404);
      expectContract(res, "patch", PATH);
      expect((await as(bob.token).get(`/conversations/${id}`)).body.caseId).toBeNull();
    });
  });

  describe("ask", () => {
    it("201 returns the verified answer, and the conversation holds both messages", async () => {
      const id = await newConversation();
      const res = await ask(id, { question: "What governs bail?", language: "en" });
      expect(res.status).toBe(201);
      expectContract(res, "post", "/conversations/{conversationId}/messages");
      expect(res.body).toMatchObject({ role: "assistant", answerable: true, language: "en" });
      expect(res.body.citations[0].verification.status).toBe("verified");

      const conv = await as(alice.token).get(`/conversations/${id}`);
      expectContract(conv, "get", "/conversations/{conversationId}");
      expect(conv.body.messages.map((m: { role: string }) => m.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(conv.body.messages[0].text).toBe("What governs bail?");
      expect(conv.body.title).toBe("What governs bail?"); // named by the first question
    });

    it("sends the resolved scope, the request id and the earlier turns (FR-CASE-6, FR-RES-8)", async () => {
      const id = await newConversation();
      await ask(id, { question: "First question?" });
      await ask(id, { question: "Follow-up?", lawAsOf: "2020-01-01" });
      const second = calls[1]!;
      expect(second.scope).toEqual({
        userId: alice.userId,
        accountId: alice.accountId,
        allowedCaseIds: [],
      });
      expect(second.lawAsOf).toBe("2020-01-01");
      expect(second.history?.map((t) => t.role)).toEqual(["user", "assistant"]);
      expect(second.history?.[0]?.content).toBe("First question?");
      expect(second.requestId).not.toBe(calls[0]!.requestId);
    });

    it("scopes a case conversation to exactly that case, and audits it (FR-CASE-6, SEC-8)", async () => {
      const caseId = await newCase();
      await newCase(alice.token, "another of alice's");
      await as(bob.token).post("/conversations", { caseId: await newCase(bob.token) });
      const id = (await as(alice.token).post("/conversations", { caseId })).body.id as string;
      await ask(id);
      expect(calls[0]!.scope).toEqual({
        userId: alice.userId,
        accountId: alice.accountId,
        allowedCaseIds: [caseId],
      });
      expect((await audits())[0]).toMatchObject({ conversation_id: id, case_id: caseId });

      // Detached, the next question is back to the public corpus only.
      await as(alice.token).patch(`/conversations/${id}`, { caseId: null });
      await ask(id, { question: "Follow-up?" });
      expect(calls[1]!.scope.allowedCaseIds).toEqual([]);
    });

    it("keeps an archived case's scope for a conversation already saved to it", async () => {
      const caseId = await newCase();
      const id = (await as(alice.token).post("/conversations", { caseId })).body.id as string;
      await as(alice.token).post(`/cases/${caseId}/archive`);
      await ask(id);
      expect(calls[0]!.scope.allowedCaseIds).toEqual([caseId]);
    });

    it("writes the audit record keyed by the request id (FR-TRUST-12)", async () => {
      const id = await newConversation();
      await ask(id, { question: "What governs bail?", lawAsOf: "2024-05-01" });
      const [audit] = await audits();
      expect(audit).toMatchObject({
        request_id: calls[0]!.requestId,
        owner_user_id: alice.userId,
        account_id: alice.accountId,
        conversation_id: id,
        case_id: null,
        question: "What governs bail?",
        law_as_of: "2024-05-01",
        outcome: "answered",
        answer_language: "en",
      });
      expect(audit.response_text).toContain("s. 497");
      expect(audit.citations[0].verification.status).toBe("verified");
      expect(audit.latency_ms).toBeGreaterThanOrEqual(0);
    });

    it("stores and returns the law-as-of note with the answer (FR-RES-11)", async () => {
      const note = "Law as of 2020-01-01: judgments decided after this date were left out.";
      respond = async (req) => ({ ...verifiedAnswer(req), asOfNote: note });
      const id = await newConversation();
      const res = await ask(id, { question: "What governs bail?", lawAsOf: "2020-01-01" });
      expect(res.status).toBe(201);
      expectContract(res, "post", "/conversations/{conversationId}/messages");
      expect(res.body.asOfNote).toBe(note);

      const conv = await as(alice.token).get(`/conversations/${id}`);
      expectContract(conv, "get", "/conversations/{conversationId}");
      const [question, answer] = conv.body.messages;
      expect(question).not.toHaveProperty("asOfNote");
      expect(answer.asOfNote).toBe(note);
      const { rows } = await pool.query(
        "SELECT as_of_note FROM app.messages WHERE role = 'assistant' AND conversation_id = $1",
        [id],
      );
      expect(rows).toEqual([{ as_of_note: note }]);
    });

    it("an answer without a date carries no note", async () => {
      const res = await ask(await newConversation());
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty("asOfNote");
    });

    it("an unanswerable question is answered as such and audited (FR-RES-9)", async () => {
      respond = async (req) => ({
        requestId: req.requestId,
        answerable: false,
        language: "en",
        text: "The corpus doesn't cover this.",
        citations: [],
      });
      const res = await ask(await newConversation());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ answerable: false, citations: [] });
      expect((await audits())[0].outcome).toBe("unanswerable");
    });

    const failures: [string, (req: AnswerRequest) => Promise<unknown>][] = [
      [
        "the AI service is down",
        async () => {
          throw new Error("AI service /ai/v1/research/answer -> 502");
        },
      ],
      [
        "a citation has no verification (FR-RES-6)",
        async (req) => {
          const answer = verifiedAnswer(req) as unknown as { citations: object[] };
          answer.citations = [{ id: CITATION_ID, sourceId: SOURCE_ID, claim: "x" }];
          return answer;
        },
      ],
      [
        "the answer is for another request",
        async (req) => ({ ...verifiedAnswer(req), requestId: CITATION_ID }),
      ],
      [
        "an unanswerable answer carries citations",
        async (req) => ({ ...verifiedAnswer(req), answerable: false }),
      ],
    ];
    for (const [why, reply] of failures) {
      it(`503 when ${why}: nothing stored, the error audited`, async () => {
        respond = reply;
        const id = await newConversation();
        const res = await ask(id);
        expect(res.status).toBe(503);
        expectContract(res, "post", "/conversations/{conversationId}/messages");
        const conv = await as(alice.token).get(`/conversations/${id}`);
        expect(conv.body.messages).toEqual([]);
        const [audit] = await audits();
        expect(audit).toMatchObject({ outcome: "error", request_id: calls[0]!.requestId });
        expect(audit.error).toBeTruthy();
      });
    }

    it("400 for an empty question", async () => {
      const res = await ask(await newConversation(), { question: "" });
      expect(res.status).toBe(400);
      expectContract(res, "post", "/conversations/{conversationId}/messages");
      expect(calls).toHaveLength(0);
    });
  });

  describe("access", () => {
    it("403 when AI is disabled for the user, without calling the AI (FR-AUTH-3)", async () => {
      const id = await newConversation();
      await pool.query("UPDATE app.users SET ai_enabled = false WHERE id = $1", [alice.userId]);
      const res = await ask(id);
      expect(res.status).toBe(403);
      expectContract(res, "post", "/conversations/{conversationId}/messages");
      expect(calls).toHaveLength(0);
    });

    it("another user's conversation is 404 on read and on ask (FR-AUTH-4)", async () => {
      const id = await newConversation(alice.token);
      const read = await as(bob.token).get(`/conversations/${id}`);
      expect(read.status).toBe(404);
      expectContract(read, "get", "/conversations/{conversationId}");
      const asked = await ask(id, { question: "Can I see this?" }, bob.token);
      expect(asked.status).toBe(404);
      expect(calls).toHaveLength(0);
      expect((await as(alice.token).get("/conversations/not-a-uuid")).status).toBe(404);
    });

    it("429 with Retry-After after 30 questions in 15 minutes (SEC-15)", async () => {
      const id = await newConversation();
      for (let i = 0; i < 30; i++) expect((await ask(id)).status).toBe(201);
      const res = await ask(id);
      expect(res.status).toBe(429);
      expectContract(res, "post", "/conversations/{conversationId}/messages");
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("provider allow-list (SEC-11, #75)", () => {
    it("sends exactly the enabled providers, read fresh on every question", async () => {
      const id = await newConversation();
      await ask(id);
      expect(calls[0]!.allowedProviders).toEqual(["ollama"]);

      await setProviders(["ollama", "gemini"]);
      await ask(id);
      expect(calls[1]!.allowedProviders).toEqual(["gemini", "ollama"]);

      await setProviders(["gemini"]);
      await ask(id);
      expect(calls[2]!.allowedProviders).toEqual(["gemini"]);
    });

    it("records the allow-list in effect on the audit row", async () => {
      await setProviders(["ollama", "groq"]);
      await ask(await newConversation());
      expect((await audits())[0].allowed_providers).toEqual(["groq", "ollama"]);
    });

    it("503 with no provider enabled, without calling the AI; the error is audited", async () => {
      await setProviders([]);
      const id = await newConversation();
      const res = await ask(id);
      expect(res.status).toBe(503);
      expectContract(res, "post", "/conversations/{conversationId}/messages");
      expect(res.body.detail).toMatch(/No model provider is enabled/);
      expect(calls).toHaveLength(0);
      const [audit] = await audits();
      expect(audit).toMatchObject({
        outcome: "error",
        error: "no provider enabled",
        allowed_providers: [],
      });
      expect((await as(alice.token).get(`/conversations/${id}`)).body.messages).toEqual([]);
    });
  });

  describe("audit trail", () => {
    it("is append-only: an UPDATE is rejected", async () => {
      await ask(await newConversation());
      await expect(
        pool.query("UPDATE app.ai_audit_records SET question = 'edited'"),
      ).rejects.toThrow(/append-only/);
    });

    it("survives deleting the conversation, with the link cleared", async () => {
      const id = await newConversation();
      await ask(id);
      await pool.query("DELETE FROM app.conversations WHERE id = $1", [id]);
      const [audit] = await audits();
      expect(audit).toMatchObject({ conversation_id: null, outcome: "answered" });
    });
  });
});
