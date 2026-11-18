import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AiHttpError, type AiClient, type Citation, type Source } from "../src/clients/ai.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { expectContract } from "./contract.js";
import { documentDeps, noIngestion } from "./stubs.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
// services/ai serves these ai.v1 endpoints with #15/#20; here the AI is a fake following ai.v1.
const url = process.env.APP_TEST_DATABASE_URL;

const PASSWORD = "correct horse battery";
const CITATION_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_ID = "33333333-3333-4333-8333-333333333333";

const citation = (status: Citation["verification"]["status"]): Citation => ({
  id: CITATION_ID,
  sourceId: SOURCE_ID,
  claim: "Bail is governed by s. 497 CrPC",
  locator: "s. 497",
  verification: { status, flags: [], lastVerifiedAt: "2026-10-01T00:00:00.000Z" },
});

const source: Source = {
  id: SOURCE_ID,
  kind: "statute",
  title: "Code of Criminal Procedure, 1898",
  officialUrl: "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2FtbJk%3D",
  language: "en",
};

const down = async (): Promise<never> => {
  throw new TypeError("fetch failed");
};

describe.skipIf(!url)("citations and sources (api.v1)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let aliceToken: string;
  let bobToken: string;
  let citationCalls: string[];
  let onCitation: (id: string) => Promise<unknown>;
  let onSource: (id: string) => Promise<unknown>;

  const ai: AiClient = {
    ...noIngestion,
    info: async () => ({ service: "caseguard-ai", version: "test" }),
    // The answer stored with Alice's message: the citation was "verified" at the time.
    answer: async (req) => ({
      requestId: req.requestId,
      answerable: true,
      language: "en",
      text: `Bail is governed by s. 497 CrPC [[c:${CITATION_ID}]].`,
      citations: [citation("verified")],
    }),
    getCitation: async (id) => {
      citationCalls.push(id);
      return (await onCitation(id)) as Citation;
    },
    getSource: async (id) => (await onSource(id)) as Source,
  };

  const get = (path: string, token?: string) => {
    const req = request(app).get(`/api/v1${path}`);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  async function register(email: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: PASSWORD, name: email.split("@")[0] });
    return res.body.accessToken;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    citationCalls = [];
    // Since the answer, re-verification found a problem: the current status differs.
    onCitation = async (id) => {
      if (id !== CITATION_ID) throw new AiHttpError(`/ai/v1/citations/${id}`, 404);
      return {
        ...citation("needs_review"),
        verification: { ...citation("needs_review").verification, flags: ["amended_since"] },
      };
    };
    onSource = async (id) => {
      if (id !== SOURCE_ID) throw new AiHttpError(`/ai/v1/sources/${id}`, 404);
      return source;
    };
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
    aliceToken = await register("alice@example.com");
    bobToken = await register("bob@example.com");
    // Alice asks a question, so the citation is in her answer.
    const conv = await request(app)
      .post("/api/v1/conversations")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({});
    const asked = await request(app)
      .post(`/api/v1/conversations/${conv.body.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ question: "What governs bail?" });
    expect(asked.status).toBe(201);
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  describe("GET /citations/{citationId}", () => {
    it("200 for the owner, with the current verification rather than the stored copy (FR-TRUST-5)", async () => {
      const res = await get(`/citations/${CITATION_ID}`, aliceToken);
      expect(res.status).toBe(200);
      expectContract(res, "get", "/citations/{citationId}");
      expect(res.body.verification).toMatchObject({
        status: "needs_review",
        flags: ["amended_since"],
      });
    });

    it("404 for another user's citation, without asking the AI service (FR-AUTH-4)", async () => {
      const res = await get(`/citations/${CITATION_ID}`, bobToken);
      expect(res.status).toBe(404);
      expectContract(res, "get", "/citations/{citationId}");
      expect(citationCalls).toEqual([]);
    });

    it("404 for an unknown or malformed id", async () => {
      expect((await get(`/citations/${UNKNOWN_ID}`, aliceToken)).status).toBe(404);
      expect((await get("/citations/not-a-uuid", aliceToken)).status).toBe(404);
      expect(citationCalls).toEqual([]);
    });

    it("404 when the AI service no longer has it", async () => {
      onCitation = async (id) => {
        throw new AiHttpError(`/ai/v1/citations/${id}`, 404);
      };
      const res = await get(`/citations/${CITATION_ID}`, aliceToken);
      expect(res.status).toBe(404);
      expectContract(res, "get", "/citations/{citationId}");
    });

    it("503 when the AI service is down or answers with no verification", async () => {
      onCitation = down;
      const outage = await get(`/citations/${CITATION_ID}`, aliceToken);
      expect(outage.status).toBe(503);
      expectContract(outage, "get", "/citations/{citationId}");

      onCitation = async () => ({ id: CITATION_ID, sourceId: SOURCE_ID, claim: "x" });
      const malformed = await get(`/citations/${CITATION_ID}`, aliceToken);
      expect(malformed.status).toBe(503);
      expectContract(malformed, "get", "/citations/{citationId}");
    });

    it("401 without a token", async () => {
      const res = await get(`/citations/${CITATION_ID}`);
      expect(res.status).toBe(401);
      expectContract(res, "get", "/citations/{citationId}");
    });
  });

  describe("GET /sources/{sourceId}", () => {
    it("200 with the official URL for any signed-in user (FR-RES-7)", async () => {
      const res = await get(`/sources/${SOURCE_ID}`, bobToken);
      expect(res.status).toBe(200);
      expectContract(res, "get", "/sources/{sourceId}");
      expect(res.body.officialUrl).toBe(source.officialUrl);
    });

    it("404 for an unknown or malformed id", async () => {
      const unknown = await get(`/sources/${UNKNOWN_ID}`, aliceToken);
      expect(unknown.status).toBe(404);
      expectContract(unknown, "get", "/sources/{sourceId}");
      expect((await get("/sources/not-a-uuid", aliceToken)).status).toBe(404);
    });

    it("503 when the AI service is down or the record lacks its official URL", async () => {
      onSource = down;
      const outage = await get(`/sources/${SOURCE_ID}`, aliceToken);
      expect(outage.status).toBe(503);
      expectContract(outage, "get", "/sources/{sourceId}");

      onSource = async () => ({ ...source, officialUrl: undefined });
      expect((await get(`/sources/${SOURCE_ID}`, aliceToken)).status).toBe(503);
    });

    it("401 without a token", async () => {
      const res = await get(`/sources/${SOURCE_ID}`);
      expect(res.status).toBe(401);
      expectContract(res, "get", "/sources/{sourceId}");
    });
  });
});
