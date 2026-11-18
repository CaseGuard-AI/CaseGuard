import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  DOCUMENT_MEDIA_TYPES,
  DOCUMENT_STAGES,
  type Citation,
  type DocumentFlag,
  type Language,
} from "../clients/ai.js";

// The app schema, written only by apps/api as caseguard_app (ADR-0002, ADR-0007).
//
// Ownership (FR-AUTH-5): every owned table added later carries
//   owner_user_id uuid not null references app.users(id)
//   account_id    uuid not null references app.accounts(id)
// P0/P1 has individual accounts only (one user per account). Tenants arrive in P2 by
// widening accounts.kind, with no change to owned rows (PRD §2).
export const app = pgSchema("app");

// FR-AUTH-2. Lawyer and Researcher can self-register; Administrator comes only from the
// create-admin CLI. Migration 0008 renamed the old `user` role to `lawyer`.
export const USER_ROLES = ["lawyer", "researcher", "admin"] as const;
export const SELF_REGISTER_ROLES = ["lawyer", "researcher"] as const;

export const accounts = app.table(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().default("individual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("accounts_kind_check", sql`kind in ('individual')`)],
);

export const users = app.table(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: USER_ROLES }).notNull().default("lawyer"),
    locale: text("locale", { enum: ["en", "ur"] })
      .notNull()
      .default("en"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    // FR-SET-1. `system` follows the device's light or dark preference.
    theme: text("theme", { enum: ["light", "dark", "system"] })
      .notNull()
      .default("system"),
    // FR-SET-2. The chosen model; both set or both null. Used only while the provider is
    // enabled, is cloud, and the user has a key for it (ADR-0009).
    defaultProviderId: text("default_provider_id").references(() => providers.id),
    defaultModel: text("default_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
    index("users_account_id_idx").on(t.accountId),
    check("users_role_check", sql`role in ('lawyer', 'researcher', 'admin')`),
    check("users_locale_check", sql`locale in ('en', 'ur')`),
    check("users_theme_check", sql`theme in ('light', 'dark', 'system')`),
    check(
      "users_default_model_check",
      sql`(default_provider_id is null) = (default_model is null)`,
    ),
  ],
);

// Refresh tokens (FR-AUTH-1, SEC-1). Only the SHA-256 of a token is stored. Each refresh
// revokes the presented row and adds its successor to the same family; presenting a revoked
// token again revokes the whole family (reuse detection).
export const refreshTokens = app.table(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("refresh_tokens_owner_user_id_idx").on(t.ownerUserId),
    index("refresh_tokens_family_id_idx").on(t.familyId),
  ],
);

// Password reset tokens (FR-AUTH-1, #53). Only the SHA-256 is stored; a token works once,
// expires after 30 minutes, and a newer request spends the user's older tokens.
export const passwordResetTokens = app.table(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_reset_tokens_owner_user_id_idx").on(t.ownerUserId)],
);

// Model provider allow-list (FR-AUTH-3, SEC-11, #55). Deployment configuration, not owned
// rows. Seeded by migration 0003 from the ADR-0005 presets; an Admin only switches entries on
// or off. Case data may go only to enabled providers (enforced in services/ai with #21).
export const providers = app.table(
  "providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["cloud", "local"] }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check("providers_id_check", sql`id ~ '^[a-z0-9][a-z0-9-]{0,62}$'`),
    check("providers_kind_check", sql`kind in ('cloud', 'local')`),
  ],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// A user's own model-provider keys (FR-SET-2, SEC-4, ADR-0009). Encrypted with AES-256-GCM
// under KEY_ENCRYPTION_KEY (src/keys/crypto.ts); the plaintext is never stored. `last4` is
// kept in clear for display only.
export const userApiKeys = app.table(
  "user_api_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    authTag: bytea("auth_tag").notNull(),
    last4: text("last4").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.providerId] }),
    check("user_api_keys_last4_check", sql`char_length(last4) = 4`),
  ],
);

export const PARTY_SIDES = ["claimant", "respondent"] as const;

/** A party to a case (api.v1 Party). `label` is what the court calls them ("Petitioner"). */
export interface Party {
  side: (typeof PARTY_SIDES)[number];
  name: string;
  label?: string;
}

// A user's cases (FR-CASE-1, #98), with the editable fields of Deliverable II Table 4.29. Owner
// only (FR-AUTH-4). Never deleted through the API: archiving sets archived_at.
export const cases = app.table(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    court: text("court"),
    caseNumber: text("case_number"),
    caseType: text("case_type"),
    filedOn: date("filed_on", { mode: "string" }),
    status: text("status"),
    nextHearingOn: date("next_hearing_on", { mode: "string" }),
    parties: jsonb("parties").$type<Party[]>().notNull().default([]),
    judge: text("judge"),
    assignedLawyer: text("assigned_lawyer"),
    relevantLaws: text("relevant_laws")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    summary: text("summary"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cases_owner_updated_idx").on(t.ownerUserId, t.updatedAt),
    check("cases_parties_check", sql`jsonb_typeof(${t.parties}) = 'array'`),
  ],
);

