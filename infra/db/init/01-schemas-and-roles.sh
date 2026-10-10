#!/usr/bin/env bash
# Runs once, when the Postgres volume is first created.
# Sets up the schema ownership model of ADR-0002:
#   app     -> written only by apps/api            (role caseguard_app)
#   corpus  -> written only by services/ai + collector (role caseguard_ai)
#   ai      -> written only by services/ai          (role caseguard_ai)
# Cross-schema reads are granted per view, explicitly, by migrations.
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
     -v app_pw="$APP_DB_PASSWORD" \
     -v ai_pw="$AI_DB_PASSWORD" \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE ROLE caseguard_app LOGIN PASSWORD :'app_pw';
CREATE ROLE caseguard_ai  LOGIN PASSWORD :'ai_pw';

CREATE SCHEMA app    AUTHORIZATION caseguard_app;
CREATE SCHEMA corpus AUTHORIZATION caseguard_ai;
CREATE SCHEMA ai     AUTHORIZATION caseguard_ai;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA app    FROM PUBLIC;
REVOKE ALL ON SCHEMA corpus FROM PUBLIC;
REVOKE ALL ON SCHEMA ai     FROM PUBLIC;

-- Express may look up corpus records (e.g. to render a citation) but never write them.
GRANT USAGE ON SCHEMA corpus TO caseguard_app;
ALTER DEFAULT PRIVILEGES FOR ROLE caseguard_ai IN SCHEMA corpus GRANT SELECT ON TABLES TO caseguard_app;
SQL
