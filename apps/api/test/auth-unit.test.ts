import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { requireAuth, requireRole } from "../src/auth/middleware.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import {
  hashToken,
  newRefreshToken,
  signAccessToken,
  verifyAccessToken,
  type AuthContext,
} from "../src/auth/tokens.js";
import { errorHandler } from "../src/middleware/errors.js";

const SECRET = "s".repeat(32);
const user: AuthContext = {
  userId: "00000000-0000-4000-8000-000000000001",
  accountId: "00000000-0000-4000-8000-000000000002",
  role: "lawyer",
};

describe("passwords", () => {
  it("hashes with argon2id and verifies (SEC-1)", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong password")).toBe(false);
  });

  it("treats a malformed hash as a failed verify", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});

describe("access tokens", () => {
  it("round-trips the auth context", async () => {
    expect(await verifyAccessToken(await signAccessToken(user, SECRET), SECRET)).toEqual(user);
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signAccessToken(user, "o".repeat(32));
    expect(await verifyAccessToken(token, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await new SignJWT({ acct: user.accountId, role: user.role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.userId)
      .setIssuer("caseguard-api")
      .setAudience("caseguard-web")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifyAccessToken(token, SECRET)).toBeNull();
  });

  it("round-trips every role (FR-AUTH-2)", async () => {
    for (const role of ["lawyer", "researcher", "admin"] as const) {
      const auth = { ...user, role };
      expect(await verifyAccessToken(await signAccessToken(auth, SECRET), SECRET)).toEqual(auth);
    }
  });

  // `user` is the role before migration 0008: such a token is refused, and the refresh issues
  // one with the migrated role.
  it.each(["superuser", "user"])("rejects the unknown role %j (FR-AUTH-2)", async (role) => {
    const token = await signAccessToken({ ...user, role: role as never }, SECRET);
    expect(await verifyAccessToken(token, SECRET)).toBeNull();
  });
});

describe("refresh tokens", () => {
  it("are random and stored only as a hash", () => {
    const a = newRefreshToken();
    expect(a).not.toBe(newRefreshToken());
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });
});

describe("requireAuth and requireRole", () => {
  const app = express();
  app.get("/admin-only", requireAuth(SECRET), requireRole("admin"), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  it("401 without a bearer token", async () => {
    const res = await request(app).get("/admin-only");
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
  });

  it("401 with an invalid token", async () => {
    const res = await request(app).get("/admin-only").set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it.each(["lawyer", "researcher"] as const)(
    "403 for a %s on an admin-only endpoint (FR-AUTH-2)",
    async (role) => {
      const token = await signAccessToken({ ...user, role }, SECRET);
      const res = await request(app).get("/admin-only").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ title: "Forbidden", status: 403 });
    },
  );

  it("200 for an Admin", async () => {
    const token = await signAccessToken({ ...user, role: "admin" }, SECRET);
    const res = await request(app).get("/admin-only").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
