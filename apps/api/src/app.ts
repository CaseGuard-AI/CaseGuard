import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Pool } from "pg";
import type { AiClient } from "./clients/ai.js";
import type { Env } from "./config/env.js";
import type { Db } from "./db/client.js";
import type { JobQueue } from "./jobs/queue.js";
import type { Logger } from "./lib/logger.js";
import type { Mailer } from "./lib/mailer.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { casesRouter } from "./routes/cases.js";
import { notificationsRouter } from "./routes/notifications.js";
import { conversationsRouter } from "./routes/conversations.js";
import { documentsRouter } from "./routes/documents.js";
import { healthRouter } from "./routes/health.js";
import { keysRouter } from "./routes/keys.js";
import { settingsRouter } from "./routes/settings.js";
import { sourcesRouter } from "./routes/sources.js";
import { lintRouter } from "./routes/lint.js";
import type { BlobStore } from "./storage/blob-store.js";

export interface AppDeps {
  env: Pick<Env, "CORS_ORIGIN" | "JWT_SECRET" | "RESET_URL_BASE" | "KEY_ENCRYPTION_KEY"> &
    Partial<Pick<Env, "UPLOAD_MAX_MB">>;
  logger: Logger;
  db: Pick<Pool, "query">;
  orm: Db;
  ai: AiClient;
  mailer: Mailer;
  /** Uploaded files (data-storage §6). */
  storage: BlobStore;
  /** The document jobs (pg-boss in production). */
  jobs: JobQueue;
}

// Dependencies are injected so tests can run the app without a real DB or AI service.
export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: deps.env.CORS_ORIGIN.split(","), credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger: deps.logger }));

  // Validated by config/env.ts (32 bytes of base64). Unset: keys can't be saved or used.
  const encryptionKey = deps.env.KEY_ENCRYPTION_KEY
    ? Buffer.from(deps.env.KEY_ENCRYPTION_KEY, "base64")
    : undefined;

  const v1 = express.Router();
  v1.use(healthRouter({ db: deps.db, ai: deps.ai }));
  v1.use(
    authRouter({
      db: deps.orm,
      jwtSecret: deps.env.JWT_SECRET,
      mailer: deps.mailer,
      resetUrlBase: deps.env.RESET_URL_BASE,
    }),
  );
  v1.use(settingsRouter({ db: deps.orm, jwtSecret: deps.env.JWT_SECRET }));
  v1.use(keysRouter({ db: deps.orm, jwtSecret: deps.env.JWT_SECRET, encryptionKey }));
  v1.use(casesRouter({ db: deps.orm, jwtSecret: deps.env.JWT_SECRET }));
  v1.use(
    documentsRouter({
      db: deps.orm,
      jwtSecret: deps.env.JWT_SECRET,
      storage: deps.storage,
      jobs: deps.jobs,
      maxUploadBytes: (deps.env.UPLOAD_MAX_MB ?? 25) * 1024 * 1024,
    }),
  );
  v1.use(notificationsRouter({ db: deps.orm, jwtSecret: deps.env.JWT_SECRET }));
  v1.use(adminRouter({ db: deps.orm, jwtSecret: deps.env.JWT_SECRET }));
  v1.use(
    conversationsRouter({
      db: deps.orm,
      jwtSecret: deps.env.JWT_SECRET,
      ai: deps.ai,
      encryptionKey,
    }),
  );
  v1.use(sourcesRouter({ db: deps.orm, jwtSecret: deps.env.JWT_SECRET, ai: deps.ai }));
  v1.use(lintRouter({ db: deps.orm, jwtSecret: deps.env.JWT_SECRET, ai: deps.ai }));
  app.use("/api/v1", v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
