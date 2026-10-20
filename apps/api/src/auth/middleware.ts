import type { RequestHandler } from "express";
import { HttpProblem } from "../lib/problem.js";
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
