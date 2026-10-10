# ADR-0002: Express API and an internal FastAPI AI service with a strict boundary

- **Status:** Accepted
- **Date:** 2026-10-10
- **PRD refs:** §13.1, §14.1, §14.2, SEC-14

## Context
The team prefers Express for application logic. The AI ecosystem (LangGraph, RAGAS, sentence-transformers, Graphiti) is Python. Two backends risk duplicated auth and access logic, and access logic is the system's biggest privacy risk.

## Decision
- **`apps/api` (Express)** owns *all* user-facing concerns: auth, roles, sessions, cases, documents, uploads, settings, encrypted keys, notifications, audit writes, and **the access decision**.
- **`services/ai` (FastAPI)** is **internal-only**. It is not routable from the internet and authenticates callers only with a service token. It receives already-scoped requests (`user_id`, `account_id`, `allowed_case_ids`) and applies that scope *inside* its SQL.
- **One PostgreSQL instance, three schemas, single-writer ownership:** `app` (Express), and `corpus` + `ai` (FastAPI and the collector). Cross-schema reads go through explicitly granted views only.
- Both interfaces are defined contract-first as OpenAPI documents in `packages/contracts`.

## Alternatives considered
| Option | Why not |
|---|---|
| FastAPI only | Rejected by team preference |
| Both services authenticate users | Two auth implementations to secure and keep in sync |
| Separate databases | Cross-service joins for retrieval scoping become network calls, and transactions are harder |

## Consequences
- Easier: one place to audit access control; streams can work in parallel against contracts.
- Harder: a contract change needs a coordinated PR, and contract tests must run in CI.
