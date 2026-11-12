import { existsSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MIGRATIONS_FOLDER,
  downFile,
  migrateDown,
  migrateUp,
  readJournal,
} from "../src/db/migrate.js";

describe("migration files", () => {
  it("every migration has a hand-written down migration (ADR-0007)", () => {
    const missing = readJournal(MIGRATIONS_FOLDER)
      .map((e) => e.tag)
      .filter((tag) => !existsSync(downFile(MIGRATIONS_FOLDER, tag)));
    expect(missing).toEqual([]);
  });
});

// Runs as caseguard_app against a bootstrapped database (CI runs infra/db/sql/bootstrap.sql
// first), which proves migrations work as the app role (#9).
const url = process.env.APP_TEST_DATABASE_URL;

describe.skipIf(!url)("app schema migrations", () => {
  let pool: pg.Pool;

  const tables = async () =>
    (
      await pool.query<{ tablename: string; tableowner: string }>(
        "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename",
      )
    ).rows;

  async function downToEmpty() {
    while (await migrateDown(pool));
  }

  async function newAccount() {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO app.accounts DEFAULT VALUES RETURNING id",
    );
    return rows[0]!.id;
  }

  function insertUser(accountId: string, fields: Record<string, string> = {}) {
    const row = { email: "a@example.com", name: "A", password_hash: "x", ...fields };
    const cols = Object.keys(row);
    return pool.query(
      `INSERT INTO app.users (account_id, ${cols.join(", ")})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`,
      [accountId, ...Object.values(row)],
    );
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await downToEmpty();
    await migrateUp(pool);
  });

  afterAll(async () => {
    await downToEmpty();
    await pool.end();
  });

  it("creates the app tables owned by the migrating role", async () => {
    const { rows } = await pool.query<{ u: string }>("SELECT current_user AS u");
    const role = rows[0]!.u;
    expect(await tables()).toEqual([
      { tablename: "__drizzle_migrations", tableowner: role },
      { tablename: "accounts", tableowner: role },
      { tablename: "ai_audit_records", tableowner: role },
      { tablename: "conversations", tableowner: role },
      { tablename: "messages", tableowner: role },
      { tablename: "password_reset_tokens", tableowner: role },
      { tablename: "providers", tableowner: role },
      { tablename: "refresh_tokens", tableowner: role },
      { tablename: "users", tableowner: role },
    ]);
  });

  it("is a no-op when already up to date", async () => {
    expect(await migrateUp(pool)).toEqual([]);
  });

  it("rejects a duplicate email regardless of case", async () => {
    const accountId = await newAccount();
    await insertUser(accountId, { email: "Dup@Example.com" });
    await expect(insertUser(accountId, { email: "dup@example.COM" })).rejects.toMatchObject({
      code: "23505",
    });
  });

  it.each(["superuser", "user"])("rejects the role %j (FR-AUTH-2)", async (role) => {
    await expect(
      insertUser(await newAccount(), { email: "r@example.com", role }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts lawyer, researcher and admin (FR-AUTH-2)", async () => {
    for (const role of ["lawyer", "researcher", "admin"]) {
      await insertUser(await newAccount(), { email: `${role}@example.com`, role });
    }
  });

  it("0008 turns existing users into lawyers, and its down turns them back", async () => {
    const roleOf = async (email: string) =>
      (await pool.query("SELECT role FROM app.users WHERE email = $1", [email])).rows[0]?.role;
    expect(await migrateDown(pool)).toBe("0009_message_as_of_note");
    expect(await migrateDown(pool)).toBe("0008_user_roles");
    await insertUser(await newAccount(), { email: "old-user@example.com", role: "user" });
    await insertUser(await newAccount(), { email: "old-admin@example.com", role: "admin" });
    expect(await migrateUp(pool)).toEqual(["0008_user_roles", "0009_message_as_of_note"]);
    expect(await roleOf("old-user@example.com")).toBe("lawyer");
    expect(await roleOf("old-admin@example.com")).toBe("admin");

    await insertUser(await newAccount(), {
      email: "new-researcher@example.com",
      role: "researcher",
    });
    expect(await migrateDown(pool)).toBe("0009_message_as_of_note");
    expect(await migrateDown(pool)).toBe("0008_user_roles");
    expect(await roleOf("old-user@example.com")).toBe("user");
    expect(await roleOf("new-researcher@example.com")).toBe("user");
    expect(await roleOf("old-admin@example.com")).toBe("admin");
    expect(await migrateUp(pool)).toEqual(["0008_user_roles", "0009_message_as_of_note"]);
  });

  it("rejects a theme outside light/dark/system (FR-SET-1)", async () => {
    await expect(
      insertUser(await newAccount(), { email: "t@example.com", theme: "blue" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an unknown locale and account kind", async () => {
    await expect(
      insertUser(await newAccount(), { email: "l@example.com", locale: "fr" }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("INSERT INTO app.accounts (kind) VALUES ('tenant')"),
    ).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("applies defaults: role lawyer, locale en, AI enabled, theme system", async () => {
    const accountId = await newAccount();
    await insertUser(accountId, { email: "d@example.com" });
    const { rows } = await pool.query(
      "SELECT role, locale, ai_enabled, theme FROM app.users WHERE email = 'd@example.com'",
    );
    expect(rows[0]).toEqual({ role: "lawyer", locale: "en", ai_enabled: true, theme: "system" });
  });

  it("deleting an account deletes its users", async () => {
    const accountId = await newAccount();
    await insertUser(accountId, { email: "c@example.com" });
    await pool.query("DELETE FROM app.accounts WHERE id = $1", [accountId]);
    const { rowCount } = await pool.query("SELECT 1 FROM app.users WHERE account_id = $1", [
      accountId,
    ]);
    expect(rowCount).toBe(0);
  });

  it("is reversible: down drops the tables, up recreates them", async () => {
    const hasColumn = async (table: string, column: string) =>
      (
        await pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = $1 AND column_name = $2",
          [table, column],
        )
      ).rowCount === 1;
    const hasTheme = () => hasColumn("users", "theme");
    expect(await hasColumn("messages", "as_of_note")).toBe(true);
    expect(await migrateDown(pool)).toBe("0009_message_as_of_note");
    expect(await hasColumn("messages", "as_of_note")).toBe(false);
    expect(await migrateDown(pool)).toBe("0008_user_roles");
    expect(await hasTheme()).toBe(true);
    expect(await migrateDown(pool)).toBe("0007_user_theme");
    expect(await hasTheme()).toBe(false);
    expect(await migrateDown(pool)).toBe("0006_audit_allowed_providers");
    expect(await migrateDown(pool)).toBe("0005_messages_citations_idx");
    expect(await migrateDown(pool)).toBe("0004_conversations");
    expect(await migrateDown(pool)).toBe("0003_providers");
    expect((await tables()).map((t) => t.tablename)).toEqual([
      "__drizzle_migrations",
      "accounts",
      "password_reset_tokens",
      "refresh_tokens",
      "users",
    ]);
    expect(await migrateDown(pool)).toBe("0002_password_reset_tokens");
    expect((await tables()).map((t) => t.tablename)).toEqual([
      "__drizzle_migrations",
      "accounts",
      "refresh_tokens",
      "users",
    ]);
    expect(await migrateDown(pool)).toBe("0001_refresh_tokens");
    expect((await tables()).map((t) => t.tablename)).toEqual([
      "__drizzle_migrations",
      "accounts",
      "users",
    ]);
    expect(await migrateDown(pool)).toBe("0000_users_accounts");
    expect((await tables()).map((t) => t.tablename)).toEqual(["__drizzle_migrations"]);
    expect(await migrateDown(pool)).toBeNull();
    expect(await migrateUp(pool)).toEqual([
      "0000_users_accounts",
      "0001_refresh_tokens",
      "0002_password_reset_tokens",
      "0003_providers",
      "0004_conversations",
      "0005_messages_citations_idx",
      "0006_audit_allowed_providers",
      "0007_user_theme",
      "0008_user_roles",
      "0009_message_as_of_note",
    ]);
    expect((await tables()).map((t) => t.tablename)).toEqual([
      "__drizzle_migrations",
      "accounts",
      "ai_audit_records",
      "conversations",
      "messages",
      "password_reset_tokens",
      "providers",
      "refresh_tokens",
      "users",
    ]);
  });
});
