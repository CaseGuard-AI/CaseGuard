-- CaseGuard database bootstrap: extensions, roles and the schema ownership model of ADR-0002.
--   app     -> written only by apps/api                    (role caseguard_app)
--   corpus  -> written only by services/ai + collector     (role caseguard_ai)
--   ai      -> written only by services/ai                 (role caseguard_ai)
-- Cross-schema reads are granted per view, explicitly, by migrations.
--
-- Idempotent: safe to re-run. Run as a superuser, connected to the CaseGuard database,
-- with psql variables app_pw and ai_pw set. Callers:
--   Docker  : infra/db/init/01-schemas-and-roles.sh (first start of the volume)
--   Native  : pnpm db:bootstrap  (scripts/db-bootstrap.mjs)
\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Roles (created once; the password is re-applied on every run so .env stays the source of truth).
SELECT format('CREATE ROLE caseguard_app LOGIN PASSWORD %L', :'app_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caseguard_app') \gexec
SELECT format('CREATE ROLE caseguard_ai LOGIN PASSWORD %L', :'ai_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caseguard_ai') \gexec
SELECT format('ALTER ROLE caseguard_app LOGIN PASSWORD %L', :'app_pw') \gexec
SELECT format('ALTER ROLE caseguard_ai LOGIN PASSWORD %L', :'ai_pw') \gexec

CREATE SCHEMA IF NOT EXISTS app    AUTHORIZATION caseguard_app;
CREATE SCHEMA IF NOT EXISTS corpus AUTHORIZATION caseguard_ai;
CREATE SCHEMA IF NOT EXISTS ai     AUTHORIZATION caseguard_ai;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA app    FROM PUBLIC;
REVOKE ALL ON SCHEMA corpus FROM PUBLIC;
REVOKE ALL ON SCHEMA ai     FROM PUBLIC;

-- Each role connects to the database and resolves its own schema first.
SELECT format('GRANT CONNECT ON DATABASE %I TO caseguard_app, caseguard_ai', current_database()) \gexec
ALTER ROLE caseguard_app SET search_path = app, public;
ALTER ROLE caseguard_ai  SET search_path = corpus, ai, public;

-- Express may look up corpus records (e.g. to render a citation) but never write them.
GRANT USAGE ON SCHEMA corpus TO caseguard_app;
ALTER DEFAULT PRIVILEGES FOR ROLE caseguard_ai IN SCHEMA corpus GRANT SELECT ON TABLES TO caseguard_app;
