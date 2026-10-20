import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
    index("users_account_id_idx").on(t.accountId),
    check("users_role_check", sql`role in ('user', 'admin')`),
    check("users_locale_check", sql`locale in ('en', 'ur')`),
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

export type Account = typeof accounts.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
