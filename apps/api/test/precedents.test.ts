import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  AiHttpError,
  type AiClient,
  type PrecedentHit,
  type PrecedentSearchRequest,
  type PrecedentSearchResult,
  type RelationshipList,
} from "../src/clients/ai.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { expectContract } from "./contract.js";
import { documentDeps, noIngestion } from "./stubs.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL). The AI
// service is a fake following ai.v1 searchPrecedents / getPrecedentRelationships (#210).
const url = process.env.APP_TEST_DATABASE_URL;

const PASSWORD = "correct horse battery";
const J1 = "11111111-1111-4111-8111-111111111111";
const J2 = "22222222-2222-4222-8222-222222222222";
const EDGE = "33333333-3333-4333-8333-333333333333";
const UNKNOWN = "44444444-4444-4444-8444-444444444444";

const retrieved: PrecedentHit = {
  sourceId: J1,
  title: "Zephyr (Applicant) VS The State",
  citation: "2020 SCMR 100",
  court: "Sindh High Court",
  decidedOn: "2020-03-01",
  origin: "retrieved",
  via: null,
  flags: [],
  locator: "para 4",
  snippet: "Bail under section 497 Cr.P.C. is granted where the case calls for further inquiry.",
  score: 1,
};

const derived: PrecedentHit = {
  sourceId: J2,
  title: "Older (Appellant) VS The State",
  citation: "PLD 2019 SC 50",
  court: "Supreme Court of Pakistan",
  decidedOn: "2019-01-10",
  origin: "graph_derived",
  via: { edgeId: EDGE, type: "CITES_JUDGMENT", relatedSourceId: J1, sectionLabel: null },
  flags: ["overruled"],
  locator: null,
  snippet: null,
  score: 0.5,
};

const relationships: RelationshipList = {
  sourceId: J1,
  items: [
    {
      id: EDGE,
      type: "CITES_JUDGMENT",
      direction: "outgoing",
      other: { entityType: "judgment", sourceId: J2, label: "PLD 2019 SC 50" },
      provenance: {
        documentId: J1,
        extractionMethod: "regex",
        confidence: 0.7,
        humanConfirmed: false,
      },
      verificationStatus: "unverified",
      validFrom: "2020-03-01",
      validTo: null,
      recordedAt: "2026-11-21T10:00:00.000Z",
    },
  ],
};

const down = async (): Promise<never> => {
  throw new TypeError("fetch failed");
};

