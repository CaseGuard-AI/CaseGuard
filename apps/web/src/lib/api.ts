import type { components, paths } from "@caseguard/contracts/api.v1";
import createClient from "openapi-fetch";

// Base URL of apps/api. Every call goes through `api`, typed from packages/contracts (api.v1.yaml).
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

// `credentials: "include"` sends the refresh cookie, which the auth routes need.
export const api = createClient<paths>({ baseUrl: API_URL, credentials: "include" });

export type Schemas = components["schemas"];
export type Problem = Schemas["ValidationProblem"];

// Narrows an error body to RFC 9457 problem+json. Validation errors carry `errors[]` (path, message).
export function problemOf(error: unknown): Problem | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { title, status } = error as Partial<Problem>;
  if (typeof title !== "string" || typeof status !== "number") return undefined;
  return error as Problem;
}
