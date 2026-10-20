import pg from "pg";
import { createApp } from "./app.js";
import { createAiClient } from "./clients/ai.js";
import { parseEnv } from "./config/env.js";
import { createDb } from "./db/client.js";
import { createLogger } from "./lib/logger.js";
import { createMailer } from "./lib/mailer.js";

const env = parseEnv();
const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
const db = new pg.Pool({ connectionString: env.API_DATABASE_URL, max: 10 });
const orm = createDb(db);
const ai = createAiClient(env.AI_SERVICE_URL, env.AI_SERVICE_TOKEN);
const mailer = createMailer(env, logger);

const server = createApp({ env, logger, db, orm, ai, mailer }).listen(env.API_PORT, () => {
  logger.info(`api listening on http://localhost:${env.API_PORT}/api/v1`);
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(() => void db.end().then(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
