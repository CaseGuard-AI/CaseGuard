# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/). Release process: [`docs/engineering/branching-and-release.md`](docs/engineering/branching-and-release.md#6-releases).

## [Unreleased]

### Added
- Product Requirements Document v1.0 (`docs/PRD.md`)
- Repository foundation: monorepo layout, branching model (`main` / `staging` / feature branches), contribution guide, ADRs 0001–0006, CI workflows, PR/issue templates, local Postgres + pgvector compose file
- Full Docker stack: `docker compose up --build` (or `pnpm stack:up`) runs db, ai, api and web healthy. ai is unreachable from the host and from web, with outbound-only egress for model providers. A CI `compose-smoke` job boots the stack on infra changes (#23)
