// Creates an Admin, or promotes an existing user to Admin (FR-AUTH-2, #54).
//
// Usage: tsx src/db/create-admin.ts --email <email> [--name <name>]
//        (Docker: docker compose exec api node dist/db/create-admin.js --email …)
//
// An existing user (email matched case-insensitively) is promoted and keeps their password.
// A new user needs --name and a password, which is never taken as an argument (it would land
// in shell history and the process list): it is typed at a hidden prompt, twice, or read
// from the first line of stdin when stdin isn't a terminal.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import { hashPassword } from "../auth/password.js";
import { createUserWithAccount, findUserByEmail } from "../auth/store.js";
import { parseDbEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { createDb, type Db } from "./client.js";
import { users, type User } from "./schema.js";

// The same rules as RegisterRequest in packages/contracts.
const email = z.string().trim().pipe(z.email().max(254));
const name = z.string().trim().min(1).max(120);
const password = z.string().min(10).max(128);

export interface CliArgs {
  email: string;
  name?: string;
}

/** Parses the CLI arguments. Rejects --password and anything else unknown. */
export function parseCliArgs(argv: string[]): CliArgs {
  if (argv.some((a) => a === "--password" || a.startsWith("--password="))) {
    throw new Error("Never pass a password as an argument; you'll be prompted for it");
  }
  const { values } = parseArgs({
    args: argv,
    options: { email: { type: "string" }, name: { type: "string" } },
    strict: true,
  });
  if (!values.email) throw new Error("--email is required");
  return {
    email: email.parse(values.email),
    ...(values.name !== undefined ? { name: name.parse(values.name) } : {}),
  };
}

export type AdminResult = { action: "created" | "promoted" | "unchanged"; user: User };

/**
 * Promotes the user with this email to Admin, or creates one. `getPassword` is called only
 * when a new user is created.
 */
export async function createOrPromoteAdmin(
  db: Db,
  args: CliArgs,
  getPassword: () => Promise<string>,
): Promise<AdminResult> {
  const existing = await findUserByEmail(db, args.email);
  if (existing) {
    if (existing.role === "admin") return { action: "unchanged", user: existing };
    const [user] = await db
      .update(users)
      .set({ role: "admin", updatedAt: sql`now()` })
      .where(eq(users.id, existing.id))
      .returning();
    return { action: "promoted", user: user! };
  }
  if (!args.name) throw new Error(`No user ${args.email} exists; pass --name to create one`);
  const user = await createUserWithAccount(db, {
    email: args.email,
    name: args.name,
    passwordHash: await hashPassword(password.parse(await getPassword())),
    locale: "en",
    role: "admin",
  });
  return { action: "created", user };
}

// Reads a line from a terminal without echoing it.
function promptHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await promptHidden("Password for the new admin (10-128 characters): ");
    const again = await promptHidden("Repeat the password: ");
    if (first !== again) throw new Error("The passwords don't match");
    return first;
  }
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  throw new Error("No password on stdin");
}

async function main(argv: string[]) {
  const args = parseCliArgs(argv);
  const env = parseDbEnv();
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
  const pool = new pg.Pool({ connectionString: env.API_DATABASE_URL, max: 1 });
  try {
    const { action, user } = await createOrPromoteAdmin(createDb(pool), args, readPassword);
    const messages = {
      created: "created admin",
      promoted: "promoted user to admin",
      unchanged: "user is already an admin",
    };
    logger.info({ userId: user.id }, messages[action]);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join("; ")
        : err instanceof Error
          ? err.message
          : String(err);
    process.stderr.write(`create-admin failed: ${message}\n`);
    process.exit(1);
  });
}
