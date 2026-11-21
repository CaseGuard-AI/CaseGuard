import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AiClient, LintRequest, LintResult, LintRulesetList } from "../src/clients/ai.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { insertDraft } from "../src/drafts/store.js";
import { createLogger } from "../src/lib/logger.js";
import { defaultTitle } from "../src/routes/lint.js";
import { expectContract } from "./contract.js";
import { documentDeps, noIngestion } from "./stubs.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

const PASSWORD = "correct horse battery";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";
// An emoji (two UTF-16 units), Urdu and CRLF: the stored text must come back byte for byte.
const TEXT = "\u{1F600} درخواست\r\nIN THE COURT OF SESSIONS JUDGE\r\nFIR\r\n";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const RULESETS: LintRulesetList = {
  items: [
    {
      id: "bail_application",
      documentType: "bail_application",
      version: "1",
      title: "Bail application (ss.497 and 498 CrPC)",
      rules: [
        {
          id: "bail.fir_number",
          kind: "missing_particular",
          severity: "error",
          title: "FIR number",
          source: null,
        },
        {
          id: "bail.grounds",
          kind: "missing_section",
          severity: "error",
          title: "Grounds",
          source: { provision: "s.497(2) CrPC", reference: null },
        },
      ],
    },
    {
      id: "plaint",
      documentType: "plaint",
      version: "1",
      title: "Plaint (Order VII CPC)",
      rules: [],
    },
  ],
};

/** What services/ai would say: one spanned finding at "FIR", one missing section, one warning. */
function lintOf(req: LintRequest): LintResult {
  const at = req.text.indexOf("FIR");
  return {
    requestId: req.requestId,
    rulesetId: req.documentType,
    rulesetVersion: "1",
    inputSha256: sha(req.text),
    findings: [
      ...(at >= 0
        ? [
            {
              ruleId: "bail.fir_number",
              kind: "missing_particular" as const,
              severity: "error" as const,
              message: "Could not find the FIR number.",
              span: { start: at, end: at + 3 },
              source: null,
            },
          ]
        : []),
      {
        ruleId: "bail.grounds",
        kind: "missing_section",
        severity: "error",
        message: "Could not find the grounds for bail.",
        span: null,
        source: { provision: "s.497(2) CrPC", reference: null },
      },
      {
        ruleId: "bail.earlier_application",
        kind: "missing_particular",
        severity: "warning",
        message: "Could not find a statement of whether an earlier bail application was filed.",
        span: null,
        source: null,
      },
    ],
  };
}

interface Who {
  token: string;
  userId: string;
  accountId: string;
  caseId: string;
  draftId: string;
}

