import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import type { Request } from "express";
import { HttpProblem } from "../lib/problem.js";

// Rate limiting for the auth routes (SEC-15). The store is in memory, so limits are per
// process; a shared store (Postgres or Redis) is needed before running more than one API instance.
const WINDOW_MS = 15 * 60 * 1000;

const tooMany: Options["handler"] = (req, res, next) => {
  const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const retryAfter = resetTime
    ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
    : 60;
  res.setHeader("Retry-After", String(retryAfter));
  next(new HttpProblem(429, "Too Many Requests", "Too many attempts. Try again later."));
};

const ip = (req: Request) => ipKeyGenerator(req.ip ?? "unknown");

/** Failed sign-ins per IP and email: 10 per 15 minutes. Successful sign-ins don't count. */
export function loginLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "";
      return `${ip(req)}|${email}`;
    },
    handler: tooMany,
  });
}

/** Password reset requests per IP and email: 5 per 15 minutes. */
export function resetLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "";
      return `${ip(req)}|${email}`;
    },
    handler: tooMany,
  });
}

/** Register and password reset: 20 requests per IP per 15 minutes. */
export function authLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: ip,
    handler: tooMany,
  });
}

/**
 * Session refreshes per IP: 120 per 15 minutes, a budget of its own (#83). The web refreshes on
 * every page load, so one office behind a NAT can't share the 20 that register and reset get.
 *
 * Keyed by IP alone, on purpose. The refresh token rotates on every call, so a per-token key would
 * reset itself, and an attacker could send a new random cookie each time to get a fresh budget.
 * The family and user aren't known until the token has been looked up.
 */
export function refreshLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: ip,
    handler: tooMany,
  });
}

/** Uploads per signed-in user: 60 per 15 minutes. Mount after requireAuth. */
export function uploadLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.auth?.userId ?? ip(req),
    handler: tooMany,
  });
}

/** Questions to the AI per signed-in user: 30 per 15 minutes. Mount after requireAuth. */
export function aiLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.auth?.userId ?? ip(req),
    handler: tooMany,
  });
}
