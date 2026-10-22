import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Citation, Language } from "../clients/ai.js";

// The app schema, written only by apps/api as caseguard_app (ADR-0002, ADR-0007).
//
// Ownership (FR-AUTH-5): every owned table added later carries
//   owner_user_id uuid not null references app.users(id)
//   account_id    uuid not null references app.accounts(id)
// P0/P1 has individual accounts only (one user per account). Tenants arrive in P2 by
// widening accounts.kind, with no change to owned rows (PRD §2).
export const app = pgSchema("app");

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
    role: text("role", { enum: ["user", "admin"] })
      .notNull()
      .default("user"),
    locale: text("locale", { enum: ["en", "ur"] })
      .notNull()
      .default("en"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    // FR-SET-1. `system` follows the device's light or dark preference.
    theme: text("theme", { enum: ["light", "dark", "system"] })
      .notNull()
      .default("system"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
    index("users_account_id_idx").on(t.accountId),
    check("users_role_check", sql`role in ('user', 'admin')`),
    check("users_locale_check", sql`locale in ('en', 'ur')`),
    check("users_theme_check", sql`theme in ('light', 'dark', 'system')`),
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

// Conversations and their messages (FR-RES-8, #13). case_id has no FK until cases land (P1).
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
    caseId: uuid("case_id"),
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
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type { Language };
