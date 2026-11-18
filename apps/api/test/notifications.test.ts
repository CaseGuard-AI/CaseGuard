import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AiClient } from "../src/clients/ai.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import type { NotificationKind } from "../src/db/schema.js";
import { createLogger } from "../src/lib/logger.js";
import { insertDocument, removeDocumentRow, setDocumentStatus } from "../src/documents/store.js";
import { createNotification } from "../src/notifications/store.js";
import { expectContract } from "./contract.js";
import { documentDeps, noIngestion } from "./stubs.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

const PASSWORD = "correct horse battery";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";

const unused = async () => {
  throw new Error("not used");
};
const ai: AiClient = {
  ...noIngestion,
  info: async () => ({ service: "caseguard-ai", version: "test" }),
  answer: unused,
  getCitation: unused,
  getSource: unused,
};

interface Who {
  token: string;
  userId: string;
  accountId: string;
  caseId: string;
}

describe.skipIf(!url)("notifications (api.v1 /notifications*)", () => {
  let pool: pg.Pool;
  let orm: Db;
  let app: ReturnType<typeof createApp>;
  let alice: Who;
  let bob: Who;

  const as = (who: Who) => {
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${who.token}`);
    return {
      get: (path: string) => auth(request(app).get(`/api/v1${path}`)),
      post: (path: string) => auth(request(app).post(`/api/v1${path}`)),
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
    const who = { token, userId: rows[0]!.id, accountId: rows[0]!.account_id, caseId: "" };
    const created = await as(who).post("/cases").send({ title: "State v. Ahmed" });
    return { ...who, caseId: created.body.id as string };
  }

  /** A document row of the user's case, as an upload leaves it (status `queued`, attempt 1). */
  async function newDocument(who: Who, filename = "FIR.pdf") {
    const id = randomUUID();
    return insertDocument(orm, who, {
      id,
      caseId: who.caseId,
      filename,
      mediaType: "application/pdf",
      sizeBytes: 5,
      storageKey: `users/${who.userId}/cases/${who.caseId}/${id}`,
    });
  }

  async function notify(who: Who, kind: NotificationKind = "document_done", filename = "FIR.pdf") {
    const doc = await newDocument(who, filename);
    return createNotification(orm, who, {
      kind,
      documentId: doc.id,
      caseId: who.caseId,
      filename,
    });
  }

  const kindsOf = async (who: Who) =>
    (await as(who).get("/notifications")).body.items.map((n: { kind: string }) => n.kind);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
    orm = createDb(pool);
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

  it("401 without a token", async () => {
    const res = await request(app).get("/api/v1/notifications");
    expect(res.status).toBe(401);
    expectContract(res, "get", "/notifications");
  });

  it("an empty list with no unread", async () => {
    const res = await as(alice).get("/notifications");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/notifications");
    expect(res.body).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
  });

  it("lists the caller's own notifications, newest first, every field present", async () => {
    await notify(alice, "document_done", "first.pdf");
    const flagged = await notify(alice, "document_flagged", "second.pdf");
    await notify(bob, "document_failed", "bobs.pdf");

    const res = await as(alice).get("/notifications");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/notifications");
    expect(res.body.unreadCount).toBe(2);
    expect(res.body.items.map((n: { filename: string }) => n.filename)).toEqual([
      "second.pdf",
      "first.pdf",
    ]);
    expect(res.body.items[0]).toEqual({
      id: flagged.id,
      kind: "document_flagged",
      documentId: flagged.documentId,
      caseId: alice.caseId,
      filename: "second.pdf",
      readAt: null,
      createdAt: flagged.createdAt.toISOString(),
    });
  });

  it("pages with a cursor; unreadCount is the whole total on every page", async () => {
    for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await notify(alice, "document_done", name);
    const first = await as(alice).get("/notifications?limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.unreadCount).toBe(3);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await as(alice).get(`/notifications?limit=2&cursor=${first.body.nextCursor}`);
    expectContract(second, "get", "/notifications");
    expect(second.body.items.map((n: { filename: string }) => n.filename)).toEqual(["a.pdf"]);
    expect(second.body.nextCursor).toBeNull();
    expect(second.body.unreadCount).toBe(3);
  });

  it("400 for an invalid cursor, limit or unread value", async () => {
    for (const query of ["cursor=nope", "limit=0", "limit=101", "unread=yes"]) {
      const res = await as(alice).get(`/notifications?${query}`);
      expect(res.status, query).toBe(400);
      expectContract(res, "get", "/notifications");
    }
  });

  it("unread=true lists only the unread", async () => {
    const read = await notify(alice, "document_done", "read.pdf");
    await notify(alice, "document_failed", "unread.pdf");
    await as(alice).post(`/notifications/${read.id}/read`);

    const res = await as(alice).get("/notifications?unread=true");
    expectContract(res, "get", "/notifications");
    expect(res.body.items.map((n: { filename: string }) => n.filename)).toEqual(["unread.pdf"]);
    expect(res.body.unreadCount).toBe(1);
  });

  describe("mark read", () => {
    it("204, sets readAt, and is idempotent (the first readAt kept)", async () => {
      const n = await notify(alice);
      const res = await as(alice).post(`/notifications/${n.id}/read`);
      expect(res.status).toBe(204);
      expectContract(res, "post", "/notifications/{notificationId}/read");

      const first = (await as(alice).get("/notifications")).body.items[0].readAt as string;
      expect(first).toEqual(expect.any(String));
      expect((await as(alice).post(`/notifications/${n.id}/read`)).status).toBe(204);
      const again = await as(alice).get("/notifications");
      expect(again.body.items[0].readAt).toBe(first);
      expect(again.body.unreadCount).toBe(0);
    });

    it("404 for another user's, an unknown or a malformed id (FR-AUTH-4)", async () => {
      const bobs = await notify(bob);
      for (const id of [bobs.id, UNKNOWN, "not-a-uuid"]) {
        const res = await as(alice).post(`/notifications/${id}/read`);
        expect(res.status, id).toBe(404);
        expectContract(res, "post", "/notifications/{notificationId}/read");
      }
      expect((await as(bob).get("/notifications")).body.unreadCount).toBe(1);
    });
  });

  it("read-all marks only the caller's", async () => {
    await notify(alice);
    await notify(alice, "document_failed");
    await notify(bob);

    const res = await as(alice).post("/notifications/read-all");
    expect(res.status).toBe(204);
    expectContract(res, "post", "/notifications/read-all");
    expect((await as(alice).get("/notifications")).body.unreadCount).toBe(0);
    expect((await as(bob).get("/notifications")).body.unreadCount).toBe(1);
  });

  describe("made by the document's status changes (setDocumentStatus)", () => {
    const move = (id: string, status: "queued" | "processing" | "done" | "flagged" | "failed") =>
      setDocumentStatus(orm, id, { status, ifAttempt: 1 });

    it("one per entry into done, flagged or failed, for the document's owner", async () => {
      for (const status of ["done", "flagged", "failed"] as const) {
        const doc = await newDocument(alice, `${status}.pdf`);
        await move(doc.id, "processing");
        await move(doc.id, status);
      }
      const res = await as(alice).get("/notifications");
      expectContract(res, "get", "/notifications");
      expect(res.body.items).toHaveLength(3);
      expect(
        res.body.items.map((n: { kind: string; filename: string }) => [n.kind, n.filename]),
      ).toEqual(
        expect.arrayContaining([
          ["document_done", "done.pdf"],
          ["document_flagged", "flagged.pdf"],
          ["document_failed", "failed.pdf"],
        ]),
      );
      expect(res.body.items[0]).toMatchObject({ caseId: alice.caseId, readAt: null });
      expect(await kindsOf(bob)).toEqual([]);
    });

    it("none for queued or processing, and none when a final status is written again", async () => {
      const doc = await newDocument(alice);
      await move(doc.id, "queued");
      await move(doc.id, "processing");
      await move(doc.id, "processing");
      expect(await kindsOf(alice)).toEqual([]);

      await move(doc.id, "done");
      await move(doc.id, "done");
      expect(await kindsOf(alice)).toEqual(["document_done"]);
    });

    it("a retry that finishes again notifies again", async () => {
      const doc = await newDocument(alice);
      await move(doc.id, "flagged");
      await setDocumentStatus(orm, doc.id, { status: "queued", ifAttempt: 1, attempt: 2 });
      await setDocumentStatus(orm, doc.id, { status: "done", ifAttempt: 2 });
      expect(await kindsOf(alice)).toEqual(["document_done", "document_flagged"]);
    });

    it("a purged document leaves documentId null; the filename stays", async () => {
      const doc = await newDocument(alice, "gone.pdf");
      await move(doc.id, "failed");
      await removeDocumentRow(orm, doc.id);
      const res = await as(alice).get("/notifications");
      expectContract(res, "get", "/notifications");
      expect(res.body.items[0]).toMatchObject({
        kind: "document_failed",
        documentId: null,
        filename: "gone.pdf",
      });
    });
  });
});
