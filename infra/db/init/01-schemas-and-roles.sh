#!/usr/bin/env bash
# Docker entrypoint hook: runs once, when the Postgres volume is first created.
# The SQL lives in infra/db/sql/bootstrap.sql so native (non-Docker) setups run exactly
# the same script via `pnpm db:bootstrap`.
set -euo pipefail

psql -v app_pw="$APP_DB_PASSWORD" \
     -v ai_pw="$AI_DB_PASSWORD" \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -f /caseguard-sql/bootstrap.sql
