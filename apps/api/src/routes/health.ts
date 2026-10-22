import { Router } from "express";
import type { Pool } from "pg";
import type { AiClient } from "../clients/ai.js";

export function healthRouter(deps: { db: Pick<Pool, "query">; ai: AiClient }) {
  const router = Router();

  // Liveness: the process is up.
  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: the database (as caseguard_app) and the AI service (with the token) both answer.
  router.get("/ready", async (_req, res) => {
    const [db, ai] = await Promise.allSettled([deps.db.query("SELECT 1"), deps.ai.info()]);
    const checks = {
      database: db.status === "fulfilled" ? "up" : "down",
      ai: ai.status === "fulfilled" ? "up" : "down",
    };
    const ok = checks.database === "up" && checks.ai === "up";
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "unavailable", ...checks });
  });

  return router;
}
