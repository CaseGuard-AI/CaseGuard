import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { findUserById } from "../auth/store.js";
import type { Db } from "../db/client.js";
import type { User } from "../db/schema.js";
import { modelsFor } from "../keys/catalog.js";
import { findProvider } from "../keys/store.js";
import { HttpProblem } from "../lib/problem.js";
import { updateSettings, type SettingsPatch } from "../settings/store.js";

// packages/contracts: UserSettingsUpdate, DefaultModel. Strict and partial: a stray field such
// as `role` is a 400, never silently ignored, and an empty body is a 400 too (minProperties:
// 1). `name` has the same rules as at registration. `defaultModel: null` clears the choice.
const defaultModel = z.strictObject({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  model: z.string().min(1).max(200),
});

const settingsUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    locale: z.enum(["en", "ur"]).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
    defaultModel: defaultModel.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Send at least one setting." });

/** The contract's UserSettings. */
const toSettingsDto = (user: User) => ({
  name: user.name,
  locale: user.locale,
  theme: user.theme,
  defaultModel:
    user.defaultProviderId && user.defaultModel
      ? { providerId: user.defaultProviderId, model: user.defaultModel }
      : null,
});

// A valid token whose user is gone, as on GET /auth/me.
const unauthorized = () =>
  new HttpProblem(401, "Unauthorized", "Your session has expired. Sign in again.");

/**
 * Checks a chosen model against GET /models (FR-SET-2): 403 unless the provider is enabled
 * (unknown ids included), 400 unless the model is one it offers. Runs before any change.
 */
async function checkDefaultModel(db: Db, choice: z.infer<typeof defaultModel>) {
  const provider = await findProvider(db, choice.providerId);
  if (!provider?.enabled) {
    throw new HttpProblem(403, "Forbidden", "That model provider isn't enabled.");
  }
  if (!modelsFor(provider.id).includes(choice.model)) {
    throw new HttpProblem(400, "Bad Request", "That provider doesn't offer this model.", {
      errors: [{ path: "defaultModel.model", message: "Not one of the provider's models" }],
    });
  }
}

// The signed-in user's own settings (FR-SET-1, FR-SET-2). There's no user id in the path, so
// nobody can read or change another user's (FR-AUTH-4).
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
    const { defaultModel: choice, ...rest } = settingsUpdate.parse(req.body);
    const patch: SettingsPatch = rest;
    if (choice) await checkDefaultModel(db, choice);
    if (choice !== undefined) {
      patch.defaultProviderId = choice?.providerId ?? null;
      patch.defaultModel = choice?.model ?? null;
    }
    const user = await updateSettings(db, req.auth!.userId, patch);
    if (!user) throw unauthorized();
    res.json(toSettingsDto(user));
  });

  return router;
}
