import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AiClient } from "../src/clients/ai.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { expectContract } from "./contract.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

const PASSWORD = "correct horse battery";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";

const FULL = {
  title: "State v. Ahmed",
  court: "Sindh High Court, Karachi",
  caseNumber: "Cr. Bail No. 1234 of 2026",
  caseType: "Cr. Bail",
  filedOn: "2026-03-02",
  status: "Reserved for judgment",
  nextHearingOn: "2026-12-01",
  parties: [
    { side: "claimant", name: "The State", label: "Complainant" },
    { side: "respondent", name: "Ali Ahmed", label: "Accused" },
  ],
  judge: "Justice A. B. Khan",
  assignedLawyer: "Ayesha Khan",
  relevantLaws: ["s.497 CrPC", "s.9(c) CNSA 1997"],
  summary: "Post-arrest bail in a narcotics case.",
};

const unused = async () => {
  throw new Error("not used");
};
const ai: AiClient = {
  info: async () => ({ service: "caseguard-ai", version: "test" }),
  answer: unused,
  getCitation: unused,
  getSource: unused,
};

describe.skipIf(!url)("cases (api.v1 /cases*)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let alice: string;
  let bob: string;

  async function register(email: string) {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: PASSWORD, name: email.split("@")[0] });
    return res.body.accessToken as string;
  }

  const as = (token: string) => {
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
    return {
      get: (path: string) => auth(request(app).get(`/api/v1${path}`)),
      post: (path: string, body?: object) =>
        auth(request(app).post(`/api/v1${path}`)).send(body ?? {}),
      patch: (path: string, body: object) => auth(request(app).patch(`/api/v1${path}`)).send(body),
    };
  };

  async function newCase(token = alice, body: object = { title: "A case" }) {
    const res = await as(token).post("/cases", body);
    expect(res.status).toBe(201);
    return res.body as { id: string; updatedAt: string; archivedAt: string | null };
  }

  const titles = async (query = "") =>
    (await as(alice).get(`/cases${query}`)).body.items.map((c: { title: string }) => c.title);

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
      ai,
      mailer: { send: async () => {} },
    });
    alice = await register("alice@example.com");
    bob = await register("bob@example.com");
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  describe("create", () => {
    it("201 with every Table 4.29 field, returned as sent (FR-CASE-1)", async () => {
      const res = await as(alice).post("/cases", FULL);
      expect(res.status).toBe(201);
      expectContract(res, "post", "/cases");
      expect(res.body).toMatchObject({ ...FULL, archivedAt: null });
    });

    it("201 with only a title: the rest empty, every field present", async () => {
      const res = await as(alice).post("/cases", { title: "  Bail matter  " });
      expect(res.status).toBe(201);
      expectContract(res, "post", "/cases");
      expect(res.body).toMatchObject({
        title: "Bail matter",
        court: null,
        filedOn: null,
        parties: [],
        relevantLaws: [],
        summary: null,
        archivedAt: null,
      });
    });

    it("stores a blank text field as null", async () => {
      const res = await as(alice).post("/cases", { title: "T", court: "   " });
      expect(res.body.court).toBeNull();
    });

    it.each([
      ["no title", {}],
      ["an empty title", { title: " " }],
      ["an unknown field", { title: "T", ownerUserId: UNKNOWN }],
      ["a bad date", { title: "T", filedOn: "02/03/2026" }],
      ["a bad party side", { title: "T", parties: [{ side: "judge", name: "X" }] }],
      ["51 parties", { title: "T", parties: Array(51).fill({ side: "claimant", name: "X" }) }],
      ["an empty law", { title: "T", relevantLaws: [""] }],
      ["a summary over 4000 characters", { title: "T", summary: "x".repeat(4001) }],
    ])("400 for %s", async (_why, body) => {
      const res = await as(alice).post("/cases", body);
      expect(res.status).toBe(400);
      expectContract(res, "post", "/cases");
    });

    it("401 without a token", async () => {
      const res = await request(app).post("/api/v1/cases").send({ title: "T" });
      expect(res.status).toBe(401);
      expectContract(res, "post", "/cases");
    });
  });

  describe("read and list", () => {
    it("reads the user's own case; another user's or an unknown id is 404 (FR-AUTH-4)", async () => {
      const { id } = await newCase(alice, FULL);
      const own = await as(alice).get(`/cases/${id}`);
      expect(own.status).toBe(200);
      expectContract(own, "get", "/cases/{caseId}");
      expect(own.body).toMatchObject(FULL);

      for (const [token, path] of [
        [bob, id],
        [alice, UNKNOWN],
        [alice, "not-a-uuid"],
      ] as const) {
        const res = await as(token).get(`/cases/${path}`);
        expect(res.status).toBe(404);
        expectContract(res, "get", "/cases/{caseId}");
      }
    });

    it("lists only the user's own cases, most recently updated first, page by page", async () => {
      const first = await newCase(alice, { title: "first" });
      await newCase(alice, { title: "second" });
      await newCase(alice, { title: "third" });
      await newCase(bob, { title: "bob's" });
      await as(alice).patch(`/cases/${first.id}`, { status: "Adjourned" }); // moves it up

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await as(alice).get(`/cases?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.status).toBe(200);
        expectContract(res, "get", "/cases");
        seen.push(...res.body.items.map((c: { title: string }) => c.title));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(["first", "third", "second"]);
    });

    it("400 for a bad state or cursor", async () => {
      for (const query of ["?state=deleted", "?cursor=bm9wZQ"]) {
        const res = await as(alice).get(`/cases${query}`);
        expect(res.status).toBe(400);
        expectContract(res, "get", "/cases");
      }
    });
  });

  describe("update", () => {
    it("is partial; null and [] clear; updatedAt moves", async () => {
      const created = await newCase(alice, FULL);
      const res = await as(alice).patch(`/cases/${created.id}`, {
        status: "Bail granted",
        judge: null,
        parties: [],
      });
      expect(res.status).toBe(200);
      expectContract(res, "patch", "/cases/{caseId}");
      expect(res.body).toMatchObject({
        ...FULL,
        status: "Bail granted",
        judge: null,
        parties: [],
      });
      expect(Date.parse(res.body.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    });

    it.each([
      ["an empty body", {}],
      ["a null title", { title: null }],
      ["an unknown field", { archivedAt: null }],
    ])("400 for %s", async (_why, body) => {
      const { id } = await newCase();
      const res = await as(alice).patch(`/cases/${id}`, body);
      expect(res.status).toBe(400);
      expectContract(res, "patch", "/cases/{caseId}");
    });

    it("404 for another user's case, which is left unchanged", async () => {
      const { id } = await newCase(alice, FULL);
      const res = await as(bob).patch(`/cases/${id}`, { title: "Mine now" });
      expect(res.status).toBe(404);
      expectContract(res, "patch", "/cases/{caseId}");
      expect((await as(alice).get(`/cases/${id}`)).body.title).toBe(FULL.title);
    });
  });

  describe("archive", () => {
    it("archive and unarchive are idempotent, and the list hides archived cases unless asked", async () => {
      const { id } = await newCase(alice, { title: "old" });
      await newCase(alice, { title: "current" });

      const archived = await as(alice).post(`/cases/${id}/archive`);
      expect(archived.status).toBe(200);
      expectContract(archived, "post", "/cases/{caseId}/archive");
      expect(archived.body.archivedAt).not.toBeNull();
      const again = await as(alice).post(`/cases/${id}/archive`);
      expect(again.body.archivedAt).toBe(archived.body.archivedAt);

      expect(await titles()).toEqual(["current"]);
      expect(await titles("?state=archived")).toEqual(["old"]);
      expect((await titles("?state=all")).sort()).toEqual(["current", "old"]);
      // Still the user's: readable and editable while archived.
      expect((await as(alice).get(`/cases/${id}`)).status).toBe(200);
      expect((await as(alice).patch(`/cases/${id}`, { summary: "Closed" })).status).toBe(200);

      const restored = await as(alice).post(`/cases/${id}/unarchive`);
      expect(restored.status).toBe(200);
      expectContract(restored, "post", "/cases/{caseId}/unarchive");
      expect(restored.body.archivedAt).toBeNull();
      expect((await as(alice).post(`/cases/${id}/unarchive`)).body.archivedAt).toBeNull();
      expect((await titles()).sort()).toEqual(["current", "old"]);
    });

    it("404 for another user's case", async () => {
      const { id } = await newCase();
      for (const action of ["archive", "unarchive"]) {
        const res = await as(bob).post(`/cases/${id}/${action}`);
        expect(res.status).toBe(404);
        expectContract(res, "post", `/cases/{caseId}/${action}`);
      }
      expect((await as(alice).get(`/cases/${id}`)).body.archivedAt).toBeNull();
    });
  });
});
