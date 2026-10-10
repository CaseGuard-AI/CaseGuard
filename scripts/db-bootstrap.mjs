#!/usr/bin/env node
// Prepares a native (non-Docker) PostgreSQL for CaseGuard: creates the database if it is
// missing, checks pgvector, then runs infra/db/sql/bootstrap.sql, the same SQL the Docker
// image runs on first start. Idempotent: safe to re-run.
//
// Usage: pnpm db:bootstrap        (reads the repo-root .env)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (!existsSync(envFile)) fail("No .env found. Run: cp .env.example .env  (then edit it)");
process.loadEnvFile(envFile);

const env = process.env;
for (const key of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "APP_DB_PASSWORD", "AI_DB_PASSWORD"]) {
  if (!env[key]) fail(`${key} is not set in .env`);
}
const host = env.POSTGRES_HOST || "localhost";
const port = env.POSTGRES_PORT || "5432";
const psql = findPsql();

function findPsql() {
  const exe = process.platform === "win32" ? "psql.exe" : "psql";
  if (env.PG_BIN) return join(env.PG_BIN, exe);
  if (spawnSync(exe, ["--version"]).status === 0) return exe;
  if (process.platform === "win32") {
    const base = "C:\\Program Files\\PostgreSQL";
    if (existsSync(base)) {
      const versions = readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => b - a);
      for (const v of versions) {
        const candidate = join(base, v, "bin", exe);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  fail("psql not found. Install PostgreSQL 17, add its bin folder to PATH, or set PG_BIN in .env.");
}

function run(db, args, input) {
  const result = spawnSync(
    psql,
    ["-h", host, "-p", port, "-U", env.POSTGRES_USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-X", "-q", ...args],
    { input, encoding: "utf8", env: { ...env, PGPASSWORD: env.POSTGRES_PASSWORD } },
  );
  if (result.error) fail(String(result.error));
  if (result.status !== 0) fail(result.stderr.trim() || `psql exited with ${result.status}`);
  return result.stdout.trim();
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

console.log(`→ PostgreSQL at ${host}:${port} as ${env.POSTGRES_USER} (psql: ${psql})`);

const dbLiteral = env.POSTGRES_DB.replaceAll("'", "''");
const dbIdent = `"${env.POSTGRES_DB.replaceAll('"', '""')}"`;
const exists = run("postgres", ["-At", "-c", `SELECT 1 FROM pg_database WHERE datname = '${dbLiteral}'`]);
if (exists !== "1") {
  run("postgres", ["-c", `CREATE DATABASE ${dbIdent}`]);
  console.log(`  created database ${env.POSTGRES_DB}`);
}

const vector = run(env.POSTGRES_DB, ["-At", "-c", "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'"]);
if (vector !== "1") {
  fail(
    "pgvector is not installed in this PostgreSQL server.\n" +
      "  See docs/engineering/local-setup.md → 'Install pgvector', or use Docker for the database only:\n" +
      "  docker compose up -d db",
  );
}

run(env.POSTGRES_DB, [
  "-v", `app_pw=${env.APP_DB_PASSWORD}`,
  "-v", `ai_pw=${env.AI_DB_PASSWORD}`,
  "-f", join(root, "infra", "db", "sql", "bootstrap.sql"),
]);
console.log(`✓ ${env.POSTGRES_DB}: extensions vector + pg_trgm, roles caseguard_app + caseguard_ai, schemas app/corpus/ai`);
