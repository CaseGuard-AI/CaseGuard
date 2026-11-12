import { Router } from "express";
import { z } from "zod";
import { listProviders } from "../admin/store.js";
import { requireAuth } from "../auth/middleware.js";
import { findUserById } from "../auth/store.js";
import type { Db } from "../db/client.js";
import { modelsFor } from "../keys/catalog.js";
import { deleteKey, findProvider, listKeys, upsertKey, type KeySummary } from "../keys/store.js";
import { HttpProblem } from "../lib/problem.js";

// packages/contracts api.v1: ProviderId, UserKeyInput. The body is strict, so a stray field is
// a 400. The key itself is write-only: never returned, never logged (lib/logger.ts redacts it).
const providerId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const keyInput = z.strictObject({ apiKey: z.string().min(8).max(512) });

/** The contract's UserKey. */
const toKeyDto = (k: KeySummary) => ({
  providerId: k.providerId,
  last4: k.last4,
  createdAt: k.createdAt.toISOString(),
  updatedAt: k.updatedAt.toISOString(),
});

const forbidden = () =>
  new HttpProblem(
    403,
    "Forbidden",
    "Keys can be saved only for a cloud model provider your administrator has enabled.",
  );

// The signed-in user's own provider keys and the model list (FR-SET-2, SEC-4, SEC-11,
// ADR-0009). No user id in any path, so nobody can see or change another user's keys
// (FR-AUTH-4).
export function keysRouter(deps: { db: Db; jwtSecret: string; encryptionKey?: Buffer }) {
  const { db, encryptionKey } = deps;
  const router = Router();
  router.use(["/me/keys", "/models"], requireAuth(deps.jwtSecret));

  router.get("/me/keys", async (req, res) => {
    res.json((await listKeys(db, req.auth!.userId)).map(toKeyDto));
  });

  router.put("/me/keys/:providerId", async (req, res) => {
    const id = providerId.safeParse(req.params.providerId);
    const provider = id.success ? await findProvider(db, id.data) : undefined;
    if (!provider?.enabled || provider.kind !== "cloud") throw forbidden();
    const body = keyInput.parse(req.body);
    if (!encryptionKey) {
      throw new HttpProblem(
        503,
        "Service Unavailable",
        "Saving keys isn't set up on this server (KEY_ENCRYPTION_KEY). Ask an administrator.",
      );
    }
    const userId = req.auth!.userId;
    if (!(await findUserById(db, userId))) {
      throw new HttpProblem(401, "Unauthorized", "Your session has expired. Sign in again.");
    }
    res.json(toKeyDto(await upsertKey(db, userId, provider.id, body.apiKey, encryptionKey)));
  });

  // Works whether or not the provider is still enabled, so a user can always remove a key.
  router.delete("/me/keys/:providerId", async (req, res) => {
    const id = providerId.safeParse(req.params.providerId);
    if (!id.success || !(await deleteKey(db, req.auth!.userId, id.data))) {
      throw new HttpProblem(404, "Not Found", "No key is saved for that provider.");
    }
    res.status(204).end();
  });

  // Enabled providers only, ordered by name (listProviders), with what each offers.
  router.get("/models", async (req, res) => {
    const [all, keys] = await Promise.all([listProviders(db), listKeys(db, req.auth!.userId)]);
    const withKey = new Set(keys.map((k) => k.providerId));
    res.json(
      all
        .filter((p) => p.enabled)
        .map((p) => ({
          providerId: p.id,
          name: p.name,
          kind: p.kind,
          models: modelsFor(p.id),
          hasKey: p.kind === "cloud" && withKey.has(p.id),
        })),
    );
  });

  return router;
}
