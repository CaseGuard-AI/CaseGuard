import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import {
  createCase,
  findOwnCase,
  listCases,
  setArchived,
  updateCase,
  type CaseFields,
} from "../cases/store.js";
import type { Db } from "../db/client.js";
import { PARTY_SIDES, type Case } from "../db/schema.js";
import { HttpProblem } from "../lib/problem.js";

// packages/contracts api.v1: Case, CaseInput, CaseUpdate, Party, CaseState. Strict: an unknown
// field is a 400, never silently ignored. A nullable text field sent as "" (or blanks) is
// stored as null, so a cleared form input clears the field.
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

const party = z.strictObject({
  side: z.enum(PARTY_SIDES),
  name: z.string().trim().min(1).max(200),
  label: z.string().trim().max(40).optional(),
});

const fields = {
  title: z.string().trim().min(1).max(200),
  court: text(120),
  caseNumber: text(80),
  caseType: text(80),
  filedOn: z.iso.date().nullable(),
  status: text(80),
  nextHearingOn: z.iso.date().nullable(),
  parties: z.array(party).max(50),
  judge: text(200),
  assignedLawyer: text(120),
  relevantLaws: z.array(z.string().trim().min(1).max(120)).max(50),
  summary: text(4000),
};

const caseInput = z.strictObject(fields).partial().required({ title: true });

const caseUpdate = z
  .strictObject(fields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "Send at least one field." });

const listQuery = z.object({
  state: z.enum(["active", "archived", "all"]).default("active"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Drops the keys zod left undefined, so they aren't written as NULL. */
const defined = <T extends object>(body: T) =>
  Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Partial<T>;

/** The contract's Case. */
const toCaseDto = (c: Case) => ({
  id: c.id,
  title: c.title,
  court: c.court,
  caseNumber: c.caseNumber,
  caseType: c.caseType,
  filedOn: c.filedOn,
  status: c.status,
  nextHearingOn: c.nextHearingOn,
  parties: c.parties,
  judge: c.judge,
  assignedLawyer: c.assignedLawyer,
  relevantLaws: c.relevantLaws,
  summary: c.summary,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
  archivedAt: c.archivedAt?.toISOString() ?? null,
});

const notFound = () => new HttpProblem(404, "Not Found", "No such case.");

// The signed-in user's own cases (FR-CASE-1). Another user's case is a 404 (FR-AUTH-4).
export function casesRouter(deps: { db: Db; jwtSecret: string }) {
  const { db } = deps;
  const router = Router();
  router.use("/cases", requireAuth(deps.jwtSecret));

  router.get("/cases", async (req, res) => {
    const { items, nextCursor } = await listCases(db, req.auth!, listQuery.parse(req.query));
    res.json({ items: items.map(toCaseDto), nextCursor });
  });

  router.post("/cases", async (req, res) => {
    const body = caseInput.parse(req.body ?? {});
    const created = await createCase(db, req.auth!, defined(body) as CaseFields);
    res.status(201).json(toCaseDto(created));
  });

  router.get("/cases/:caseId", async (req, res) => {
    const found = await findOwnCase(db, req.auth!, req.params.caseId);
    if (!found) throw notFound();
    res.json(toCaseDto(found));
  });

  router.patch("/cases/:caseId", async (req, res) => {
    const patch = caseUpdate.parse(req.body);
    const updated = await updateCase(db, req.auth!, req.params.caseId, defined(patch));
    if (!updated) throw notFound();
    res.json(toCaseDto(updated));
  });

  for (const [action, archived] of [
    ["archive", true],
    ["unarchive", false],
  ] as const) {
    router.post(`/cases/:caseId/${action}`, async (req, res) => {
      const updated = await setArchived(db, req.auth!, req.params.caseId, archived);
      if (!updated) throw notFound();
      res.json(toCaseDto(updated));
    });
  }

  return router;
}
