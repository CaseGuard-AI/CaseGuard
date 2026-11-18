import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AiClient } from "../src/clients/ai.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { createLogger } from "../src/lib/logger.js";
import { expectContract } from "./contract.js";
import { FILES, PDF } from "./files.js";
import { memoryStore, noIngestion, recordingQueue } from "./stubs.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

const PASSWORD = "correct horse battery";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";

const unused = async (): Promise<never> => {
  throw new Error("not used");
};
const ai: AiClient = {
  ...noIngestion,
  info: async () => ({ service: "caseguard-ai", version: "test" }),
  answer: unused,
  getCitation: unused,
  getSource: unused,
};

describe.skipIf(!url)("documents (api.v1 /cases/{caseId}/documents, /documents*)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let storage: ReturnType<typeof memoryStore>;
  let jobs: ReturnType<typeof recordingQueue>;
  let alice: string;
  let bob: string;
  let caseId: string;

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
      delete: (path: string) => auth(request(app).delete(`/api/v1${path}`)),
      upload: (
        path: string,
        file: Buffer = PDF,
        filename = "FIR 112-2026.pdf",
        contentType = "application/pdf",
      ) =>
        auth(request(app).post(`/api/v1${path}`)).attach("file", file, { filename, contentType }),
    };
  };

  async function newCase(token = alice) {
    const res = await as(token).post("/cases", { title: "A case" });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function upload(token = alice, id = caseId, file: Buffer = PDF, filename?: string) {
    const res = await as(token).upload(`/cases/${id}/documents`, file, filename);
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string; caseId: string };
  }

  const setStatus = (id: string, status: string, extra = "") =>
    pool.query(`UPDATE app.documents SET status = $2 ${extra} WHERE id = $1`, [id, status]);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    storage = memoryStore();
    jobs = recordingQueue();
    app = createApp({
      env: {
        CORS_ORIGIN: "http://localhost:3000",
        JWT_SECRET: "j".repeat(32),
        RESET_URL_BASE: "http://localhost:3000/reset-password",
        UPLOAD_MAX_MB: 1,
      },
      logger: createLogger("silent", false),
      db: pool,
      orm: createDb(pool),
      ai,
      mailer: { send: async () => {} },
      storage,
      jobs,
    });
    alice = await register("alice@example.com");
    bob = await register("bob@example.com");
    caseId = await newCase();
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  describe("upload (FR-DOC-1, SEC-6)", () => {
    it.each(Object.entries(FILES))("201 queued for %s, stored and enqueued", async (type, file) => {
      const res = await as(alice).upload(`/cases/${caseId}/documents`, file, "file.bin");
      expect(res.status).toBe(201);
      expectContract(res, "post", "/cases/{caseId}/documents");
      expect(res.body).toMatchObject({
        caseId,
        filename: "file.bin",
        mediaType: type,
        sizeBytes: file.length,
        status: "queued",
        flags: [],
        error: null,
        pages: null,
        processedAt: null,
      });
      const { rows } = await pool.query(
        "SELECT owner_user_id, storage_key, attempt FROM app.documents WHERE id = $1",
        [res.body.id],
      );
      const key = `users/${rows[0].owner_user_id}/cases/${caseId}/${res.body.id}`;
      expect(rows[0]).toMatchObject({ storage_key: key, attempt: 1 });
      expect(storage.blobs.get(key)?.equals(file)).toBe(true);
      expect(jobs.ingested).toEqual([
        {
          delaySeconds: 0,
          job: expect.objectContaining({
            documentId: res.body.id,
            caseId,
            storageKey: key,
            attempt: 1,
            firstAttempt: 1,
            submitted: false,
          }),
        },
      ]);
    });

    it("finds the type from the content, not the extension or the part's type", async () => {
      const res = await as(alice).upload(
        `/cases/${caseId}/documents`,
        FILES["image/png"],
        "scan.pdf",
        "application/pdf",
      );
      expect(res.status).toBe(201);
      expect(res.body.mediaType).toBe("image/png");
    });

    it("415 for a file of another type dressed as a PDF, and nothing is stored", async () => {
      const res = await as(alice).upload(
        `/cases/${caseId}/documents`,
        Buffer.from("MZ not really a pdf at all"),
        "evil.pdf",
      );
      expect(res.status).toBe(415);
      expectContract(res, "post", "/cases/{caseId}/documents");
      expect(storage.blobs.size).toBe(0);
      expect(jobs.ingested).toEqual([]);
    });

    it("413 above the size limit, and nothing is stored", async () => {
      const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]);
      const res = await as(alice).upload(`/cases/${caseId}/documents`, big);
      expect(res.status).toBe(413);
      expectContract(res, "post", "/cases/{caseId}/documents");
      expect(storage.blobs.size).toBe(0);
    });

    // Control characters are covered in documents-unit.test.ts: a client can't send them here.
    it("cleans the filename: no directory, at most 255 characters", async () => {
      const dir = await upload(alice, caseId, PDF, "C:\\Users\\x\\..\\FIR 1.pdf");
      expect((dir as unknown as { filename: string }).filename).toBe("FIR 1.pdf");
      const long = await upload(alice, caseId, PDF, `${"a".repeat(300)}.pdf`);
      expect((long as unknown as { filename: string }).filename).toHaveLength(255);
    });

    it("400 without a file part, with another part, or not multipart", async () => {
      const post = () =>
        request(app)
          .post(`/api/v1/cases/${caseId}/documents`)
          .set("Authorization", `Bearer ${alice}`);
      const noFile = await post().field("note", "hello");
      expect(noFile.status).toBe(400);
      expectContract(noFile, "post", "/cases/{caseId}/documents");

      const wrongName = await post().attach("upload", PDF, "a.pdf");
      expect(wrongName.status).toBe(400);

      const twoFiles = await post().attach("file", PDF, "a.pdf").attach("file", PDF, "b.pdf");
      expect(twoFiles.status).toBe(400);

      const extraField = await post().attach("file", PDF, "a.pdf").field("note", "hello");
      expect(extraField.status).toBe(400);

      const json = await as(alice).post(`/cases/${caseId}/documents`, { file: "x" });
      expect(json.status).toBe(400);

      const empty = await as(alice).upload(`/cases/${caseId}/documents`, Buffer.alloc(0), "a.pdf");
      expect(empty.status).toBe(400);
      expect(storage.blobs.size).toBe(0);
    });

    it("404 for another user's case or an unknown one (FR-AUTH-4)", async () => {
      for (const id of [caseId, UNKNOWN, "not-a-uuid"]) {
        const res = await as(bob).upload(`/cases/${id}/documents`);
        expect(res.status).toBe(404);
        expectContract(res, "post", "/cases/{caseId}/documents");
      }
      expect(storage.blobs.size).toBe(0);
    });

    it("400 on caseId for an archived case", async () => {
      await as(alice).post(`/cases/${caseId}/archive`);
      const res = await as(alice).upload(`/cases/${caseId}/documents`);
      expect(res.status).toBe(400);
      expectContract(res, "post", "/cases/{caseId}/documents");
      expect(res.body.errors).toEqual([{ path: "caseId", message: "That case is archived" }]);
    });

    it("401 without a token", async () => {
      const res = await request(app)
        .post(`/api/v1/cases/${caseId}/documents`)
        .attach("file", PDF, "a.pdf");
      expect(res.status).toBe(401);
    });
  });

  describe("list and get (FR-DOC-3)", () => {
    it("newest first, paged, filtered by case, only the caller's", async () => {
      const other = await newCase();
      const a = await upload();
      const b = await upload(alice, other);
      const c = await upload();
      await upload(bob, await newCase(bob));

      const all = await as(alice).get("/documents");
      expect(all.status).toBe(200);
      expectContract(all, "get", "/documents");
      expect(all.body.items.map((d: { id: string }) => d.id)).toEqual([c.id, b.id, a.id]);

      const first = await as(alice).get("/documents?limit=2");
      expect(first.body.items.map((d: { id: string }) => d.id)).toEqual([c.id, b.id]);
      const next = await as(alice).get(`/documents?limit=2&cursor=${first.body.nextCursor}`);
      expect(next.body.items.map((d: { id: string }) => d.id)).toEqual([a.id]);
      expect(next.body.nextCursor).toBeNull();

      const ofCase = await as(alice).get(`/documents?caseId=${caseId}`);
      expect(ofCase.body.items.map((d: { id: string }) => d.id)).toEqual([c.id, a.id]);
      const notMine = await as(bob).get(`/documents?caseId=${caseId}`);
      expect(notMine.body).toEqual({ items: [], nextCursor: null });
    });

    it("lists the documents of an archived case too", async () => {
      const doc = await upload();
      await as(alice).post(`/cases/${caseId}/archive`);
      const res = await as(alice).get(`/documents?caseId=${caseId}`);
      expect(res.body.items.map((d: { id: string }) => d.id)).toEqual([doc.id]);
    });

    it("400 for a bad caseId or cursor", async () => {
      expect((await as(alice).get("/documents?caseId=nope")).status).toBe(400);
      expect((await as(alice).get("/documents?cursor=nope")).status).toBe(400);
    });

    it("get: 200 for the owner, 404 for anyone else (FR-AUTH-4)", async () => {
      const doc = await upload();
      const res = await as(alice).get(`/documents/${doc.id}`);
      expect(res.status).toBe(200);
      expectContract(res, "get", "/documents/{documentId}");
      for (const [token, id] of [
        [bob, doc.id],
        [alice, UNKNOWN],
        [alice, "nope"],
      ] as const) {
        const miss = await as(token).get(`/documents/${id}`);
        expect(miss.status).toBe(404);
        expectContract(miss, "get", "/documents/{documentId}");
      }
    });

    it("shows a flagged document's flags, and an error only when failed", async () => {
      const doc = await upload();
      const flag = { stage: "ocr", code: "low_ocr_confidence", message: "Page 3", page: 3 };
      await setStatus(doc.id, "flagged", `, flags = '${JSON.stringify([flag])}', error = 'old'`);
      const flagged = await as(alice).get(`/documents/${doc.id}`);
      expectContract(flagged, "get", "/documents/{documentId}");
      expect(flagged.body).toMatchObject({ status: "flagged", flags: [flag], error: null });
      await setStatus(doc.id, "failed", ", flags = '[]', error = 'Could not read it.'");
      const failed = await as(alice).get(`/documents/${doc.id}`);
      expect(failed.body).toMatchObject({ status: "failed", error: "Could not read it." });
    });
  });

  describe("download", () => {
    it("streams the original with its type, filename and nosniff", async () => {
      const doc = await upload(alice, caseId, PDF, "Ürdu FIR 1.pdf");
      const res = await as(alice)
        .get(`/documents/${doc.id}/file`)
        .buffer(true)
        .parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => done(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expectContract(res, "get", "/documents/{documentId}/file");
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-length"]).toBe(String(PDF.length));
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-disposition"]).toBe(
        "attachment; filename=\"_rdu FIR 1.pdf\"; filename*=UTF-8''%C3%9Crdu%20FIR%201.pdf",
      );
      expect((res.body as Buffer).equals(PDF)).toBe(true);
    });

    it("404 for another user's document", async () => {
      const doc = await upload();
      const res = await as(bob).get(`/documents/${doc.id}/file`);
      expect(res.status).toBe(404);
      expectContract(res, "get", "/documents/{documentId}/file");
    });
  });

  describe("delete", () => {
    it("202, then gone from the API, with a purge queued", async () => {
      const doc = await upload();
      const res = await as(alice).delete(`/documents/${doc.id}`);
      expect(res.status).toBe(202);
      expectContract(res, "delete", "/documents/{documentId}");
      expect((await as(alice).get(`/documents/${doc.id}`)).status).toBe(404);
      expect((await as(alice).get(`/documents/${doc.id}/file`)).status).toBe(404);
      expect((await as(alice).get("/documents")).body.items).toEqual([]);
      expect(jobs.purged).toEqual([
        expect.objectContaining({ documentId: doc.id, caseId, storageKey: expect.any(String) }),
      ]);
      expect((await as(alice).delete(`/documents/${doc.id}`)).status).toBe(404);
    });

    it("works in any status and in an archived case; 404 for another user", async () => {
      const doc = await upload();
      await setStatus(doc.id, "processing");
      await as(alice).post(`/cases/${caseId}/archive`);
      expect((await as(bob).delete(`/documents/${doc.id}`)).status).toBe(404);
      expect((await as(alice).delete(`/documents/${doc.id}`)).status).toBe(202);
    });
  });

  describe("retry (NFR-13)", () => {
    it.each(["queued", "processing", "done"])("409 from %s", async (status) => {
      const doc = await upload();
      await setStatus(doc.id, status);
      const res = await as(alice).post(`/documents/${doc.id}/retry`);
      expect(res.status).toBe(409);
      expectContract(res, "post", "/documents/{documentId}/retry");
    });

    it("from failed: 202 queued, error cleared, next attempt enqueued", async () => {
      const doc = await upload();
      jobs.ingested.length = 0;
      await setStatus(doc.id, "failed", ", error = 'Could not read it.'");
      const res = await as(alice).post(`/documents/${doc.id}/retry`);
      expect(res.status).toBe(202);
      expectContract(res, "post", "/documents/{documentId}/retry");
      expect(res.body).toMatchObject({ status: "queued", error: null });
      expect(jobs.ingested.map((j) => j.job)).toEqual([
        expect.objectContaining({ documentId: doc.id, attempt: 2, firstAttempt: 2 }),
      ]);
      const { rows } = await pool.query("SELECT attempt, error FROM app.documents WHERE id = $1", [
        doc.id,
      ]);
      expect(rows[0]).toEqual({ attempt: 2, error: null });
      // Now queued: a second retry is a conflict.
      expect((await as(alice).post(`/documents/${doc.id}/retry`)).status).toBe(409);
    });

    it("from flagged: keeps the flags until the new attempt replaces them (FR-DOC-4)", async () => {
      const doc = await upload();
      const flag = { stage: "ocr", code: "low_ocr_confidence", message: "Page 3", page: 3 };
      await setStatus(doc.id, "flagged", `, flags = '${JSON.stringify([flag])}'`);
      const res = await as(alice).post(`/documents/${doc.id}/retry`);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: "queued", flags: [flag] });
    });

    it("404 for another user's document", async () => {
      const doc = await upload();
      await setStatus(doc.id, "failed");
      expect((await as(bob).post(`/documents/${doc.id}/retry`)).status).toBe(404);
    });
  });
});
