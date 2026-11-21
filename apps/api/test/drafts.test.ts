import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  AiHttpError,
  type AiClient,
  type Citation,
  type DraftSectionRequest,
  type DraftTemplate,
} from "../src/clients/ai.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { expectContract } from "./contract.js";
import { documentDeps, noIngestion } from "./stubs.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL). The AI
// is a fake that follows ai.v1 (#212): templates, section drafting and the trust store.
const url = process.env.APP_TEST_DATABASE_URL;
const PASSWORD = "correct horse battery";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";

const BAIL: DraftTemplate = {
  id: "bail_application",
  version: "1",
  title: "Bail application (s.497/498 CrPC)",
  description: "Bail after or before arrest.",
  fields: [
    { key: "court", label: "Court", required: true, caseField: "court" },
    { key: "parties", label: "Parties", required: true, caseField: "parties" },
    { key: "offences", label: "Offences", required: true, caseField: "relevantLaws" },
    { key: "fir_number", label: "FIR number", required: true, caseField: null },
    { key: "counsel", label: "Counsel", required: false, caseField: "assignedLawyer" },
  ],
  sections: [
    {
      key: "cause_title",
      heading: "Cause title",
      required: true,
      assistable: false,
      guidance: "g",
    },
    { key: "facts", heading: "Brief facts", required: true, assistable: true, guidance: "g" },
    {
      key: "grounds",
      heading: "Grounds for bail",
      required: true,
      assistable: true,
      guidance: "g",
    },
    { key: "prayer", heading: "Prayer", required: true, assistable: true, guidance: "g" },
  ],
};
const NOTICE: DraftTemplate = {
  ...BAIL,
  id: "legal_notice",
  title: "Legal notice",
  fields: [{ key: "subject", label: "Subject", required: true, caseField: "title" }],
  sections: [{ key: "demand", heading: "Demand", required: true, assistable: true, guidance: "g" }],
};
const PLAINT: DraftTemplate = { ...NOTICE, id: "plaint", title: "Plaint (Order VII CPC)" };

const citation = (id: string, status: Citation["verification"]["status"]): Citation => ({
  id,
  sourceId: SOURCE_ID,
  claim: "Bail is the rule in offences outside the prohibitory clause.",
  locator: "s. 497",
  verification: {
    status,
    flags: [],
    lastVerifiedAt: "2026-11-01T00:00:00.000Z",
    checks: { existence: "pass", support: "pass", currency: "unknown" },
  },
});