describe.skipIf(!url)("precedents (api.v1 /precedents*)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let calls: PrecedentSearchRequest[];
  let onSearch: (req: PrecedentSearchRequest) => Promise<unknown>;
  let onRelationships: (id: string) => Promise<unknown>;
  let alice: { token: string; userId: string };

  const ai: AiClient = {
    ...noIngestion,
    info: async () => ({ service: "caseguard-ai", version: "test" }),
    answer: down,
    getCitation: down,
    getSource: down,
    searchPrecedents: async (req) => {
      calls.push(req);
      return (await onSearch(req)) as PrecedentSearchResult;
    },
    getPrecedentRelationships: async (id) => (await onRelationships(id)) as RelationshipList,
  };

  const result = (req: PrecedentSearchRequest, hits = [retrieved, derived]) => ({
    requestId: req.requestId,
    hits,
    graphAvailable: true,
  });

  async function register(email: string) {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: PASSWORD, name: email.split("@")[0] });
    return { token: res.body.accessToken as string, userId: res.body.user.id as string };
  }

  const search = (body: object, token: string | null = alice.token) => {
    const req = request(app).post("/api/v1/precedents/search").send(body);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };
  const rels = (id: string, token: string | null = alice.token) => {
    const req = request(app).get(`/api/v1/precedents/${id}/relationships`);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };
  const SEARCH = ["post", "/precedents/search"] as const;
  const RELS = ["get", "/precedents/{sourceId}/relationships"] as const;

  const audits = async () =>
    (await pool.query("SELECT * FROM app.ai_audit_records ORDER BY created_at")).rows;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    calls = [];
    onSearch = async (req) => result(req);
    onRelationships = async () => relationships;
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
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  describe("search (FR-PREC-1, FR-PREC-3)", () => {
    it("200 with retrieved and graph-derived hits, labelled", async () => {
      const res = await search({ query: "bail further inquiry" });
      expect(res.status).toBe(200);
      expectContract(res, ...SEARCH);
      expect(res.body.hits.map((h: PrecedentHit) => h.origin)).toEqual([
        "retrieved",
        "graph_derived",
      ]);
      expect(res.body.hits[1].via).toEqual(derived.via);
      expect(res.body.hits[1].flags).toEqual(["overruled"]);
      expect(res.body.graphAvailable).toBe(true);
    });

    it("sends a fresh requestId, the filters and the defaults to services/ai", async () => {
      const filters = { court: "Sindh High Court", sectionRef: "s.497 CrPC" };
      const res = await search({ query: "  bail  ", filters });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      const [sent] = calls;
      expect(sent).toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        query: "bail",
        filters,
        includeGraphDerived: true,
        limit: 20,
      });
      expect(res.body.requestId).toBe(sent!.requestId);
      await search({ query: "bail", includeGraphDerived: false, limit: 5 });
      expect(calls[1]).toMatchObject({ includeGraphDerived: false, limit: 5 });
      expect(calls[1]!.requestId).not.toBe(sent!.requestId);
    });

    it("writes an audit record with the query and the hits' graph context (FR-TRUST-12)", async () => {
      const res = await search({
        query: "bail further inquiry",
        filters: { court: "Sindh High Court" },
      });
      const [row] = await audits();
      expect(row).toMatchObject({
        request_id: res.body.requestId,
        owner_user_id: alice.userId,
        conversation_id: null,
        case_id: null,
        question: "bail further inquiry",
        outcome: "answered",
        allowed_providers: [],
        error: null,
      });
      expect(row.latency_ms).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(row.response_text)).toEqual({
        kind: "precedent_search",
        filters: { court: "Sindh High Court" },
        includeGraphDerived: true,
        limit: 20,
        graphAvailable: true,
        hits: [
          { sourceId: J1, origin: "retrieved" },
          { sourceId: J2, origin: "graph_derived", via: derived.via, flags: ["overruled"] },
        ],
      });
    });

    it("an empty result is audited as unanswerable", async () => {
      onSearch = async (req) => ({ requestId: req.requestId, hits: [], graphAvailable: false });
      const res = await search({ query: "nothing matches" });
      expect(res.status).toBe(200);
      expectContract(res, ...SEARCH);
      expect(res.body).toMatchObject({ hits: [], graphAvailable: false });
      expect((await audits())[0]).toMatchObject({ outcome: "unanswerable" });
    });

    it("works with AI features turned off: no model is called", async () => {
      await pool.query("UPDATE app.users SET ai_enabled = false WHERE id = $1", [alice.userId]);
      const res = await search({ query: "bail" });
      expect(res.status).toBe(200);
    });

    it.each([
      [{}],
      [{ query: "" }],
      [{ query: "x".repeat(1001) }],
      [{ query: "bail", limit: 0 }],
      [{ query: "bail", limit: 51 }],
      [{ query: "bail", filters: { court: "x".repeat(121) } }],
      [{ query: "bail", filters: { decidedFrom: "2024-13-01" } }],
      [{ query: "bail", filters: { decidedFrom: "2024-02-02", decidedTo: "2024-02-01" } }],
      [{ query: "bail", filters: { judge: "x" } }],
      [{ query: "bail", scope: {} }],
    ])("400 for an invalid body %j", async (body) => {
      const res = await search(body);
      expect(res.status).toBe(400);
      expectContract(res, ...SEARCH);
      expect(calls).toHaveLength(0);
    });

    it("401 without a session", async () => {
      const res = await search({ query: "bail" }, null);
      expect(res.status).toBe(401);
      expectContract(res, ...SEARCH);
    });

    it("503 when services/ai fails, and the failure is audited", async () => {
      onSearch = async () => {
        throw new AiHttpError("/ai/v1/precedents/search", 503);
      };
      const res = await search({ query: "bail" });
      expect(res.status).toBe(503);
      expectContract(res, ...SEARCH);
      expect((await audits())[0]).toMatchObject({ outcome: "error", question: "bail" });
      expect((await audits())[0].error).toContain("503");
    });

    it.each([
      ["unreachable", down],
      ["a malformed result", async () => ({ hits: "nope" })],
      [
        "a result for another request",
        async () => ({ ...result({ requestId: UNKNOWN } as never) }),
      ],
      [
        "a hit with an unknown origin",
        async (req: PrecedentSearchRequest) =>
          result(req, [{ ...retrieved, origin: "guessed" } as never]),
      ],
    ])("503 when services/ai gives %s", async (_name, respond) => {
      onSearch = respond as typeof onSearch;
      const res = await search({ query: "bail" });
      expect(res.status).toBe(503);
      expectContract(res, ...SEARCH);
    });

    it("429 with Retry-After after 30 searches in 15 minutes (SEC-15)", async () => {
      for (let i = 0; i < 30; i++) expect((await search({ query: "bail" })).status).toBe(200);
      const res = await search({ query: "bail" });
      expect(res.status).toBe(429);
      expectContract(res, ...SEARCH);
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("relationships (FR-PREC-2, FR-PREC-4)", () => {
    it("200 with each edge's provenance and status", async () => {
      let asked = "";
      onRelationships = async (id) => {
        asked = id;
        return relationships;
      };
      const res = await rels(J1);
      expect(res.status).toBe(200);
      expectContract(res, ...RELS);
      expect(asked).toBe(J1);
      expect(res.body.items[0].provenance).toEqual(relationships.items[0]!.provenance);
      expect(res.body.items[0].verificationStatus).toBe("unverified");
    });

    it("404 when services/ai says it is not a judgment, or the id is not a uuid", async () => {
      onRelationships = async () => {
        throw new AiHttpError("/ai/v1/precedents/x/relationships", 404);
      };
      const res = await rels(UNKNOWN);
      expect(res.status).toBe(404);
      expectContract(res, ...RELS);
      expect((await rels("not-a-uuid")).status).toBe(404);
    });

    it("503 when services/ai is down or answers badly", async () => {
      onRelationships = down;
      const res = await rels(J1);
      expect(res.status).toBe(503);
      expectContract(res, ...RELS);
      onRelationships = async () => ({ sourceId: J1, items: [{ id: EDGE }] });
      expect((await rels(J1)).status).toBe(503);
    });

    it("401 without a session", async () => {
      const res = await rels(J1, null);
      expect(res.status).toBe(401);
      expectContract(res, ...RELS);
    });
  });
});
