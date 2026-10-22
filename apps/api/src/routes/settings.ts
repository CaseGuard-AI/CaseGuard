import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { findUserById } from "../auth/store.js";
import type { Db } from "../db/client.js";
import type { User } from "../db/schema.js";
import { HttpProblem } from "../lib/problem.js";
import { updateSettings } from "../settings/store.js";

// packages/contracts: UserSettingsUpdate. Strict and partial: a stray field such as `role` is a
// 400, never silently ignored, and an empty body is a 400 too (minProperties: 1). `name` has the
// same rules as at registration.
const settingsUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    locale: z.enum(["en", "ur"]).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Send at least one setting." });

/** The contract's UserSettings. */
const toSettingsDto = (user: User) => ({ name: user.name, locale: user.locale, theme: user.theme });

// A valid token whose user is gone, as on GET /auth/me.
const unauthorized = () =>
  new HttpProblem(401, "Unauthorized", "Your session has expired. Sign in again.");

// The signed-in user's own settings (FR-SET-1). There's no user id in the path, so nobody can
// read or change another user's (FR-AUTH-4).
export function settingsRouter(deps: { db: Db; jwtSecret: string }) {
  const { db } = deps;
  const router = Router();
  router.use("/me", requireAuth(deps.jwtSecret));

  router.get("/me/settings", async (req, res) => {
    const user = await findUserById(db, req.auth!.userId);
    if (!user) throw unauthorized();
    res.json(toSettingsDto(user));
  });

  router.patch("/me/settings", async (req, res) => {
    const patch = settingsUpdate.parse(req.body);
    const user = await updateSettings(db, req.auth!.userId, patch);
    if (!user) throw unauthorized();
    res.json(toSettingsDto(user));
  });

  return router;
}
