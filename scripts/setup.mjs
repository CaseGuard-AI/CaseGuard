#!/usr/bin/env node
// One-shot local setup: checks the toolchain, creates .env, installs JS deps (pnpm) and a
// .venv per Python service (uv). It does NOT start a database; pick Docker or native
// (docs/engineering/local-setup.md). Idempotent: safe to re-run after every pull.
//
// Usage: pnpm setup
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shell = process.platform === "win32";

function has(cmd) {
  return spawnSync(cmd, ["--version"], { shell, stdio: "ignore" }).status === 0;
}

function step(title, cmd, args, cwd = root) {
  console.log(`\n→ ${title}`);
  const result = spawnSync(cmd, args, { cwd, shell, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`✗ ${title} failed`);
    process.exit(result.status ?? 1);
  }
}

const required = { node: "https://nodejs.org (LTS)", pnpm: "npm i -g pnpm", uv: "https://docs.astral.sh/uv/ (winget install astral-sh.uv)" };
const missing = Object.entries(required).filter(([cmd]) => !has(cmd));
if (missing.length) {
  for (const [cmd, how] of missing) console.error(`✗ ${cmd} not found. Install: ${how}`);
  process.exit(1);
}

if (!existsSync(join(root, ".env"))) {
  copyFileSync(join(root, ".env.example"), join(root, ".env"));
  console.log("→ Created .env from .env.example. Edit the passwords and keys before first use.");
}

step("JS dependencies (pnpm install)", "pnpm", ["install"]);

for (const service of ["ai", "collector"]) {
  const dir = join(root, "services", service);
  if (existsSync(join(dir, "pyproject.toml"))) {
    step(`Python env for services/${service} (uv sync → services/${service}/.venv)`, "uv", ["sync", "--all-extras", "--dev"], dir);
  }
}

console.log(`
✓ Setup complete. Next:
  1. Database, pick one:
       Docker : pnpm db:up
       Native : pnpm db:bootstrap      (needs PostgreSQL 17 + pgvector)
  2. pnpm dev                          (web :3000, api :4000, ai :8000)
`);
