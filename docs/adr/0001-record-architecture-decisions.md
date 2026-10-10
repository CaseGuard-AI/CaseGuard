# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-10
- **PRD refs:** §16.3

## Context
The team is three people working in parallel streams, and two academic deliverables must explain *why* the system is built the way it is. Decisions made in chat get lost.

## Decision
Every significant architecture decision is recorded as a numbered ADR in `docs/adr/`, using `0000-template.md`. ADRs are immutable once accepted. A change is made by writing a new ADR that supersedes the old one.

## Consequences
- PRs that introduce a new datastore, framework, external service or cross-service pattern must include an ADR.
- The final report's design chapter can cite ADRs directly.
