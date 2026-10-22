import type { RequestHandler } from "express";
import type { Db } from "../db/client.js";
import { HttpProblem } from "../lib/problem.js";
import { findUserById } from "./store.js";
import { verifyAccessToken, type AuthContext } from "./tokens.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own augmentation point
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      auth?: AuthContext;
    }
  }
}

/** Requires a valid access token (`Authorization: Bearer`) and sets req.auth. */
export function requireAuth(jwtSecret: string): RequestHandler {
  return async (req, res, next) => {
    const [scheme, token] = (req.headers.authorization ?? "").split(" ");
    const auth =
      scheme?.toLowerCase() === "bearer" && token
        ? await verifyAccessToken(token, jwtSecret)
        : null;
    if (!auth) {
      res.setHeader("WWW-Authenticate", "Bearer");
      throw new HttpProblem(401, "Unauthorized", "Sign in to continue.");
    }
    req.auth = auth;
    next();
  };
}

/** Requires one of the roles (FR-AUTH-2). Mount after requireAuth. */
export function requireRole(...roles: AuthContext["role"][]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      throw new HttpProblem(403, "Forbidden", "Your role does not allow this action.");
    }
    next();
  };
}

/**
 * Requires AI features to be enabled for the signed-in user (FR-AUTH-3). Mount after
 * requireAuth on every AI route. Read from the database on each request, so an Admin's change
 * applies to the user's next request rather than their next token.
 */
export function requireAiEnabled(db: Db): RequestHandler {
  return async (req, _res, next) => {
    const user = req.auth ? await findUserById(db, req.auth.userId) : undefined;
    if (!user?.aiEnabled) {
      throw new HttpProblem(403, "Forbidden", "AI features are disabled for your account.");
    }
    next();
  };
}
