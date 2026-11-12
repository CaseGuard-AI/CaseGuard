import { Router, type CookieOptions, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { burnVerify, hashPassword, verifyPassword } from "../auth/password.js";
import {
  createResetToken,
  createUserWithAccount,
  findUserByEmail,
  findUserById,
  issueRefresh,
  resetPassword,
  revokeRefresh,
  rotateRefresh,
} from "../auth/store.js";
import { ACCESS_TTL_S, REFRESH_TTL_S, RESET_TTL_S, signAccessToken } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import { SELF_REGISTER_ROLES, type User } from "../db/schema.js";
import type { Mailer } from "../lib/mailer.js";
import { HttpProblem } from "../lib/problem.js";
import {
  authLimiter,
  loginLimiter,
  refreshLimiter,
  resetLimiter,
} from "../middleware/rate-limit.js";

// packages/contracts: RegisterRequest, LoginRequest. Other unknown fields are dropped. `role` is
// lawyer or researcher; admin (or anything else) is a 400, so nobody self-registers as admin
// (FR-AUTH-2).
const registerBody = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(10).max(128),
  name: z.string().trim().min(1).max(120),
  locale: z.enum(["en", "ur"]).default("en"),
  role: z.enum(SELF_REGISTER_ROLES).default("lawyer"),
});

const loginBody = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string(),
});

// packages/contracts: PasswordResetRequest, PasswordResetConfirm.
const resetRequestBody = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
});

const resetConfirmBody = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(10).max(128),
});

// packages/contracts: RefreshCookie.
const REFRESH_COOKIE = "cg_refresh";
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/api/v1/auth",
};

/** The contract's User. Never includes the password hash. */
export function toUserDto(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    locale: user.locale,
    aiEnabled: user.aiEnabled,
  };
}

const unauthorized = () =>
  new HttpProblem(401, "Unauthorized", "Your session has expired. Sign in again.");

/** The reset email: a link to the web page, with the token in the query string. */
export function resetEmail(to: string, resetUrlBase: string, token: string) {
  const url = new URL(resetUrlBase);
  url.searchParams.set("token", token);
  const minutes = RESET_TTL_S / 60;
  return {
    to,
    subject: "Reset your CaseGuard password",
    text: [
      "Someone asked to reset the password for your CaseGuard account.",
      "",
      `Set a new password here (the link works once and expires in ${minutes} minutes):`,
      url.toString(),
      "",
      "If this wasn't you, ignore this email. Your password stays the same.",
    ].join("\n"),
  };
}

export function authRouter(deps: {
  db: Db;
  jwtSecret: string;
  mailer: Mailer;
  resetUrlBase: string;
}) {
  const { db, jwtSecret, mailer, resetUrlBase } = deps;
  const router = Router();
  const limitAuth = authLimiter();

  // Sets the refresh cookie and returns the contract's Session.
  async function session(res: Response, user: User, refreshToken: string) {
    res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieOptions, maxAge: REFRESH_TTL_S * 1000 });
    const accessToken = await signAccessToken(
      { userId: user.id, accountId: user.accountId, role: user.role },
      jwtSecret,
    );
    return { accessToken, expiresIn: ACCESS_TTL_S, user: toUserDto(user) };
  }

  function clearCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
  }

  router.post("/auth/register", limitAuth, async (req, res) => {
    const body = registerBody.parse(req.body);
    const user = await createUserWithAccount(db, {
      email: body.email,
      passwordHash: await hashPassword(body.password),
      name: body.name,
      locale: body.locale,
      role: body.role,
    });
    res.status(201).json(await session(res, user, await issueRefresh(db, user)));
  });

  // Unknown email and wrong password get the same 401, and neither creates a session.
  router.post("/auth/login", loginLimiter(), async (req, res) => {
    const body = loginBody.parse(req.body);
    const user = await findUserByEmail(db, body.email);
    if (!user) {
      await burnVerify(body.password);
      throw new HttpProblem(401, "Unauthorized", "Incorrect email or password.");
    }
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      throw new HttpProblem(401, "Unauthorized", "Incorrect email or password.");
    }
    res.json(await session(res, user, await issueRefresh(db, user)));
  });

  router.post("/auth/refresh", refreshLimiter(), async (req, res) => {
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    const rotated = typeof token === "string" && token ? await rotateRefresh(db, token) : null;
    const user = rotated ? await findUserById(db, rotated.userId) : undefined;
    if (!rotated || !user) {
      clearCookie(res);
      throw unauthorized();
    }
    res.json(await session(res, user, rotated.token));
  });

  router.post("/auth/logout", async (req, res) => {
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    const revoked = typeof token === "string" && token ? await revokeRefresh(db, token) : false;
    clearCookie(res);
    if (!revoked) throw unauthorized();
    res.status(204).end();
  });

  // Always 202, sent before any lookup, so neither the status nor the timing reveals whether
  // the email has an account. The token and email are handled in the background.
  router.post("/auth/password-reset", limitAuth, resetLimiter(), (req, res) => {
    const body = resetRequestBody.parse(req.body);
    res.status(202).end();
    void (async () => {
      const user = await findUserByEmail(db, body.email);
      if (!user) return;
      const token = await createResetToken(db, user);
      await mailer.send(resetEmail(user.email, resetUrlBase, token));
    })().catch((err: unknown) => req.log.error({ err }, "password reset email failed"));
  });

  // Sets the new password and ends every session (FR-AUTH-1).
  router.post("/auth/password-reset/confirm", limitAuth, async (req, res) => {
    const body = resetConfirmBody.parse(req.body);
    const changed = await resetPassword(db, body.token, await hashPassword(body.password));
    if (!changed) {
      throw new HttpProblem(400, "Bad Request", "This reset link is invalid or has expired.");
    }
    clearCookie(res);
    res.status(204).end();
  });

  router.get("/auth/me", requireAuth(jwtSecret), async (req, res) => {
    const user = await findUserById(db, req.auth!.userId);
    if (!user) throw unauthorized();
    res.json(toUserDto(user));
  });

  return router;
}