// Documents uploaded to a case (FR-DOC-1, #101). The file lives in the blob store under
// storage_key (data-storage §6); the filename lives only here. A deleted document keeps its row
// (deleted_at set, invisible to the API) until the purge job has removed the file and chunks.
export const DOCUMENT_STATUSES = ["queued", "processing", "done", "flagged", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const documents = app.table(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mediaType: text("media_type", { enum: DOCUMENT_MEDIA_TYPES }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    status: text("status", { enum: DOCUMENT_STATUSES }).notNull().default("queued"),
    flags: jsonb("flags").$type<DocumentFlag[]>().notNull().default([]),
    error: text("error"),
    pages: integer("pages"),
    // The current processing attempt (NFR-13): 1 at upload, +1 for each retry.
    attempt: integer("attempt").notNull().default(1),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Last status change (api.v1 Document.updatedAt).
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("documents_owner_created_idx").on(t.ownerUserId, t.createdAt),
    index("documents_case_created_idx").on(t.caseId, t.createdAt),
    check(
      "documents_status_check",
      sql`status in ('queued', 'processing', 'done', 'flagged', 'failed')`,
    ),
    check("documents_flags_check", sql`jsonb_typeof(${t.flags}) = 'array'`),
    check("documents_size_check", sql`size_bytes > 0`),
  ],
);

// FR-DOC-2 "each stage outcome is logged": one row per document, attempt and stage, copied from
// services/ai's ingestion status while the document job polls it.
export const documentStages = app.table(
  "document_stages",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    stage: text("stage", { enum: DOCUMENT_STAGES }).notNull(),
    state: text("state").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    flags: jsonb("flags").$type<DocumentFlag[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.attempt, t.stage] })],
);

// Conversations and their messages (FR-RES-8, #13). A conversation saved to a case (FR-CASE-5)
// is scoped to it on every question (FR-CASE-6).
export const conversations = app.table(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_owner_updated_idx").on(t.ownerUserId, t.updatedAt)],
);

const LANGUAGES = ["en", "ur", "roman_ur"] as const;

export const messages = app.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Insertion order: a question and its answer share a transaction (and so now()).
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    text: text("text").notNull(),
    language: text("language", { enum: LANGUAGES }),
    answerable: boolean("answerable"),
    citations: jsonb("citations").$type<Citation[]>(),
    // What a "law as of" date changed in this answer (FR-RES-11); assistant messages only.
    asOfNote: text("as_of_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_seq_idx").on(t.conversationId, t.seq),
    // Ownership check for GET /citations/{id} (#70): citations @> '[{"id": …}]'.
    index("messages_citations_idx").using("gin", sql`${t.citations} jsonb_path_ops`),
    check("messages_role_check", sql`role in ('user', 'assistant')`),
  ],
);

// The apps/api half of the AI audit record (PRD §13.3, FR-TRUST-12). services/ai writes the
// other half (model, provider, chunks, graph context, guardrails, translated query) under the
// same request_id. Append-only: migration 0004 adds a trigger that rejects UPDATE.
export const aiAuditRecords = app.table(
  "ai_audit_records",
  {
    requestId: uuid("request_id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    // The case the request was scoped to. No FK: the row is append-only, so it records what
    // the request carried rather than following the case.
    caseId: uuid("case_id"),
    question: text("question").notNull(),
    language: text("language", { enum: LANGUAGES }),
    lawAsOf: date("law_as_of", { mode: "string" }),
    outcome: text("outcome", { enum: ["answered", "unanswerable", "error"] }).notNull(),
    responseText: text("response_text"),
    answerLanguage: text("answer_language", { enum: LANGUAGES }),
    citations: jsonb("citations").$type<Citation[]>(),
    error: text("error"),
    // The provider allow-list in effect for this request (SEC-11, #75). Null on older rows.
    allowedProviders: text("allowed_providers").array(),
    // The user's own provider and model when the request carried their key (FR-SET-2,
    // ADR-0009). Never the key. Null when the deployment's configuration answered.
    providerId: text("provider_id"),
    model: text("model"),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_audit_records_owner_created_idx").on(t.ownerUserId, t.createdAt),
    check("ai_audit_records_outcome_check", sql`outcome in ('answered', 'unanswerable', 'error')`),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type UserApiKey = typeof userApiKeys.$inferSelect;
export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type { Language };
