import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../db/schema.js";

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 14 * 24 * 60 * 60;

const ISSUER = "caseguard-api";
const AUDIENCE = "caseguard-web";

export interface AuthContext {
  userId: string;
  accountId: string;
  role: User["role"];
}

const key = (secret: string) => new TextEncoder().encode(secret);

export function signAccessToken(auth: AuthContext, secret: string): Promise<string> {
  return new SignJWT({ acct: auth.accountId, role: auth.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(auth.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_S}s`)
    .sign(key(secret));
}

/** Returns the auth context, or null if the token is invalid, expired or malformed. */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AuthContext | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const { sub, acct, role } = payload;
    if (typeof sub !== "string" || typeof acct !== "string") return null;
    if (role !== "user" && role !== "admin") return null;
    return { userId: sub, accountId: acct, role };
  } catch {
    return null;
  }
}

// Refresh tokens are opaque random strings; only their SHA-256 is stored.
export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
