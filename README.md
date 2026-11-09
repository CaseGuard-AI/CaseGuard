# CaseGuard AI

**A verifiable legal research and drafting workspace for Pakistani law.** Every citation is checked against an official source and shown with a status (*Verified · Needs review · Unverified*) and a last-verified date.

Final Year Project, Department of Computer Science, FAST-NUCES Lahore. Supervisor: Dr. Arshad Ali.

> **Status:** pre-alpha. The repository foundation and PRD are in place, and the services are being scaffolded. See [PRD §5](docs/PRD.md#5-current-baseline).

## Documentation

| Document | Purpose |
|---|---|
| [**PRD**](docs/PRD.md) | What we're building, priorities, requirements and the delivery plan. **Start here.** |
| [**Handoff: start here**](docs/engineering/handoff.md) | Where the work stands and what to pick up next |
| [Contributing](CONTRIBUTING.md) | How to work in this repo |
| [Branching & release](docs/engineering/branching-and-release.md) | `main` / `staging` / feature-branch model, PR rules, releases, hotfixes |
| [ADRs](docs/adr/) | Architecture decision records |
| [Deliverables](docs/deliverables/) | Proposal and Deliverable II report |

## Repository layout

```
.
├── apps/
│   ├── web/              Next.js frontend (Stream A)
│   └── api/              Express API: auth, cases, documents, access decisions (Stream A)
├── services/
│   ├── ai/               FastAPI: retrieval, graph, trust layer, LLM pipelines, evaluation (Stream C)
│   └── collector/        Provenance-tracked legal data collector (Stream B)
├── packages/
│   └── contracts/        OpenAPI contracts between services (shared)
├── docs/                 PRD, ADRs, engineering docs, deliverables
├── scripts/              Repo tooling (branch protection setup, …)
├── .github/              CI workflows, PR/issue templates, CODEOWNERS, Dependabot
└── docker-compose.yml    Local stack
```

## Branches

| Branch | Meaning |
|---|---|
| `main` | Tagged releases only |
| `staging` | Integration branch and the **default** branch. All PRs target it. |
| `feature/*`, `fix/*`, `chore/*`, `docs/*` … | Short-lived work branches cut from `staging` |

## Quick start

```bash
cp .env.example .env
docker compose up -d db
```