describe.skipIf(!url)("drafts (api.v1 /drafting/templates, /drafts*)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let alice: { token: string; userId: string };
  let bob: { token: string };
  let store: Map<string, Citation>; // the fake trust store
  let draftCalls: DraftSectionRequest[];
  let templateCalls: number;
  let failDraft: Error | undefined;
  let failTemplates: boolean;
  let counter: number;

  const ai: AiClient = {
    ...noIngestion,
    info: async () => ({ service: "caseguard-ai", version: "test" }),
    answer: async () => {
      throw new Error("not used");
    },
    getCitation: async (id) => {
      const found = store.get(id);
      if (!found) throw new AiHttpError(`/ai/v1/citations/${id}`, 404);
      return structuredClone(found);
    },
    getSource: async (id) => ({
      id,
      kind: "statute",
      title: "Code of Criminal Procedure, 1898",
      officialUrl: "https://pakistancode.gov.pk/english/crpc",
      language: "en",
    }),
    listDraftTemplates: async () => {
      templateCalls += 1;
      if (failTemplates) throw new Error("ai down");
      return { items: [BAIL, PLAINT, NOTICE] };
    },
    draftSection: async (req) => {
      draftCalls.push(req);
      if (failDraft) throw failDraft;
      counter += 1;
      const id = `33333333-3333-4333-8333-${String(counter).padStart(12, "0")}`;
      store.set(id, citation(id, "verified"));
      return {
        requestId: req.requestId,
        text: `1. That bail is the rule [[c:${id}]].`,
        citations: [store.get(id)!],
      };
    },
  };

  async function register(email: string) {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: PASSWORD, name: email.split("@")[0] });
    return { token: res.body.accessToken as string, userId: res.body.user.id as string };
  }

  const as = (token: string) => ({
    get: (path: string) =>
      request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`),
    post: (path: string, body?: object) =>
      request(app)
        .post(`/api/v1${path}`)
        .set("Authorization", `Bearer ${token}`)
        .send(body ?? {}),
    put: (path: string, body: object) =>
      request(app).put(`/api/v1${path}`).set("Authorization", `Bearer ${token}`).send(body),
    delete: (path: string) =>
      request(app).delete(`/api/v1${path}`).set("Authorization", `Bearer ${token}`),
  });

  async function newCase(token = alice.token) {
    const res = await as(token).post("/cases", {
      title: "State v. Ahmed",
      court: "Sindh High Court, Karachi",
      parties: [
        { side: "claimant", name: "Ahmed Khan", label: "Applicant" },
        { side: "respondent", name: "The State" },
      ],
      relevantLaws: ["s.497 CrPC", "s.324 PPC"],
      assignedLawyer: "A. Rahim",
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function newDraft(body: object = { templateId: "bail_application" }, token = alice.token) {
    const res = await as(token).post("/drafts", body);
    expect(res.status).toBe(201);
    return res.body;
  }

  const assist = (id: string, key = "grounds", body: object = {}, token = alice.token) =>
    as(token).post(`/drafts/${id}/sections/${key}/assist`, body);

  const save = (draft: Record<string, unknown>, changes: object = {}, token = alice.token) =>
    as(token).put(`/drafts/${draft.id as string}`, {
      version: draft.version,
      title: draft.title,
      caseId: draft.caseId,
      fields: draft.fields,
      sections: draft.sections,
      ...changes,
    });

  const setProviders = (enabled: string[]) =>
    pool.query("UPDATE app.providers SET enabled = (id = ANY($1::text[]))", [enabled]);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await setProviders(["ollama"]);
    store = new Map();
    draftCalls = [];
    templateCalls = 0;
    failDraft = undefined;
    failTemplates = false;
    counter = 0;
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
      ...documentDeps(),
    });
    alice = await register("alice@example.com");
    bob = await register("bob@example.com");
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await setProviders(["ollama"]);
    await pool.end();
  });

  describe("templates", () => {
    it("200 lists the templates, fetched from services/ai once (FR-DRAFT-1)", async () => {
      const res = await as(alice.token).get("/drafting/templates");
      expect(res.status).toBe(200);
      expectContract(res, "get", "/drafting/templates");
      expect(res.body.items.map((t: DraftTemplate) => t.id)).toEqual([
        "bail_application",
        "plaint",
        "legal_notice",
      ]);
      await as(alice.token).get("/drafting/templates");
      expect(templateCalls).toBe(1);
    });

    it("503 when services/ai is down, and the failure is not cached", async () => {
      failTemplates = true;
      const res = await as(alice.token).get("/drafting/templates");
      expect(res.status).toBe(503);
      expectContract(res, "get", "/drafting/templates");
      failTemplates = false;
      expect((await as(alice.token).get("/drafting/templates")).status).toBe(200);
    });

    it("401 without a token", async () => {
      const res = await request(app).get("/api/v1/drafting/templates");
      expect(res.status).toBe(401);
      expectContract(res, "get", "/drafting/templates");
    });
  });

  describe("create", () => {
    it("201 without a case: empty fields, empty sections, version 1 (FR-DRAFT-2)", async () => {
      const res = await as(alice.token).post("/drafts", { templateId: "bail_application" });
      expect(res.status).toBe(201);
      expectContract(res, "post", "/drafts");
      expect(res.body).toMatchObject({
        templateId: "bail_application",
        templateVersion: "1",
        title: "Bail application (s.497/498 CrPC)",
        caseId: null,
        version: 1,
        citations: [],
        fields: { court: null, parties: null, offences: null, fir_number: null, counsel: null },
      });
      expect(res.body.sections).toEqual([
        { key: "cause_title", body: "" },
        { key: "facts", body: "" },
        { key: "grounds", body: "" },
        { key: "prayer", body: "" },
      ]);
    });

    it("201 filled from the case: list fields one line per entry, parties by name (FR-DRAFT-2, FR-CASE-5)", async () => {
      const caseId = await newCase();
      const res = await as(alice.token).post("/drafts", { templateId: "bail_application", caseId });
      expect(res.status).toBe(201);
      expectContract(res, "post", "/drafts");
      expect(res.body.caseId).toBe(caseId);
      expect(res.body.title).toBe("Bail application (s.497/498 CrPC): State v. Ahmed");
      expect(res.body.fields).toEqual({
        court: "Sindh High Court, Karachi",
        parties: "Ahmed Khan (Applicant)\nThe State (Respondent)",
        offences: "s.497 CrPC\ns.324 PPC",
        fir_number: null,
        counsel: "A. Rahim",
      });
      const notice = await newDraft({ templateId: "legal_notice", caseId, title: "Notice" });
      expect(notice.title).toBe("Notice");
      expect(notice.fields).toEqual({ subject: "State v. Ahmed" });
    });

    it("400 on caseId for another user's case, an archived case or an unknown id", async () => {
      const archived = await newCase();
      await as(alice.token).post(`/cases/${archived}/archive`);
      for (const caseId of [
        await newCase(bob.token),
        archived,
        "44444444-4444-4444-8444-444444444444",
      ]) {
        const res = await as(alice.token).post("/drafts", { templateId: "plaint", caseId });
        expect(res.status).toBe(400);
        expectContract(res, "post", "/drafts");
        expect(res.body.errors[0].path).toBe("caseId");
      }
    });

    it("400 for an unknown template or field", async () => {
      for (const body of [{ templateId: "will" }, { templateId: "plaint", extra: 1 }]) {
        const res = await as(alice.token).post("/drafts", body);
        expect(res.status).toBe(400);
        expectContract(res, "post", "/drafts");
      }
    });
  });

  describe("list, get and delete", () => {
    it("lists own drafts newest first, by case, paged (FR-CASE-4)", async () => {
      const caseId = await newCase();
      const a = await newDraft({ templateId: "plaint" });
      const b = await newDraft({ templateId: "bail_application", caseId });
      await newDraft({ templateId: "plaint" }, bob.token);
      const res = await as(alice.token).get("/drafts");
      expect(res.status).toBe(200);
      expectContract(res, "get", "/drafts");
      expect(res.body.items.map((d: { id: string }) => d.id)).toEqual([b.id, a.id]);
      const byCase = await as(alice.token).get(`/drafts?caseId=${caseId}`);
      expect(byCase.body.items.map((d: { id: string }) => d.id)).toEqual([b.id]);
      const page = await as(alice.token).get("/drafts?limit=1");
      expect(page.body.items).toHaveLength(1);
      const next = await as(alice.token).get(`/drafts?limit=1&cursor=${page.body.nextCursor}`);
      expect(next.body.items.map((d: { id: string }) => d.id)).toEqual([a.id]);
      expect(next.body.nextCursor).toBeNull();
    });

    it("404 for another user's draft on every route (FR-AUTH-4)", async () => {
      const draft = await newDraft({ templateId: "plaint" }, bob.token);
      const res = await as(alice.token).get(`/drafts/${draft.id}`);
      expect(res.status).toBe(404);
      expectContract(res, "get", "/drafts/{draftId}");
      const put = await save(draft, {}, alice.token);
      expect(put.status).toBe(404);
      expectContract(put, "put", "/drafts/{draftId}");
      const del = await as(alice.token).delete(`/drafts/${draft.id}`);
      expect(del.status).toBe(404);
      expectContract(del, "delete", "/drafts/{draftId}");
      const help = await assist(draft.id, "demand", {}, alice.token);
      expect(help.status).toBe(404);
      expectContract(help, "post", "/drafts/{draftId}/sections/{sectionKey}/assist");
      const exp = await as(alice.token).get(`/drafts/${draft.id}/export?format=pdf`);
      expect(exp.status).toBe(404);
      expectContract(exp, "get", "/drafts/{draftId}/export");
      expect((await as(alice.token).get("/drafts/not-a-uuid")).status).toBe(404);
    });

    it("204 deletes a draft, then 404", async () => {
      const draft = await newDraft();
      const res = await as(alice.token).delete(`/drafts/${draft.id}`);
      expect(res.status).toBe(204);
      expectContract(res, "delete", "/drafts/{draftId}");
      expect((await as(alice.token).get(`/drafts/${draft.id}`)).status).toBe(404);
    });
  });

  describe("save", () => {
    it("200 saves and increments the version; a stale version is a 409 (FR-DRAFT-4)", async () => {
      const draft = await newDraft();
      const sections = draft.sections.map((s: { key: string }) =>
        s.key === "facts" ? { key: "facts", body: "The applicant was arrested." } : s,
      );
      const res = await save(draft, { title: "Bail for Ahmed", sections });
      expect(res.status).toBe(200);
      expectContract(res, "put", "/drafts/{draftId}");
      expect(res.body.version).toBe(2);
      expect(res.body.title).toBe("Bail for Ahmed");
      expect(res.body.sections[1]).toEqual({ key: "facts", body: "The applicant was arrested." });
      const stale = await save(draft, { title: "Lost update" });
      expect(stale.status).toBe(409);
      expectContract(stale, "put", "/drafts/{draftId}");
      expect((await as(alice.token).get(`/drafts/${draft.id}`)).body.title).toBe("Bail for Ahmed");
    });

    it("a missing section is saved empty and sections keep template order", async () => {
      const draft = await newDraft();
      const res = await save(draft, { sections: [{ key: "prayer", body: "Release on bail." }] });
      expect(res.status).toBe(200);
      expect(res.body.sections.map((s: { key: string }) => s.key)).toEqual([
        "cause_title",
        "facts",
        "grounds",
        "prayer",
      ]);
      expect(res.body.sections[3].body).toBe("Release on bail.");
      expect(res.body.sections[0].body).toBe("");
    });

    it("400 for an unknown field or section key", async () => {
      const draft = await newDraft();
      const field = await save(draft, { fields: { surprise: "x" } });
      expect(field.status).toBe(400);
      expectContract(field, "put", "/drafts/{draftId}");
      expect(field.body.errors[0].path).toBe("fields.surprise");
      const section = await save(draft, { sections: [{ key: "epilogue", body: "x" }] });
      expect(section.status).toBe(400);
      expect(section.body.errors[0].path).toBe("sections.0.key");
    });

    it("400 on the section's path for a citation marker assist didn't issue for this draft", async () => {
      const draft = await newDraft();
      const other = await newDraft();
      const issuedElsewhere = (await assist(other.id)).body.citations[0].id as string;
      const forged = "55555555-5555-4555-8555-555555555555";
      for (const id of [forged, issuedElsewhere]) {
        const res = await save(draft, {
          sections: [
            { key: "facts", body: "Facts." },
            { key: "grounds", body: `1. Bail [[c:${id}]].` },
          ],
        });
        expect(res.status).toBe(400);
        expectContract(res, "put", "/drafts/{draftId}");
        expect(res.body.errors[0].path).toBe("sections.1.body");
      }
    });

    it("moves the draft to another active case or detaches it; a foreign case is a 400", async () => {
      const draft = await newDraft();
      const caseId = await newCase();
      const moved = await save(draft, { caseId });
      expect(moved.status).toBe(200);
      expect(moved.body.caseId).toBe(caseId);
      expect(moved.body.fields.court).toBeNull(); // fields are not refilled
      const foreign = await save(moved.body, { caseId: await newCase(bob.token) });
      expect(foreign.status).toBe(400);
      expect(foreign.body.errors[0].path).toBe("caseId");
      const detached = await save(moved.body, { caseId: null });
      expect(detached.body.caseId).toBeNull();
    });
  });

  describe("assist", () => {
    it("200 returns the section with stored citations, records them and audits (FR-DRAFT-3, FR-TRUST-12)", async () => {
      const caseId = await newCase();
      const draft = await newDraft({ templateId: "bail_application", caseId });
      const res = await assist(draft.id, "grounds", { instruction: "First offender" });
      expect(res.status).toBe(200);
      expectContract(res, "post", "/drafts/{draftId}/sections/{sectionKey}/assist");
      const [c] = res.body.citations as Citation[];
      expect(res.body).toEqual({
        sectionKey: "grounds",
        text: `1. That bail is the rule [[c:${c!.id}]].`,
        citations: [store.get(c!.id)],
      });
      const [call] = draftCalls;
      expect(call).toMatchObject({
        templateId: "bail_application",
        sectionKey: "grounds",
        instruction: "First offender",
        fields: draft.fields,
        allowedProviders: ["ollama"],
        scope: { userId: alice.userId, allowedCaseIds: [caseId] },
      });
      expect(call!.credential).toBeUndefined();
      const links = await pool.query(
        "SELECT citation_id FROM app.draft_citations WHERE draft_id = $1",
        [draft.id],
      );
      expect(links.rows).toEqual([{ citation_id: c!.id }]);
      const audit = await pool.query("SELECT * FROM app.ai_audit_records");
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        request_id: call!.requestId,
        owner_user_id: alice.userId,
        draft_id: draft.id,
        case_id: caseId,
        conversation_id: null,
        outcome: "answered",
        question: "Draft section bail_application/grounds: First offender",
        allowed_providers: ["ollama"],
      });
      // Nothing is saved into the draft.
      expect((await as(alice.token).get(`/drafts/${draft.id}`)).body.version).toBe(1);
    });

    it("a draft without a case retrieves from the public corpus only (FR-CASE-6)", async () => {
      const draft = await newDraft();
      await assist(draft.id, "facts");
      expect(draftCalls[0]!.scope.allowedCaseIds).toEqual([]);
    });

    it("400 for a section that isn't in the template or isn't assistable", async () => {
      const draft = await newDraft();
      for (const key of ["cause_title", "epilogue"]) {
        const res = await assist(draft.id, key);
        expect(res.status).toBe(400);
        expectContract(res, "post", "/drafts/{draftId}/sections/{sectionKey}/assist");
        expect(res.body.errors[0].path).toBe("sectionKey");
      }
      expect(draftCalls).toEqual([]);
    });

    it("403 when AI features are disabled for the user (FR-AUTH-3)", async () => {
      const draft = await newDraft();
      await pool.query("UPDATE app.users SET ai_enabled = false WHERE id = $1", [alice.userId]);
      const res = await assist(draft.id);
      expect(res.status).toBe(403);
      expectContract(res, "post", "/drafts/{draftId}/sections/{sectionKey}/assist");
      expect(draftCalls).toEqual([]);
    });

    it("503 with no provider enabled, before calling services/ai, and audited (SEC-11)", async () => {
      const draft = await newDraft();
      await setProviders([]);
      const res = await assist(draft.id);
      expect(res.status).toBe(503);
      expectContract(res, "post", "/drafts/{draftId}/sections/{sectionKey}/assist");
      expect(draftCalls).toEqual([]);
      const audit = await pool.query("SELECT outcome, error FROM app.ai_audit_records");
      expect(audit.rows).toEqual([{ outcome: "error", error: "no provider enabled" }]);
    });

    it("503 when services/ai fails, audited as an error; an ai 400 stays a 400", async () => {
      const draft = await newDraft();
      failDraft = new AiHttpError("/ai/v1/drafting/sections", 503);
      const res = await assist(draft.id);
      expect(res.status).toBe(503);
      expectContract(res, "post", "/drafts/{draftId}/sections/{sectionKey}/assist");
      failDraft = new AiHttpError("/ai/v1/drafting/sections", 400);
      expect((await assist(draft.id)).status).toBe(400);
      const audit = await pool.query("SELECT outcome FROM app.ai_audit_records");
      expect(audit.rows).toEqual([{ outcome: "error" }, { outcome: "error" }]);
      expect((await pool.query("SELECT 1 FROM app.draft_citations")).rowCount).toBe(0);
    });

    it("400 for an instruction over 2000 characters", async () => {
      const draft = await newDraft();
      const res = await assist(draft.id, "grounds", { instruction: "x".repeat(2001) });
      expect(res.status).toBe(400);
      expectContract(res, "post", "/drafts/{draftId}/sections/{sectionKey}/assist");
    });
  });

  describe("citations in a saved draft", () => {
    async function draftWithCitation() {
      const draft = await newDraft();
      const help = (await assist(draft.id)).body;
      const saved = await save(draft, { sections: [{ key: "grounds", body: help.text }] });
      expect(saved.status).toBe(200);
      return { saved: saved.body, citationId: help.citations[0].id as string };
    }

    it("getDraft reads each status from the trust store, never a cached copy (FR-TRUST-10)", async () => {
      const { saved, citationId } = await draftWithCitation();
      expect(saved.citations.map((c: Citation) => c.verification.status)).toEqual(["verified"]);
      store.get(citationId)!.verification.status = "needs_review"; // re-verified in services/ai
      const res = await as(alice.token).get(`/drafts/${saved.id}`);
      expect(res.status).toBe(200);
      expectContract(res, "get", "/drafts/{draftId}");
      expect(res.body.citations).toEqual([store.get(citationId)]);
    });

    it("a removed marker drops the citation from the draft", async () => {
      const { saved } = await draftWithCitation();
      const res = await save(saved, { sections: [{ key: "grounds", body: "No citation now." }] });
      expect(res.body.citations).toEqual([]);
    });

    it("GET /citations/{id} serves a draft's citation to its owner only", async () => {
      const { citationId } = await draftWithCitation();
      const own = await as(alice.token).get(`/citations/${citationId}`);
      expect(own.status).toBe(200);
      expectContract(own, "get", "/citations/{citationId}");
      expect((await as(bob.token).get(`/citations/${citationId}`)).status).toBe(404);
    });

    it("503 when the trust store can't be read", async () => {
      const { saved } = await draftWithCitation();
      ai.getCitation = async () => {
        throw new Error("down");
      };
      try {
        const res = await as(alice.token).get(`/drafts/${saved.id}`);
        expect(res.status).toBe(503);
        expectContract(res, "get", "/drafts/{draftId}");
      } finally {
        ai.getCitation = async (id) => {
          const found = store.get(id);
          if (!found) throw new AiHttpError(`/ai/v1/citations/${id}`, 404);
          return structuredClone(found);
        };
      }
    });
  });

  describe("export (FR-DRAFT-4)", () => {
    it.each([
      ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK"],
      ["pdf", "application/pdf", "%PDF"],
    ])("200 %s as an attachment with nosniff", async (format, type, magic) => {
      const draft = await newDraft({ templateId: "bail_application", title: "Bail: Ahmed" });
      const help = (await assist(draft.id)).body;
      await save(draft, { sections: [{ key: "grounds", body: help.text }] });
      const res = await as(alice.token)
        .get(`/drafts/${draft.id}/export?format=${format}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expectContract(res, "get", "/drafts/{draftId}/export");
      expect(res.headers["content-type"]).toBe(type);
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain(`Bail-Ahmed.${format}`);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect((res.body as Buffer).subarray(0, magic.length).toString("latin1")).toBe(magic);
    });

    it("400 for an unknown format", async () => {
      const draft = await newDraft();
      const res = await as(alice.token).get(`/drafts/${draft.id}/export?format=odt`);
      expect(res.status).toBe(400);
      expectContract(res, "get", "/drafts/{draftId}/export");
    });
  });
});
