import pg from "pg";
import { createApp } from "./app.js";
import { createAiClient } from "./clients/ai.js";
import { parseEnv } from "./config/env.js";
import { createDb } from "./db/client.js";
import { pgBossQueue, startBoss } from "./jobs/queue.js";
import { startWorkers } from "./jobs/workers.js";
import { createLogger } from "./lib/logger.js";
import { createMailer } from "./lib/mailer.js";
import { createFsBlobStore } from "./storage/blob-store.js";

const env = parseEnv();
const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
const db = new pg.Pool({ connectionString: env.API_DATABASE_URL, max: 10 });
const orm = createDb(db);
const ai = createAiClient(env.AI_SERVICE_URL, env.AI_SERVICE_TOKEN);
const mailer = createMailer(env, logger);
const storage = createFsBlobStore(env.UPLOADS_DIR);

// The queue starts before the server, so an upload can always enqueue its job.
const boss = await startBoss(env.API_DATABASE_URL, logger);
const jobs = pgBossQueue(boss);
if (env.WORKERS_ENABLED) {
  await startWorkers(boss, {
    db: orm,
    ai,
    queue: jobs,
    storage,
    logger,
    maxAttempts: env.DOCUMENT_MAX_ATTEMPTS,
  });
}

const server = createApp({ env, logger, db, orm, ai, mailer, storage, jobs }).listen(
  env.API_PORT,
  () => {
    logger.info(`api listening on http://localhost:${env.API_PORT}/api/v1`);
  },
);

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(
    () =>
      void boss
        .stop({ timeout: 10_000 })
        .catch((err: unknown) => logger.error({ err }, "job queue did not stop cleanly"))
        .then(() => db.end())
        .then(() => process.exit(0)),
  );
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
