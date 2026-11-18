import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import type { Db } from "../db/client.js";
import type { Notification } from "../db/schema.js";
import { HttpProblem } from "../lib/problem.js";
import { listNotifications, markAllRead, markRead } from "../notifications/store.js";

// packages/contracts api.v1: listNotifications, markNotificationRead, markAllNotificationsRead.
const listQuery = z.object({
  unread: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** The contract's Notification. */
const toNotificationDto = (n: Notification) => ({
  id: n.id,
  kind: n.kind,
  documentId: n.documentId,
  caseId: n.caseId,
  filename: n.filename,
  readAt: n.readAt?.toISOString() ?? null,
  createdAt: n.createdAt.toISOString(),
});

// The signed-in user's own notifications (FR-NOT-1). Another user's is a 404 (FR-AUTH-4).
export function notificationsRouter(deps: { db: Db; jwtSecret: string }) {
  const { db } = deps;
  const router = Router();
  router.use("/notifications", requireAuth(deps.jwtSecret));

  router.get("/notifications", async (req, res) => {
    const page = await listNotifications(db, req.auth!, listQuery.parse(req.query));
    res.json({ ...page, items: page.items.map(toNotificationDto) });
  });

  router.post("/notifications/read-all", async (req, res) => {
    await markAllRead(db, req.auth!);
    res.status(204).end();
  });

  router.post("/notifications/:notificationId/read", async (req, res) => {
    if (!(await markRead(db, req.auth!, req.params.notificationId))) {
      throw new HttpProblem(404, "Not Found", "No such notification.");
    }
    res.status(204).end();
  });

  return router;
}
