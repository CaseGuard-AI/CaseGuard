import { HttpProblem } from "./problem.js";

// Cursors are opaque to clients: base64url of the last row's id. The next page compares
// (timestamp, id) in SQL, so microsecond timestamps never round through JavaScript.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: string) => UUID.test(value);

export const encodeCursor = (id: string) => Buffer.from(id).toString("base64url");

/** The id inside a cursor; 400 if it isn't one of ours. */
export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!UUID.test(id)) throw new HttpProblem(400, "Bad Request", "The cursor is invalid.");
  return id;
}
