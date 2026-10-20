import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { accounts, passwordResetTokens, refreshTokens, users, type User } from "../db/schema.js";
import { HttpProblem } from "../lib/problem.js";
import { REFRESH_TTL_S, RESET_TTL_S, hashToken, newRefreshToken } from "./tokens.js";

// Drizzle wraps driver errors; the Postgres SQLSTATE is on the error or its cause.
function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export interface NewUserInput {
  email: string;
  passwordHash: string;
  name: string;
  locale: User["locale"];
}

/** Creates an individual account and its user in one transaction. 409 if the email is taken. */
export async function createUserWithAccount(db: Db, input: NewUserInput): Promise<User> {
  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx.insert(accounts).values({}).returning();
      const [user] = await tx
        .insert(users)
        .values({ ...input, accountId: account!.id })
        .returning();
      return user!;
    });
  } catch (err) {
    if (pgCode(err) === "23505") {
      throw new HttpProblem(409, "Conflict", "An account with this email already exists.");
    }
    throw err;
  }
}

export async function findUserByEmail(db: Db, email: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`);
  return user;
}

export async function findUserById(db: Db, id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Stores a new refresh token for the user and returns the raw token (only its hash is kept). */
export async function issueRefresh(
  db: Db | Tx,
  user: Pick<User, "id" | "accountId">,
  familyId: string = crypto.randomUUID(),
): Promise<string> {
  const token = newRefreshToken();
  await db.insert(refreshTokens).values({
    ownerUserId: user.id,
    accountId: user.accountId,
    familyId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000),
  });
  return token;
}

/**
 * Spends a refresh token and issues its successor in the same family. Returns null when the
 * token is unknown, expired or already used. Reusing a revoked token revokes the whole family,
 * since that means the token was copied.
 */
export async function rotateRefresh(
  db: Db,
  token: string,
): Promise<{ userId: string; token: string } | null> {
  const tokenHash = hashToken(token);
  return db.transaction(async (tx) => {
    const [spent] = await tx
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, sql`now()`),
        ),
      )
      .returning();
    if (!spent) {
      const [reused] = await tx
        .select({ familyId: refreshTokens.familyId })
        .from(refreshTokens)
        .where(
          and(eq(refreshTokens.tokenHash, tokenHash), sql`${refreshTokens.revokedAt} is not null`),
        );
      if (reused) await revokeFamily(tx, reused.familyId);
      return null;
    }
    const next = await issueRefresh(
      tx,
      { id: spent.ownerUserId, accountId: spent.accountId },
      spent.familyId,
    );
    return { userId: spent.ownerUserId, token: next };
  });
}

async function revokeFamily(db: Db | Tx, familyId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

/** Revokes the token's family (sign-out). Returns false if the token is unknown or already revoked. */
export async function revokeRefresh(db: Db, token: string): Promise<boolean> {
  const [row] = await db
    .update(refreshTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(refreshTokens.tokenHash, hashToken(token)), isNull(refreshTokens.revokedAt)))
    .returning({ familyId: refreshTokens.familyId });
  if (!row) return false;
  await revokeFamily(db, row.familyId);
  return true;
}

/**
 * Creates a password reset token for the user and returns the raw token (only its hash is kept).
 * The user's older unused tokens are spent, so only the newest link works.
 */
export async function createResetToken(
  db: Db,
  user: Pick<User, "id" | "accountId">,
): Promise<string> {
  const token = newRefreshToken();
  await db.transaction(async (tx) => {
    await spendResetTokens(tx, user.id);
    await tx.insert(passwordResetTokens).values({
      ownerUserId: user.id,
      accountId: user.accountId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_S * 1000),
    });
  });
  return token;
}

/**
 * Spends a reset token and sets the new password in one transaction. Every refresh token of the
 * user is revoked, so all sessions end. Returns false for an unknown, used or expired token.
 */
export async function resetPassword(db: Db, token: string, passwordHash: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [spent] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hashToken(token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ userId: passwordResetTokens.ownerUserId });
    if (!spent) return false;
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: sql`now()` })
      .where(eq(users.id, spent.userId));
    await spendResetTokens(tx, spent.userId);
    await tx
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.ownerUserId, spent.userId), isNull(refreshTokens.revokedAt)));
    return true;
  });
}

async function spendResetTokens(db: Db | Tx, userId: string): Promise<void> {
  await db
    .update(passwordResetTokens)
    .set({ usedAt: sql`now()` })
    .where(and(eq(passwordResetTokens.ownerUserId, userId), isNull(passwordResetTokens.usedAt)));
}
