# ADR-0007: Drizzle for the `app` schema, with reversible migrations run as `caseguard_app`

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** Stream A
- **PRD refs:** §14.2, FR-AUTH-5, ADR-0002

## Context
PRD §14.2 gives each schema exactly one migration tool and leaves the `app` schema's choice, Prisma or Drizzle, to Stream A. `apps/api` already talks to Postgres through a plain `pg` Pool, injected into `createApp` so tests can swap it. ADR-0002 makes `caseguard_app` the owner of `app`. That role has no CREATE privilege on the database, so it can't create schemas. Issue #9 also requires migrations to run as `caseguard_app` and to be reversible.

## Decision
Use **Drizzle**: `drizzle-orm` for queries and `drizzle-kit` to generate SQL migrations from `apps/api/src/db/schema.ts`.

- **Generated SQL is committed** in `apps/api/drizzle/` and reviewed like code. `CREATE SCHEMA "app"` is removed from generated files, because `infra/db/sql/bootstrap.sql` creates and owns the schema.
- **Our own runner** (`src/db/migrate.ts`) applies the SQL. It reads files with drizzle-orm's `readMigrationFiles` and keeps the same bookkeeping table format as drizzle-orm's migrator, but puts the table at `app.__drizzle_migrations`. The stock migrator always runs `CREATE SCHEMA IF NOT EXISTS` for its bookkeeping schema. Postgres checks the database CREATE privilege for that before it checks whether the schema exists, so the stock migrator can't run as `caseguard_app`.
- **Migrations run as `caseguard_app`**, using `API_DATABASE_URL`. Locally that's `pnpm db:migrate`. In Docker, the api image applies pending migrations before it starts serving.
- **Reversible:** each generated `NNNN_<tag>.sql` has a hand-written `NNNN_<tag>.down.sql`. `pnpm --filter ./apps/api db:migrate:down` reverts the newest migration in one transaction. A test fails if any migration lacks a down file.
- **Ownership (FR-AUTH-5):** every owned table carries `owner_user_id → users(id)` and `account_id → accounts(id)`. P0/P1 accounts are `kind = 'individual'`.

## Alternatives considered
| Option | Why not |
|---|---|
| Prisma | Adds a generated client, a separate schema language and a generate step to every build. It doesn't share the injected `pg` Pool. Prisma Migrate has no down migrations either, so reversibility would need the same hand-written files. |
| drizzle-orm's built-in `migrate()` | Can't run as `caseguard_app` (see above). Granting the role database-level CREATE would let it create schemas, which weakens ADR-0002. |
| Plain SQL files without an ORM | PRD §14.2 names Prisma or Drizzle. We'd lose typed queries and schema diffing. |

## Consequences
- Schema changes follow these steps: edit `schema.ts`, run `pnpm --filter ./apps/api db:generate`, review the SQL, write the `.down.sql`, then run `pnpm db:migrate`.
- Developers must run `pnpm db:migrate` after `pnpm db:bootstrap`. The api container does this by itself.
- CI's `api` job runs `bootstrap.sql` and runs the migration tests as `caseguard_app`.
- Removing a generated `CREATE SCHEMA` is a manual step. The drizzle-kit snapshot records the schema, so later migrations don't emit it again.
