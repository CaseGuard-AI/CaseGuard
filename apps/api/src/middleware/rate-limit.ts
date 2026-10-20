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

/** Register and refresh: 20 requests per IP per 15 minutes. */
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
