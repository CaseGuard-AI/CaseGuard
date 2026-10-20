import { Router } from "express";
import { z } from "zod";
import { listProviders, listUsers, setProviderEnabled, setUserAiEnabled } from "../admin/store.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import type { Db } from "../db/client.js";
import type { Provider, User } from "../db/schema.js";
import { HttpProblem } from "../lib/problem.js";
import { toUserDto } from "./auth.js";

// packages/contracts: Cursor, Limit, AdminUserUpdate, ProviderUpdate. Update bodies are strict
// (additionalProperties: false), so a stray field such as `role` is a 400, not silently ignored.
const pageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const userUpdate = z.strictObject({ aiEnabled: z.boolean() });
const providerUpdate = z.strictObject({ enabled: z.boolean() });
const userId = z.uuid();
const providerId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/** The contract's AdminUser: User plus createdAt. */
export function toAdminUserDto(user: User) {
  return { ...toUserDto(user), createdAt: user.createdAt.toISOString() };
}

const toProviderDto = (p: Provider) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  enabled: p.enabled,
});

const notFound = (what: string) => new HttpProblem(404, "Not Found", `No such ${what}.`);

// Admin role only (FR-AUTH-2, FR-AUTH-3). Users get 403 on every route here.
export function adminRouter(deps: { db: Db; jwtSecret: string }) {
  const { db } = deps;
  const router = Router();
  router.use("/admin", requireAuth(deps.jwtSecret), requireRole("admin"));

  router.get("/admin/users", async (req, res) => {
    const page = pageQuery.parse(req.query);
    const { items, nextCursor } = await listUsers(db, page);
    res.json({ items: items.map(toAdminUserDto), nextCursor });
  });

  router.patch("/admin/users/:userId", async (req, res) => {
    const id = userId.safeParse(req.params.userId);
    if (!id.success) throw notFound("user");
    const body = userUpdate.parse(req.body);
    const user = await setUserAiEnabled(db, id.data, body.aiEnabled);
    if (!user) throw notFound("user");
    res.json(toAdminUserDto(user));
  });

  router.get("/admin/providers", async (_req, res) => {
    res.json({ items: (await listProviders(db)).map(toProviderDto) });
  });

  router.patch("/admin/providers/:providerId", async (req, res) => {
    const id = providerId.safeParse(req.params.providerId);
    if (!id.success) throw notFound("provider");
    const body = providerUpdate.parse(req.body);
    const provider = await setProviderEnabled(db, id.data, body.enabled);
    if (!provider) throw notFound("provider");
    res.json(toProviderDto(provider));
  });

  return router;
}