describe.skipIf(!url)("lint reports (api.v1 /lint*)", () => {
  let pool: pg.Pool;
  let orm: Db;
  let app: ReturnType<typeof createApp>;
  let alice: Who;
  let bob: Who;
  let lintCalls: LintRequest[];
  let lintReply: (req: LintRequest) => Promise<unknown>;
  let rulesetsReply: () => Promise<unknown>;

  const ai: AiClient = {
    ...noIngestion,
    info: async () => ({ service: "caseguard-ai", version: "test" }),
    answer: async () => {
      throw new Error("not used");
    },
    getCitation: async () => {
      throw new Error("not used");
    },
    getSource: async () => {
      throw new Error("not used");
    },
    listLintRulesets: () => rulesetsReply() as Promise<LintRulesetList>,
    lint: (req) => {
      lintCalls.push(req);
      return lintReply(req) as Promise<LintResult>;
    },
  };

  const as = (who: Who) => {
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${who.token}`);
    return {
      get: (path: string) => auth(request(app).get(`/api/v1${path}`)),
      post: (path: string) => auth(request(app).post(`/api/v1${path}`)),
      delete: (path: string) => auth(request(app).delete(`/api/v1${path}`)),
    };
  };

  async function register(email: string): Promise<Who> {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: PASSWORD, name: email.split("@")[0] });
    const token = res.body.accessToken as string;
    const { rows } = await pool.query<{ id: string; account_id: string }>(
      "SELECT id, account_id FROM app.users WHERE email = $1",
      [email],
    );
    const who = {
      token,
      userId: rows[0]!.id,
      accountId: rows[0]!.account_id,
      caseId: "",
      draftId: "",
    };
    const created = await as(who).post("/cases").send({ title: "State v. Ahmed" });
    const draft = await insertDraft(orm, who, {
      templateId: "bail_application",
      templateVersion: "1",
      caseId: null,
      title: "Bail draft",
      fields: {},
      sections: [],
    });
    return { ...who, caseId: created.body.id as string, draftId: draft.id };
  }

  const create = (who: Who, body: object) =>
    as(who)
      .post("/lint-reports")
      .send({ documentType: "bail_application", text: TEXT, ...body });

  const storedCount = async () =>
    Number((await pool.query("SELECT count(*) AS n FROM app.lint_reports")).rows[0].n);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
    orm = createDb(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    lintCalls = [];
    lintReply = async (req) => lintOf(req);
    rulesetsReply = async () => RULESETS;
    app = createApp({
      env: {
        CORS_ORIGIN: "http://localhost:3000",
        JWT_SECRET: "j".repeat(32),
        RESET_URL_BASE: "http://localhost:3000/reset-password",
      },
      logger: createLogger("silent", false),
      db: pool,
      orm,
      ai,
      mailer: { send: async () => {} },
      ...documentDeps(),
    });
    alice = await register("alice@example.com");
    bob = await register("bob@example.com");
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  describe("GET /lint/rulesets", () => {
    it("401 without a token", async () => {
      const res = await request(app).get("/api/v1/lint/rulesets");
      expect(res.status).toBe(401);
      expectContract(res, "get", "/lint/rulesets");
    });

    it("passes services/ai's rule sets through, sources and nulls included", async () => {
      const res = await as(alice).get("/lint/rulesets");
      expect(res.status).toBe(200);
      expectContract(res, "get", "/lint/rulesets");
      expect(res.body).toEqual(RULESETS);
    });

    it("503 when services/ai is down or answers off-contract", async () => {
      rulesetsReply = async () => {
        throw new Error("connect ECONNREFUSED");
      };
      let res = await as(alice).get("/lint/rulesets");
      expect(res.status).toBe(503);
      expectContract(res, "get", "/lint/rulesets");
      rulesetsReply = async () => ({ items: [{ id: "x", documentType: "memo" }] });
      res = await as(alice).get("/lint/rulesets");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /lint-reports", () => {
    it("401 without a token", async () => {
      const res = await request(app)
        .post("/api/v1/lint-reports")
        .send({ documentType: "plaint", text: "x" });
      expect(res.status).toBe(401);
      expectContract(res, "post", "/lint-reports");
    });

    it("lints, stores the text exactly as sent and returns the report (FR-LINT-3)", async () => {
      const res = await create(alice, {});
      expect(res.status).toBe(201);
      expectContract(res, "post", "/lint-reports");
      expect(res.body).toMatchObject({
        documentType: "bail_application",
        title: defaultTitle("bail_application"),
        caseId: null,
        draftId: null,
        text: TEXT,
        inputSha256: sha(TEXT),
        rulesetId: "bail_application",
        rulesetVersion: "1",
      });
      expect(res.body.findings).toEqual(lintOf({ ...lintCalls[0]!, text: TEXT }).findings);
      const span = res.body.findings[0].span as { start: number; end: number };
      expect(TEXT.slice(span.start, span.end)).toBe("FIR");

      expect(lintCalls).toHaveLength(1);
      expect(lintCalls[0]).toMatchObject({ documentType: "bail_application", text: TEXT });
      const { rows } = await pool.query("SELECT text, owner_user_id FROM app.lint_reports");
      expect(Buffer.from(rows[0].text, "utf8").equals(Buffer.from(TEXT, "utf8"))).toBe(true);
      expect(rows[0].owner_user_id).toBe(alice.userId);
    });

    it("the default title is the document type and the date in Pakistan", () => {
      expect(defaultTitle("plaint", new Date("2026-11-21T20:00:00Z"))).toBe("Plaint, 2026-11-22");
      expect(defaultTitle("bail_application", new Date("2026-11-21T08:00:00Z"))).toBe(
        "Bail application, 2026-11-21",
      );
    });

    it("saves to the caller's active case and records the draft link (FR-CASE-5)", async () => {
      const res = await create(alice, {
        caseId: alice.caseId,
        draftId: alice.draftId,
        title: "  Bail for Aslam  ",
      });
      expect(res.status).toBe(201);
      expectContract(res, "post", "/lint-reports");
      expect(res.body).toMatchObject({
        caseId: alice.caseId,
        draftId: alice.draftId,
        title: "Bail for Aslam",
      });
    });

    it.each([
      ["another user's draft", () => bob.draftId],
      ["an unknown draft", () => UNKNOWN],
    ])(
      "400 on draftId for %s, before services/ai is asked (FR-AUTH-4)",
      async (_label, draftId) => {
        const res = await create(alice, { draftId: draftId() });
        expect(res.status).toBe(400);
        expectContract(res, "post", "/lint-reports");
        expect(res.body.errors).toEqual([{ path: "draftId", message: "No such draft" }]);
        expect(lintCalls).toHaveLength(0);
        expect(await storedCount()).toBe(0);
      },
    );

    it("keeps the report when its draft is deleted, with draftId cleared", async () => {
      const res = await create(alice, { draftId: alice.draftId });
      expect((await as(alice).delete(`/drafts/${alice.draftId}`)).status).toBe(204);
      const after = await as(alice).get(`/lint-reports/${res.body.id}`);
      expect(after.status).toBe(200);
      expect(after.body.draftId).toBeNull();
    });

    it.each([
      ["another user's case", () => bob.caseId],
      ["an unknown case", () => UNKNOWN],
    ])("400 on caseId for %s, before services/ai is asked", async (_label, caseId) => {
      const res = await create(alice, { caseId: caseId() });
      expect(res.status).toBe(400);
      expectContract(res, "post", "/lint-reports");
      expect(res.body.errors).toEqual([{ path: "caseId", message: expect.any(String) }]);
      expect(lintCalls).toHaveLength(0);
      expect(await storedCount()).toBe(0);
    });

    it("400 on caseId for an archived case", async () => {
      await as(alice).post(`/cases/${alice.caseId}/archive`);
      const res = await create(alice, { caseId: alice.caseId });
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual([{ path: "caseId", message: "That case is archived" }]);
    });

    it.each([
      [{ documentType: "legal_notice" }, "documentType"],
      [{ text: "" }, "text"],
      [{ text: "x".repeat(200_001) }, "text"],
      [{ caseId: "not-a-uuid" }, "caseId"],
      [{ draftId: "not-a-uuid" }, "draftId"],
      [{ title: "t".repeat(201) }, "title"],
      [{ extra: true }, ""],
    ])("400 for %j", async (body, path) => {
      const res = await create(alice, body);
      expect(res.status).toBe(400);
      expectContract(res, "post", "/lint-reports");
      expect(res.body.errors.map((e: { path: string }) => e.path)).toContain(path);
      expect(lintCalls).toHaveLength(0);
      expect(res.text).not.toContain("xxxxxxxxxx"); // the text is never echoed
    });

    it("counts the length in characters, as the contract does, not UTF-16 units", async () => {
      const res = await create(alice, { text: "\u{1F600}".repeat(150_000) });
      expect(res.status).toBe(201);
    });

    it("400 on text that has no UTF-8 encoding (a lone surrogate)", async () => {
      const res = await as(alice)
        .post("/lint-reports")
        .set("Content-Type", "application/json")
        .send('{"documentType":"plaint","text":"a\\ud800b"}');
      expect(res.status).toBe(400);
      expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["text"]);
      expect(lintCalls).toHaveLength(0);
    });

    it.each([
      ["services/ai is down", async () => Promise.reject(new Error("ECONNREFUSED"))],
      [
        "the hash is not of the text sent",
        async (r: LintRequest) => ({ ...lintOf(r), inputSha256: sha("other") }),
      ],
      [
        "a span lies outside the text",
        async (r: LintRequest) => {
          const result = lintOf(r);
          result.findings[0]!.span = { start: 0, end: r.text.length + 1 };
          return result;
        },
      ],
      [
        "the result is for another request",
        async (r: LintRequest) => ({ ...lintOf(r), requestId: randomUUID() }),
      ],
      [
        "a finding is off-contract",
        async (r: LintRequest) => ({ ...lintOf(r), findings: [{ ruleId: "x" }] }),
      ],
    ])("503 and nothing stored when %s", async (_label, reply) => {
      lintReply = reply as (req: LintRequest) => Promise<unknown>;
      const res = await create(alice, {});
      expect(res.status).toBe(503);
      expectContract(res, "post", "/lint-reports");
      expect(await storedCount()).toBe(0);
    });
  });

  describe("GET /lint-reports", () => {
    it("401 without a token", async () => {
      const res = await request(app).get("/api/v1/lint-reports");
      expect(res.status).toBe(401);
      expectContract(res, "get", "/lint-reports");
    });

    it("lists only the caller's reports, newest first, with finding counts", async () => {
      const first = await create(alice, { title: "First" });
      const second = await create(alice, { title: "Second", caseId: alice.caseId });
      await create(bob, { title: "Bob's" });
      const res = await as(alice).get("/lint-reports");
      expect(res.status).toBe(200);
      expectContract(res, "get", "/lint-reports");
      expect(res.body.items.map((r: { id: string }) => r.id)).toEqual([
        second.body.id,
        first.body.id,
      ]);
      expect(res.body.items[0]).toEqual({
        id: second.body.id,
        documentType: "bail_application",
        title: "Second",
        caseId: alice.caseId,
        draftId: null,
        findingCounts: { error: 2, warning: 1, info: 0 },
        createdAt: second.body.createdAt,
      });
      expect(res.body.nextCursor).toBeNull();
    });

    it("filters by case; another user's case gives an empty page", async () => {
      await create(alice, { title: "Loose" });
      const inCase = await create(alice, { caseId: alice.caseId });
      let res = await as(alice).get(`/lint-reports?caseId=${alice.caseId}`);
      expectContract(res, "get", "/lint-reports");
      expect(res.body.items.map((r: { id: string }) => r.id)).toEqual([inCase.body.id]);
      await create(bob, { caseId: bob.caseId });
      res = await as(alice).get(`/lint-reports?caseId=${bob.caseId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    });

    it("pages with a cursor", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await create(alice, { title: `R${i}` })).body.id);
      const page1 = await as(alice).get("/lint-reports?limit=2");
      expectContract(page1, "get", "/lint-reports");
      expect(page1.body.items.map((r: { id: string }) => r.id)).toEqual([ids[2], ids[1]]);
      const page2 = await as(alice).get(`/lint-reports?limit=2&cursor=${page1.body.nextCursor}`);
      expect(page2.body.items.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
      expect(page2.body.nextCursor).toBeNull();
    });

    it("400 for a bad cursor or caseId", async () => {
      let res = await as(alice).get("/lint-reports?cursor=nope");
      expect(res.status).toBe(400);
      expectContract(res, "get", "/lint-reports");
      res = await as(alice).get("/lint-reports?caseId=nope");
      expect(res.status).toBe(400);
      expectContract(res, "get", "/lint-reports");
    });
  });

  describe("GET and DELETE /lint-reports/{reportId}", () => {
    it("401 without a token", async () => {
      let res = await request(app).get(`/api/v1/lint-reports/${UNKNOWN}`);
      expect(res.status).toBe(401);
      expectContract(res, "get", "/lint-reports/{reportId}");
      res = await request(app).delete(`/api/v1/lint-reports/${UNKNOWN}`);
      expect(res.status).toBe(401);
      expectContract(res, "delete", "/lint-reports/{reportId}");
    });

    it("returns the caller's report with its text and findings", async () => {
      const created = await create(alice, { caseId: alice.caseId });
      const res = await as(alice).get(`/lint-reports/${created.body.id}`);
      expect(res.status).toBe(200);
      expectContract(res, "get", "/lint-reports/{reportId}");
      expect(res.body).toEqual(created.body);
      expect(res.body.text).toBe(TEXT);
    });

    it("404 for another user's, an unknown or a malformed id (FR-AUTH-4)", async () => {
      const bobs = await create(bob, {});
      for (const id of [bobs.body.id, UNKNOWN, "nope"]) {
        const res = await as(alice).get(`/lint-reports/${id}`);
        expect(res.status).toBe(404);
        expectContract(res, "get", "/lint-reports/{reportId}");
      }
      const res = await as(alice).delete(`/lint-reports/${bobs.body.id}`);
      expect(res.status).toBe(404);
      expectContract(res, "delete", "/lint-reports/{reportId}");
      expect((await as(bob).get(`/lint-reports/${bobs.body.id}`)).status).toBe(200);
    });

    it("deletes the caller's report", async () => {
      const created = await create(alice, {});
      const res = await as(alice).delete(`/lint-reports/${created.body.id}`);
      expect(res.status).toBe(204);
      expectContract(res, "delete", "/lint-reports/{reportId}");
      expect((await as(alice).get(`/lint-reports/${created.body.id}`)).status).toBe(404);
      expect((await as(alice).delete(`/lint-reports/${created.body.id}`)).status).toBe(404);
    });

    it("a case's reports go when the case's owner goes", async () => {
      await create(alice, { caseId: alice.caseId });
      await pool.query("DELETE FROM app.users WHERE id = $1", [alice.userId]);
      expect(await storedCount()).toBe(0);
    });
  });
});
