import { problemOf, type Problem } from "@/lib/api";

// Helpers for using the `api` client from TanStack Query: a query or mutation either returns
// data or throws, so its error state carries the HTTP status.

/** A non-2xx answer from the API. A thrown fetch (no answer at all) is not one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem?: Problem,
  ) {
    super(problem?.detail ?? `HTTP ${status}`);
  }
}

export async function unwrap<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok || data === undefined) throw new ApiError(response.status, problemOf(error));
  return data;
}

export const statusOf = (error: unknown) => (error instanceof ApiError ? error.status : undefined);
