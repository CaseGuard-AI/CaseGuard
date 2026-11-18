import type { PgBoss } from "pg-boss";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiClient } from "../src/clients/ai.js";
import { createDb } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import { pgBossQueue, startBoss } from "../src/jobs/queue.js";
import { startWorkers } from "../src/jobs/workers.js";
import { createLogger } from "../src/lib/logger.js";
import { memoryStore, noIngestion } from "./stubs.js";

// Real pg-boss on the `pgboss` schema that bootstrap.sql creates (caseguard_app may not CREATE
// SCHEMA, ADR-0007). CI sets APP_TEST_DATABASE_URL.
const url = process.env.APP_TEST_DATABASE_URL;

describe.skipIf(!url)("job queue (pg-boss)", () => {
  let pool: pg.Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await migrateUp(pool);
    boss = await startBoss(url!, createLogger("silent", false));
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await pool.end();
  });

  it("starts without creating its schema, and runs an enqueued purge", async () => {
    const purged: string[] = [];
    const ai = {
      ...noIngestion,
      purgeDocument: async (id: string) => void purged.push(id),
    } as unknown as AiClient;
    const storage = memoryStore();
    const key = "users/a/cases/b/c";
    await storage.put(key, Buffer.from("x"));
    await startWorkers(boss, {
      db: createDb(pool),
      ai,
      queue: pgBossQueue(boss),
      storage,
      logger: createLogger("silent", false),
      maxAttempts: 3,
    });
    const documentId = "44444444-4444-4444-8444-444444444444";
    await pgBossQueue(boss).purge({ documentId, userId: "a", caseId: "b", storageKey: key });
    await vi.waitFor(() => expect(purged).toContain(documentId), {
      timeout: 20_000,
      interval: 250,
    });
    await vi.waitFor(() => expect(storage.blobs.has(key)).toBe(false), { timeout: 5_000 });
  }, 30_000);
});
