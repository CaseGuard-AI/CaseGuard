// Migration runner for the app schema (ADR-0007).
//
// Applies drizzle-kit's generated SQL from drizzle/ in the same bookkeeping format as
// drizzle-orm's migrator (app.__drizzle_migrations: hash, created_at = journal "when"),
// but never runs CREATE SCHEMA: caseguard_app owns `app` without CREATE on the database
// (ADR-0002), so the stock migrator cannot run as it. Also adds `down`, which runs the
// hand-written NNNN_<tag>.down.sql of the newest applied migration.
//
// Usage: tsx src/db/migrate.ts [up|down]    (Docker: node dist/db/migrate.js up)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg, { type Pool, type PoolClient } from "pg";
import { parseDbEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

// apps/api/drizzle, from both src/db (tsx) and dist/db (built image).
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const TABLE = `"app"."__drizzle_migrations"`;
const LOCK_KEY = 7_007_001; // pg_advisory_xact_lock key: one migration run at a time

interface JournalEntry {
  tag: string;
  when: number;
}

export function readJournal(folder: string): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

export function downFile(folder: string, tag: string): string {
  return join(folder, `${tag}.down.sql`);
}

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Applies every pending migration in one transaction. Returns the applied tags. */
export async function migrateUp(pool: Pool, folder = MIGRATIONS_FOLDER): Promise<string[]> {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const tags = new Map(readJournal(folder).map((e) => [e.when, e.tag]));
  return inTransaction(pool, async (client) => {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    const { rows } = await client.query<{ created_at: string }>(
      `SELECT created_at FROM ${TABLE} ORDER BY created_at DESC LIMIT 1`,
    );
    const last = rows[0] ? Number(rows[0].created_at) : -1;
    const applied: string[] = [];
    for (const m of migrations) {
      if (m.folderMillis <= last) continue;
      for (const statement of m.sql) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query(`INSERT INTO ${TABLE} (hash, created_at) VALUES ($1, $2)`, [
        m.hash,
        m.folderMillis,
      ]);
      applied.push(tags.get(m.folderMillis) ?? String(m.folderMillis));
    }
    return applied;
  });
}

/** Reverts the newest applied migration. Returns its tag, or null if none is applied. */
export async function migrateDown(pool: Pool, folder = MIGRATIONS_FOLDER): Promise<string | null> {
  const tags = new Map(readJournal(folder).map((e) => [e.when, e.tag]));
  return inTransaction(pool, async (client) => {
    const exists = await client.query<{ t: string | null }>(`SELECT to_regclass('${TABLE}') AS t`);
    if (!exists.rows[0]?.t) return null;
    const { rows } = await client.query<{ id: number; created_at: string }>(
      `SELECT id, created_at FROM ${TABLE} ORDER BY created_at DESC LIMIT 1`,
    );
    const newest = rows[0];
    if (!newest) return null;
    const tag = tags.get(Number(newest.created_at));
    if (!tag) throw new Error(`Applied migration ${newest.created_at} is not in the journal`);
    await client.query(readFileSync(downFile(folder, tag), "utf8"));
    await client.query(`DELETE FROM ${TABLE} WHERE id = $1`, [newest.id]);
    return tag;
  });
}

async function main(direction: string | undefined) {
  const env = parseDbEnv();
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
  const pool = new pg.Pool({ connectionString: env.API_DATABASE_URL, max: 1 });
  try {
    if (direction === "down") {
      const tag = await migrateDown(pool);
      logger.info(tag ? `reverted ${tag}` : "no migration to revert");
    } else if (direction === undefined || direction === "up") {
      const applied = await migrateUp(pool);
      logger.info(applied.length ? `applied ${applied.join(", ")}` : "app schema is up to date");
    } else {
      throw new Error(`Unknown direction "${direction}" (use up or down)`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((err: unknown) => {
    process.stderr.write(`migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
