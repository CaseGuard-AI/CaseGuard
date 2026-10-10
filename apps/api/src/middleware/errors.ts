import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpProblem } from "../lib/problem.js";

const PROBLEM = "application/problem+json";

export const notFound: RequestHandler = (req, res) => {
  res
    .status(404)
    .type(PROBLEM)
    .json({ type: "about:blank", title: "Not Found", status: 404, instance: req.originalUrl });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).type(PROBLEM).json({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpProblem) {
    res
      .status(err.status)
      .type(PROBLEM)
      .json({
        type: "about:blank",
        title: err.title,
        status: err.status,
        ...(err.detail ? { detail: err.detail } : {}),
        ...err.extra,
      });
    return;
  }
  req.log.error({ err }, "unhandled error");
  res
    .status(500)
    .type(PROBLEM)
    .json({ type: "about:blank", title: "Internal Server Error", status: 500 });
};
