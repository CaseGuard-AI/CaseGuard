import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Pool } from "pg";
import type { AiClient } from "./clients/ai.js";
import type { Env } from "./config/env.js";
import type { Db } from "./db/client.js";
import type { Logger } from "./lib/logger.js";
import type { Mailer } from "./lib/mailer.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";

export interface AppDeps {
  env: Pick<Env, "CORS_ORIGIN" | "JWT_SECRET">;
  logger: Logger;
  db: Pick<Pool, "query">;
  orm: Db;
  ai: AiClient;
  mailer: Mailer;
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

  const v1 = express.Router();
  v1.use(healthRouter({ db: deps.db, ai: deps.ai }));
  v1.use(authRouter({ db: deps.orm, jwtSecret: deps.env.JWT_SECRET }));
  // Feature routers (conversations, citations, sources) mount here, per packages/contracts.
  app.use("/api/v1", v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
