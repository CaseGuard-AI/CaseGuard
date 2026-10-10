# Security policy

CaseGuard AI handles legal case data, so security issues are treated as release-blocking.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's [private vulnerability reporting](https://github.com/CaseGuard-AI/CaseGuard/security/advisories/new) for this repository. Include the steps to reproduce and the affected component.

## Release-blocking security tests

These are defined in the [PRD](docs/PRD.md#13-security-and-access-control), and a release can't ship unless they pass:

- Cross-user and cross-case retrieval leakage (marker documents and marker graph facts): `FR-CASE-6`, `SEC-8`
- API keys never returned or logged: `SEC-4`
- FastAPI unreachable without the internal service token: `SEC-14`

## Handling secrets

- Secrets live only in `.env` (git-ignored) or the deployment's secret store.
- If a secret is committed by mistake, **rotate it first**, then remove it from history. Removal alone is not enough.
