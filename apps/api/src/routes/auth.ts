import { Router, type CookieOptions, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { burnVerify, hashPassword, verifyPassword } from "../auth/password.js";
import {
  createUserWithAccount,
  findUserByEmail,
  findUserById,
  issueRefresh,
  revokeRefresh,
  rotateRefresh,
} from "../auth/store.js";
import { ACCESS_TTL_S, REFRESH_TTL_S, signAccessToken } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import type { User } from "../db/schema.js";
import { HttpProblem } from "../lib/problem.js";
import { authLimiter, loginLimiter } from "../middleware/rate-limit.js";

// packages/contracts: RegisterRequest, LoginRequest. Unknown fields (such as `role`) are dropped.
const registerBody = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(10).max(128),
  name: z.string().trim().min(1).max(120),
  locale: z.enum(["en", "ur"]).default("en"),
});

const loginBody = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string(),
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

export function authRouter(deps: { db: Db; jwtSecret: string }) {
  const { db, jwtSecret } = deps;
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

  router.post("/auth/refresh", limitAuth, async (req, res) => {
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

  router.get("/auth/me", requireAuth(jwtSecret), async (req, res) => {
    const user = await findUserById(db, req.auth!.userId);
    if (!user) throw unauthorized();
    res.json(toUserDto(user));
  });

  return router;
}
