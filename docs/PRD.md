# CaseGuard AI — Product Requirements Document

| | |
|---|---|
| **Product** | CaseGuard AI — a verifiable legal research and drafting workspace for Pakistani law |
| **Document status** | v1.0 — initial build plan |
| **Date** | 10 October 2026 |
| **Owners** | CaseGuard AI team, FAST-NUCES Lahore (supervisor: Dr. Arshad Ali) |
| **Source documents** | [Project proposal](deliverables/CaseGuard_AI_Proposal.pdf) · [Deliverable II report](deliverables/CaseGuard_AI_Deliverable_II_Report.docx) |
| **Supersedes** | Where this PRD and Deliverable II disagree, this PRD is the build plan. Differences are listed in [Appendix A](#appendix-a--changes-from-deliverable-ii). |

**How to read this document.** Requirements keep the identifiers of Deliverable II (for example `FR-RES-5`) where the requirement survives, so the report's traceability still holds. New requirements use new prefixes. Every requirement has a **priority** (P0, P1 or P2, defined in §4) and an **acceptance criterion**. "Shall" is a commitment, and "may" is an option. Architecture decisions are recorded as ADRs in [`docs/adr/`](adr/).

---

## Contents

1. [Problem and product](#1-problem-and-product)
2. [Users and roles](#2-users-and-roles)
3. [Goals and success measures](#3-goals-and-success-measures)
4. [Scope and priorities](#4-scope-and-priorities)
5. [Current baseline](#5-current-baseline)
6. [Functional requirements](#6-functional-requirements)
7. [Trust layer specification](#7-trust-layer-specification)
8. [Retrieval and language specification](#8-retrieval-and-language-specification)
9. [Knowledge graph specification](#9-knowledge-graph-specification)
10. [Temporal specification](#10-temporal-specification)
11. [Evaluation specification](#11-evaluation-specification)
12. [Non-functional requirements](#12-non-functional-requirements)
13. [Security and access control](#13-security-and-access-control)
14. [Architecture](#14-architecture)
15. [Legal data sources and corpus](#15-legal-data-sources-and-corpus)
16. [Delivery plan](#16-delivery-plan)
17. [Risks](#17-risks)
18. [Deferred decisions (P2 register)](#18-deferred-decisions-p2-register)
- [Appendix A — Changes from Deliverable II](#appendix-a--changes-from-deliverable-ii)
- [Appendix B — Glossary](#appendix-b--glossary)

---

## 1. Problem and product

### 1.1 Problem

A lawyer in Pakistan preparing a matter collects statutes, amendments and judgments from several official portals and connects them by hand. AI legal assistants exist, but language models fabricate or misattribute legal authorities. Published studies report hallucination rates of 58–88% on verifiable legal questions (Dahl et al., 2024), and retrieval-based commercial tools still produce misgrounded answers (Magesh et al., 2025). The Pakistani tools the team reviewed (Pakistan Law Bot, BAHAQ, QanoonMate, QanoonAI) ground their answers in local law. None of them lets the user **verify that grounding at the moment of reliance**, **see how authorities relate**, or **see how a provision has changed over time**.

### 1.2 Product

CaseGuard AI is a verifiable research and drafting workspace for Pakistani civil and criminal law. Every legal claim it shows has three properties:

- the claim carries a citation;
- the citation is checked against an official source;
- the check result is shown as a visible status with a last-verified date.

The trust information stays attached to the citation as it moves from research into drafting and case work.

> **Positioning:** other legal AI tools ask the user to trust them. CaseGuard AI shows the user *why* a claim can be trusted, or why it can't.

### 1.3 Principles

Every requirement traces to one of these principles.

| Principle | Meaning | Consequence in the build |
|---|---|---|
| **Grounded** | Answers come from retrieved official text, not from model memory. | Hybrid retrieval over a provenance-tracked corpus. The system says "not supported" rather than inventing support. |
| **Transparent** | Each citation shows its verification status, and graph relationships can be inspected. | A trust layer with three statuses plus flags, and inspectable graph edges with provenance. |
| **Honest about currency** | The system shows when it last confirmed a piece of law and flags what may be stale or superseded. | Last-verified dates, stale and overruled flags, and a temporal record of amendments. |

### 1.4 Non-goals

- CaseGuard AI does **not** give legal conclusions, file documents or act on the user's behalf. It assists a lawyer.
- No jurisdictions other than Pakistan.
- No live multi-agent mock trial, e-signature, billing or 3D graph.
- No autonomous rewriting of legal records. Uncertain graph updates escalate to a human.
- No scraping of login-gated, paywalled or robots-disallowed sources (§15).

---

## 2. Users and roles

| Role | Who | Can do |
|---|---|---|
| **User** | An advocate or legal researcher. The Deliverable II roles *Lawyer* and *Researcher* are merged, because their permissions differed only by case access. | Everything except administration: research, cases, documents, drafting, linting, own settings and own model keys |
| **Admin** | The operator of the deployment | Everything a User can do, plus configuring AI access and enabled models, running evaluations and viewing system audit records |

- **Account context:** P0/P1 support **individual accounts only**. Every case and document has exactly one owning user. Organisation (tenant) accounts are P2 (§18). The schema keeps an `account_id` on owned rows from day one, so adding tenants later needs no migration.
- **Language:** users work in **English or Urdu** (including Roman Urdu) (§8.3).

---

## 3. Goals and success measures

### 3.1 Objectives

These come from the proposal and Deliverable II. They are unchanged except where noted.

| ID | Objective | Priority |
|---|---|---|
| O1 | Answer legal questions from verified Pakistani statutes and case law, not from model memory | P0 |
| O2 | Represent relationships between legal entities in a graph that takes part in retrieval | P0 |
| O3 | Keep historical versions and amendment events without deleting superseded records | P0 |
| O4 | Return the version of a provision in force at a given date, **for the curated section set** (§10) | P0 |
| O5 | Show, for every citation, whether it was verified against a source document and when | P0 |
| O6 | Check drafted documents against Pakistani procedural filing requirements (bail application, plaint) | P1 |
| O7 | A case-aware workspace where trust information stays attached across modules | P1 |
| O8 | Evaluate retrieval and answer quality reproducibly (RAGAS + guardrails + citation checks) | P0 |
| O9 | Protect user data and allow free-tier, user-keyed and **locally hosted** models interchangeably | P0 |
| O10 | *(new)* Serve Pakistani users in **Urdu and English**, in both the interface and the conversation | P1 |

### 3.2 Success measures

No numbers are claimed until measured. These are the measures the project commits to *reporting*.

| Measure | Target | Source |
|---|---|---|
| Unflagged incorrect citations reaching the user (held-out set) | **0** (target; reported as a count) | §11 |
| RAGAS context precision / context recall / faithfulness / answer relevance | Reported for B0, B1, B2 and Full; Full must beat B1 on faithfulness | §11 |
| Citation correctness on the held-out set | Reported per configuration | §11 |
| "Not supported" behaviour on unanswerable questions | ≥ 90% of unanswerable questions answered as "not supported" | §11 |
| Cross-case and cross-user retrieval leakage | **0** marker leaks (release-blocking) | §13 |
| Trust-status consistency across modules | **0** mismatches in the automated check | `FR-TRUST-10` |

---

## 4. Scope and priorities

### 4.1 Priority tiers

The tiers set the **order of work**, not a cut list. The team aims to finish P0 and a thin P1 by December (§16), with P2 following.

| Tier | Meaning |
|---|---|
| **P0** | The research core. Without it the project has no thesis. Built first and never cut. |
| **P1** | The workspace around the core. Delivered in thin form by December and deepened after. |
| **P2** | Stretch work and deferred decisions. Each has a proposed default (§18). |

### 4.2 Module map

| Module | Priority | Notes |
|---|---|---|
| Data collection (civil + criminal corpus) | **P0** | Existing collector, extended (§15) |
| Chunking, embeddings, indexes | **P0** | |
| Hybrid retrieval + fusion + reranking | **P0** | |
| Research Hub (conversational, cited answers) | **P0** | |
| Citation Verification / Trust Layer | **P0** | Cross-cutting (§7) |
| Knowledge graph (citation + amendment edges, GraphRAG) | **P0** | Postgres system of record (§9) |
| Temporal layer, option (b) | **P0** | Amendment events + curated versions (§10) |
| Evaluation harness (CLI, RAGAS, baselines, guardrails) | **P0** | The dashboard UI is P2 |
| Auth, User/Admin roles, settings, model keys, AI-access config | **P0** | Enough to run the system securely |
| Model abstraction (free-tier + local + user keys) | **P0** | |
| i18n/RTL-ready frontend shell | **P0** | Strings externalised from day one |
| Audit trail | **P0** | |
| Cases + Case Dashboard | **P1** | |
| Document upload + ingestion (PDF/DOCX/scan, English) | **P1** | |
| Precedent Intelligence (search + relationship view) | **P1** | The engine is P0 (graph); this is the UI |
| Drafting Studio (bail application, plaint, legal notice) | **P1** | |
| Procedural Linter (bail application, plaint) | **P1** | |
| Urdu UI translation + EN/UR toggle | **P1** | |
| Urdu / Roman-Urdu conversation flow | **P1** | §8.3 |
| Dashboard, notifications | **P1** | Minimal |
| Strategy Builder | **P2** | |
| Opposition Stress-Test | **P2** | |
| Opponent Claims Analysis | **P2** | |
| Evaluation Dashboard UI | **P2** | Results come from the CLI until then |
| Organisation accounts and sharing | **P2** | |
| Urdu OCR and Urdu statute texts | **P2** | |
| Full automatic temporal reconstruction, option (c) | **P2** | |
| Desktop app (thin client + local LLM) | **P2** | P0 constraints are in `NFR-16`–`NFR-19` |
| Fine-tuning (LoRA/QLoRA) | **P2** | Optional |

---

## 5. Current baseline

Status is **evidenced status only**: it describes what exists in a repository and runs.

| Component | Status | Evidence |
|---|---|---|
| Research, proposal, competitor review | Done | Proposal and Deliverable II |
| Data collector | **Partial** | [`CaseGuard-AI/data_collector`](https://github.com/CaseGuard-AI/data_collector): Pakistan Code, SHC and FSC scrapers with 116 tests and provenance-first design. The only stored run is a demo of **3 statutes**. SCP is scaffolded and unproven. LHC is disabled (robots.txt). No Urdu extraction. |
| Frontend | **Mock prototype** | [`CaseGuard-AI/high_level_design`](https://github.com/CaseGuard-AI/high_level_design): Lovable-generated TanStack Start + Vite app with 17 routes, mock data and no backend. A visual reference for the Next.js rebuild. |
| Figma low-level design | In progress | External |
| Express API, FastAPI AI service, retrieval, graph, temporal, trust layer, evaluation, auth, deployment | **Not started** | — |

---

## 6. Functional requirements

Criteria marked **T** are verified by test, **D** by demonstration, and **I** by inspection.

### 6.1 Authentication, settings and administration

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-AUTH-1 | P0 | Register, sign in, sign out, password reset | **T** Full flow works. Invalid credentials create no session. |
| FR-AUTH-2 | P0 | Roles **User** and **Admin** | **T** A role outside the set is rejected. Admin-only endpoints return 403 to Users. |
| FR-AUTH-3 | P0 | Admin enables or disables AI features per user and selects enabled model providers | **T** With AI disabled, every AI endpoint returns 403 for that user. |
| FR-AUTH-4 | P0 | Default-deny access: a user reaches only their own cases, documents and saved work | **T** For each resource type, a non-owner gets 403/404 with no content. |
| FR-AUTH-5 | P0 | Every owned row carries `owner_user_id` and `account_id` | **I** Schema inspection. No orphan rows. |
| FR-SET-1 | P0 | User settings: language (EN/UR), default model, theme | **D** A change persists across sessions. |
| FR-SET-2 | P0 | Users may add their own API keys and choose among enabled models | **T** Keys are encrypted at rest, never returned and never logged. The model used is in the audit record. |
| FR-NOT-1 | P1 | Notifications for document processing complete/failed and long jobs | **D** |
| FR-DASH-1 | P1 | Dashboard of recent research, cases and drafts | **D** It shows only the user's own items. |

### 6.2 Research Hub

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-RES-1 | P0 | Ask a legal question in natural language (English, Urdu, Roman Urdu; Urdu is P1) | **D** |
| FR-RES-2 | P0 | Hybrid dense + sparse retrieval | **T** The trace records both ranked lists before fusion. |
| FR-RES-3 | P0 | Graph expansion and constraint step (§9.3) | **T** On graph-dependent test questions, results differ with the graph step disabled. The trace records the step. |
| FR-RES-4 | P0 | Cross-encoder reranking before generation | **T** The order passed to generation follows the reranker scores. |
| FR-RES-5 | P0 | The answer carries citations for each legal claim | **T** Uncited legal claims are counted and reported by evaluation. |
| FR-RES-6 | P0 | Every citation is verified before the answer is shown (§7) | **T** No answer reaches the UI without a status for every citation. |
| FR-RES-7 | P0 | Each citation opens its source record and the official public URL. Third-party and head-note-only sources are labelled. | **D** |
| FR-RES-8 | P0 | Conversations continue with context and are saved. **P1:** they can be saved to a case. | **D/T** |
| FR-RES-9 | P0 | When the corpus doesn't support an answer, the system says so and gives no citation from outside the corpus | **T** Unanswerable test questions (§11) |
| FR-RES-10 | P0 | *(new)* Quoted statute and judgment text is always shown in the **original language of the source**, never machine-translated | **T** Quoted spans match the source chunk byte for byte. |
| FR-RES-11 | P0 | *(new)* The user can choose "law as of date D" for questions that touch curated sections (§10) | **T** See `FR-TEMP-5`. |

### 6.3 Trust and verification

The full rules are in §7.

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-TRUST-1 | P0 | AI legal output carries citations | As `FR-RES-5` |
| FR-TRUST-2 | P0 | Every citation gets a stored verification record | **T** |
| FR-TRUST-3 | P0 | A support check tests whether the cited passage supports the claim | **T** Agreement with labelled claim–citation pairs is reported. |
| FR-TRUST-4 | P0 | Exactly one status per citation: **Verified / Needs review / Unverified** (§7.2) | **T** A scan finds no citation with zero or several statuses. |
| FR-TRUST-5 | P0 | Last-verified timestamp stored and shown next to the citation | **T** |
| FR-TRUST-6 | P0 | Stale flag when last-verified is older than the review window (default 180 days, configurable) | **T** |
| FR-TRUST-7 | P0 | Flag authorities that are amended, repealed, overruled or in conflict according to the graph | **T** For a test pair A→(overruled by)→B, citing A shows the flag. |
| FR-TRUST-8 | P0 | Insufficiently verified material is never shown as Verified | **T** |
| FR-TRUST-9 | P0 | Deterministic checks run first, and model checks cannot override a deterministic failure | **T** |
| FR-TRUST-10 | P0 | The status is identical wherever the citation is displayed (single trust store) | **T** An automated cross-module comparison finds 0 mismatches. |
| FR-TRUST-11 | P1 | A flagged item can be sent to human review. Unflagged items never block. | **D** |
| FR-TRUST-12 | P0 | AI audit trail (§13.3) | **T** Every AI interaction has an audit record. |

### 6.4 Knowledge graph and precedents

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-GRAPH-1 | P0 | *(new)* Build citation edges (judgment→statute section, judgment→judgment) from collector metadata and regex extraction, with provenance on every edge | **T** For a sample with known citations, the edges include them. |
| FR-GRAPH-2 | P0 | *(new)* Build amendment edges (amending act→section) for the seed statutes (§10) | **T** |
| FR-PREC-1 | P1 | Precedent search UI | **D** |
| FR-PREC-2 | P0 | Typed relationships per the P0 taxonomy (§9.2) | **T** |
| FR-PREC-3 | P0 | Graph-derived precedents are returned and labelled as graph-derived | **T** |
| FR-PREC-4 | P1 | Inspect a precedent's relationships with provenance and status | **D** |
| FR-GRAPH-3 | P1 | *(new)* Graphiti experiment on a corpus subset, compared with the Postgres graph (§9.4) | **A** A comparison is written up. |

### 6.5 Temporal

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-TEMP-1 | P0 | Superseded versions are never deleted. Each version has valid-from, valid-to and recorded-at. | **T** |
| FR-TEMP-2 | P0 | Record amendment, substitution, insertion, omission and repeal events with source provenance | **I/T** |
| FR-TEMP-3 | P0 | Each version is marked current or historical consistently with its validity | **T** |
| FR-TEMP-4 | P0 | Temporal records carry verification status and last-verified date | **I** |
| FR-TEMP-5 | P0 | **As-of-date query for curated sections:** return the version in force on date D, with its validity period and the amendments between it and today | **T** For each curated section, a date before and after each amendment returns the correct version. |
| FR-TEMP-6 | P0 | For dates outside recorded coverage, or for non-curated sections, the system says what it does and doesn't know | **T** It never returns current text labelled as historical. |
| FR-TEMP-7 | P2 | Overruling effects on answers; date filtering applied to all retrieval | See §18 |

### 6.6 Cases and documents (P1)

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-CASE-1 | P1 | Create, edit, list and archive cases (fields as in Deliverable II, Table 4.29) | **D/T** |
| FR-CASE-4 | P1 | The Case Dashboard links the case's documents, research, drafts and precedents | **D** |
| FR-CASE-5 | P1 | Save research, drafts and lint reports to a case | **T** |
| FR-CASE-6 | P0 | Retrieval scope = the public corpus + **only the case in use**. Other cases of the same user are included only on explicit selection. Other users' data is never retrievable. | **T** Marker-document test. A failure blocks release. |
| FR-DOC-1 | P1 | Accept PDF, DOCX and image/scanned files; reject others; enforce a size limit (default 25 MB) | **T** |
| FR-DOC-2 | P1 | Process uploads asynchronously: OCR where needed (English) → extract → clean → structure → chunk → embed → index | **D** Each stage outcome is logged. |
| FR-DOC-3 | P1 | Show processing status (queued / processing / done / flagged / failed) | **T** |
| FR-DOC-4 | P1 | Flag uncertain OCR or extraction. Never show it as clean. | **T** |
| FR-DOC-6 | P1 | Processed documents become retrievable within the owner's scope only | **T** |

### 6.7 Drafting and linting (P1)

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-DRAFT-1 | P1 | Templates: **bail application (s.497/498 CrPC)**, **plaint (Order VII CPC)**, **legal notice** | **D** |
| FR-DRAFT-2 | P1 | Fill from case fields when a case is selected; drafting also works without a case | **D** |
| FR-DRAFT-3 | P1 | AI-assisted section drafting. Any citation inserted goes through the trust layer. | **T** |
| FR-DRAFT-4 | P1 | Edit, save and export (DOCX/PDF) | **D** |
| FR-LINT-1 | P1 | Rule sets for **bail application** and **plaint**: required sections, required particulars and structure | **T** Seeded-defect documents produce the matching findings. |
| FR-LINT-2 | P1 | Each finding cites its rule source (CrPC/CPC provision or court rule) or says none was identified | **I** |
| FR-LINT-3 | P1 | The linter never modifies the document | **T** The document is byte-identical after linting. |

### 6.8 Evaluation

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-EVAL-1 | P0 | A CLI evaluation run computes RAGAS context precision, context recall, faithfulness and answer relevance per question and in aggregate | **T** A re-run reproduces the results within judge variance. |
| FR-EVAL-2 | P0 | Guardrail suite (legal-ethics prompts, prompt injection, out-of-scope requests) with per-item results | **T** |
| FR-EVAL-3 | P0 | Evaluation is Admin-only | **T** |
| FR-EVAL-4 | P0 | Runs are stored with their full configuration and are comparable (resolves TBD-8) | **T** |
| FR-EVAL-6 | P0 | **Citation correctness** is a formal metric (resolves TBD-10) | **T** |
| FR-EVAL-5 | P2 | Evaluation Dashboard UI | — |

### 6.9 Language and localisation

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-I18N-1 | P0 | All UI strings are externalised (next-intl). Layouts use logical CSS properties (RTL-safe). | **I** No hard-coded user-facing strings. An RTL smoke test passes. |
| FR-I18N-2 | P1 | Complete Urdu UI translation with an EN/UR toggle, RTL layout and a Nastaliq-capable font | **D** |
| FR-LANG-1 | P1 | Urdu and Roman-Urdu questions are answered in the user's language using the flow in §8.3 | **T** On the Urdu subset of the test set, citations match those of the English equivalents. |
| FR-LANG-2 | P1 | Urdu text renders correctly right-to-left wherever it appears (was `NFR-6`) | **D** |

### 6.10 P2 modules

These are carried from Deliverable II without change. Their requirements (`FR-STRAT-*`, `FR-STRESS-*`, `FR-CLAIM-*`) are as specified in Deliverable II §4.4.5. Each one shall reuse the retrieval and trust layers rather than adding new verification logic.

---

## 7. Trust layer specification

### 7.1 Checks

Each citation goes through three checks, in this order:

1. **Existence (deterministic).** Does the citation resolve to a record in the corpus? This means a statute + section, or a judgment by citation, case number or ID.
2. **Support (model-based).** Does the cited passage support the claim it is attached to? Use a cross-encoder or NLI model first, and the LLM judge only when the first check is inconclusive.
3. **Currency (deterministic).** Look up the last-verified date, temporal status (current/historical) and graph flags (amended, repealed, overruled, conflicting).

### 7.2 Status rules

| Status | Rule |
|---|---|
| **Verified** | Existence passes **and** support passes **and** there is no blocking flag |
| **Needs review** | Existence passes **but** support is uncertain or fails, **or** a blocking flag is present |
| **Unverified** | Existence fails |

**Blocking flags:** `overruled`, `repealed`, `superseded_version` (the citation points to a historical version while the question is about current law), and `conflict`.

**Non-blocking flags** are shown as chips: `stale`, `third_party_source`, `headnote_only`, `amended_since` (still current, but changed after a cited judgment).

- **Single store.** The verification service writes results to one table. Every module reads that table and never recomputes or caches a status. The status shown in the UI is always the stored one.
- **Thresholds.** Support-check thresholds are calibrated on the development set (§11) and versioned with the evaluation configuration.

---

## 8. Retrieval and language specification

### 8.1 Pipeline

```
query ─► language detect ─► (UR/Roman-UR → EN translation for retrieval)
      ─► dense (pgvector) ┐
      ─► sparse (Postgres FTS) ┴─► RRF fusion ─► graph expand/constrain ─► cross-encoder rerank
      ─► top-k chunks ─► generation (answer in user's language, quotes in source language)
      ─► trust layer ─► response + audit record
```

### 8.2 Defaults

These resolve TBD-25 and TBD-19 provisionally. They are tuned on the development set only.

| Parameter | Default |
|---|---|
| Embedding model | Multilingual and locally runnable (e.g. `bge-m3`) |
| Reranker | Multilingual cross-encoder, locally runnable (e.g. `bge-reranker-v2-m3`) |
| Sparse | PostgreSQL native full-text search (`ts_rank_cd`). BM25 is a P2 comparison. |
| Chunking | Statutes by **section**, with long sections split by sub-section. Judgments by paragraph windows of about 400–600 tokens. Chunks never cross a section boundary. |
| Fusion | RRF, `k = 60` |
| Cut-offs | 50 candidates per retriever → 20 after fusion → 5–8 to generation |

Every chunk carries provenance (source, URL, section ID, document ID, `headnote_only`, `third_party`).

### 8.3 Urdu conversation flow (P1)

1. Detect the language: English, Urdu script or Roman Urdu.
2. For Urdu or Roman Urdu, translate the query to English with the configured model. Keep both versions in the audit record.
3. Retrieve with the English query. The dense retriever also receives the original query, because the embeddings are multilingual.
4. Generate the answer in the user's language. **Legal quotations stay verbatim in the source language** (`FR-RES-10`), and legal terms of art may keep the English term in brackets.
5. Run the trust layer on the claims, using the English claim text internally.

---

## 9. Knowledge graph specification

### 9.1 Storage

The graph's system of record is **PostgreSQL** (ADR-0003), which resolves TBD-18 and TBD-22.

- `graph_entities(id, type, ref_table, ref_id, label, …)`
- `graph_edges(id, type, src_entity, dst_entity, valid_from, valid_to, recorded_at, provenance_doc_id, extraction_method, confidence, human_confirmed, verification_status)`
- Traversal uses recursive CTEs with a depth limit of 2 by default.

### 9.2 P0 taxonomy

This resolves TBD-12 for P0.

- **Entities:** `statute`, `section`, `judgment`, `court`, `amendment_act`
- **Edges:** `CITES_SECTION`, `CITES_JUDGMENT`, `AMENDS`, `SUBSTITUTES`, `INSERTS`, `OMITS`, `REPEALS`, `OVERRULES`*, `CONNECTED_CASE`

\* `OVERRULES` edges are created **only** from explicit statements in the source metadata, or with human confirmation. Never from LLM inference alone.

### 9.3 GraphRAG use

1. **Expand:** add judgments that cite a retrieved section, and sections cited by a retrieved judgment.
2. **Constrain:** demote or flag candidates that are linked to a repealing or overruling authority.
3. **Inform:** pass edge flags to the trust layer (§7.2).

Graph-derived candidates are labelled in the trace and in the UI.

### 9.4 Graphiti experiment (P1)

Load a subset into Graphiti on Neo4j (e.g. one statute plus about 500 judgments citing it). Compare it with the Postgres graph on four measures: edge precision against the extracted ground truth, construction cost (LLM calls and time), query latency, and determinism. The result goes into the final report. The production path stays Postgres unless the experiment shows a clear win.

---

## 10. Temporal specification

The P0 scope is **option (b)**, and full reconstruction is P2.

1. **Amendment events.** These apply to every seed statute (§15.3). For each amendment act on Pakistan Code, record which sections it affects, the type of change, the commencement date and the source URL. Where extraction is uncertain, the event is flagged for human confirmation.
2. **Curated versions.** Pick about **20–40 sections** across the civil and criminal seed statutes. Each must have a documented amendment history and be useful for demos and test questions. For each, store the full text of every version with its valid-from and valid-to dates, built from the amending acts and the principal act.
   - *Candidates to verify:* PPC s.489-F; PPC s.376; CrPC s.497; CrPC s.154; CPC s.12 / O.VII; Limitation Act articles commonly used in civil suits.
   - The list is final only after each history has been checked against the amending act texts.
3. **Record-time snapshots.** From now on, each collector re-run that detects a content-hash change in a statute PDF creates a new snapshot with `recorded_at`. Coverage therefore grows automatically over time.
4. **Honest coverage.** The UI marks curated sections with a badge (*"version history available"*). For any other section it states *"current text only; historical versions not recorded"*.

---

## 11. Evaluation specification

The test set resolves TBD-17. **Ground truth must be mechanically checkable, so no domain-expert annotation is needed.**

| Item | Specification |
|---|---|
| Question type | **Extractive**: each question's ground truth is a specific section, sub-section or judgment paragraph in the corpus, plus a reference answer quoting it. Example: "What is the punishment under s.302 PPC?" → PPC s.302. |
| Size | About **60 development + 40 held-out** questions, half civil and half criminal |
| Unanswerable | About **10%** of the questions are outside the corpus, to test `FR-RES-9` |
| Temporal | At least 8 questions use as-of dates on curated sections |
| Urdu | At least 15 questions also have Urdu or Roman-Urdu phrasings (P1) |
| Freeze | The held-out set is frozen and version-tagged **before any tuning**. No question appears in both sets. |
| Configurations | **B0** LLM only · **B1** dense only · **B2** hybrid + RRF + rerank · **Full** = B2 + graph + trust layer |
| Metrics | RAGAS (context precision, context recall, faithfulness, answer relevance), citation correctness, unflagged-incorrect-citation count, "not supported" accuracy, guardrail pass rate, latency per workflow |
| Recorded per run | Model IDs and parameters, prompt versions, corpus snapshot hash, code commit, RAGAS version, judge model |
| Spot check | The team manually checks a 20% sample of judge verdicts |
| Expert review | Open (P2). Interpretive questions wait for a domain reviewer. |

---

## 12. Non-functional requirements

| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| NFR-1 | P0 | Provenance: every corpus record traces to a real source URL. Third-party records are labelled. | **I** |
| NFR-2 | P0 | TLS in transit in deployed environments. Encryption at rest for the database volume and secrets. | **I** |
| NFR-3 | P0 | No case data is used to train external models | **I** |
| NFR-4 | P0 | Zero unflagged incorrect citations (target, measured on the held-out set) | **A** |
| NFR-5 | P0 | Latency is measured and reported per workflow. Seconds-level responses are acceptable, with progress indication for anything over 3 s. | **T** |
| NFR-7 | P0 | Nothing is shown as current without a visible last-verified date | **T** |
| NFR-8 | P0 | Trust-status consistency (= `FR-TRUST-10`) | **T** |
| NFR-9 | P1 | 10 concurrent users running standard workflows with no errors | **T** |
| NFR-10 | P0 | The whole stack runs with `docker compose up`. Cloud deployment comes from the same images. | **D** |
| NFR-11 | P0 | Models are replaceable by configuration only | **D** |
| NFR-12 | P0 | Auditability (= `FR-TRUST-12`) | **T** |
| NFR-13 | P1 | Failed document processing is flagged and retried, never dropped | **T** |
| NFR-14 | P0 | Collection respects robots.txt and site terms. No login, CAPTCHA or paywall bypass. | **T/I** |
| NFR-16 | P0 | **Desktop readiness:** every LLM call goes through an OpenAI-compatible interface, so Ollama, llama.cpp, free-tier cloud APIs and user keys are interchangeable | **D** Switching provider is a config change only. |
| NFR-17 | P0 | **Desktop readiness:** embedding, reranker and NLI models each have a locally runnable option | **D** |
| NFR-18 | P0 | **Desktop readiness:** no hosting-vendor-specific runtime features (e.g. Vercel-only APIs) and no proprietary managed vector store | **I** |
| NFR-19 | P0 | **Desktop readiness:** prompts and the verification pipeline must work on a ~7–8B local model. Evaluation reports a local-model configuration. | **T** |
| NFR-20 | P0 | Test coverage: unit tests for all trust-layer rules and access-control rules, plus integration tests for every API contract | **I** CI gate |

*Deliverable II's NFR-6 (Urdu rendering) is now `FR-LANG-2`. Its NFR-15 (local operation) is replaced by the more specific `NFR-16` to `NFR-19`.*

---

## 13. Security and access control

### 13.1 Rules

- **Default-deny.** Retrieval authorisation is applied **inside** the SQL that fetches candidates. Results are never fetched first and filtered afterwards.
- **Scope.** The access decision is taken in Express. FastAPI receives a signed, already-scoped request: `{user_id, account_id, allowed_case_ids, …}`.
- **Data classes.** The public corpus is available to any signed-in user with AI enabled. A user's own case data is available to that owner only. Other cases of the same user are included only on explicit selection. Other users' data is **never** available.

### 13.2 Requirements

| ID | Pri | Requirement |
|---|---|---|
| SEC-1 | P0 | Passwords hashed with bcrypt/argon2. Sessions use httpOnly, Secure, SameSite cookies holding a short-lived JWT plus a refresh token. |
| SEC-2 | P0 | Role and ownership check on every request |
| SEC-4 | P0 | User API keys encrypted (AES-256-GCM, key from the environment). Never returned or logged. |
| SEC-5 | P0 | No secrets in git. `.env.example` only. CI runs secret scanning. |
| SEC-6 | P1 | Uploads: type and size limits, stored outside the web root, processed off the request path. Malware scanning is P2. |
| SEC-8 | P0 | Tenant isolation: marker documents and marker graph facts never leak across users (release-blocking test) |
| SEC-11 | P0 | Case data goes only to providers that are enabled by the Admin or supplied by the user. Local models keep data on the machine. |
| SEC-14 | P0 | *(new)* FastAPI is not exposed publicly. It accepts only requests that carry the internal service token, on the internal network. |
| SEC-15 | P0 | *(new)* Rate limiting on the auth and AI endpoints |
| SEC-16 | P0 | *(new)* Prompt-injection guard: retrieved and uploaded text is treated as data. The guardrail suite (`FR-EVAL-2`) includes injection cases. |

### 13.3 Audit record

Each AI interaction records the following fields:

- the user;
- the case, if any;
- the query, original and translated;
- the model and provider;
- the retrieved chunk IDs and their provenance;
- the graph context used;
- the citations and their verification results;
- the guardrail results;
- the response;
- the latency;
- the timestamp.

Audit records are append-only.

---

## 14. Architecture

### 14.1 Services

```
                ┌───────────────────────────── public ─────────────────────────────┐
  Browser ───►  │  apps/web  (Next.js, TS, next-intl, shadcn/ui)                    │
                └───────────────┬──────────────────────────────────────────────────┘
                                │  REST /api/v1  (OpenAPI contract: packages/contracts)
                ┌───────────────▼──────────────────────────────────────────────────┐
                │  apps/api  (Node.js + Express, TS)                                │
                │  auth · roles · access decision · cases · documents · uploads ·   │
                │  settings · encrypted keys · notifications · audit writes · jobs  │
                └───────────────┬──────────────────────────────────────────────────┘
                                │  internal REST /ai/v1 + service token (internal network only)
                ┌───────────────▼──────────────────────────────────────────────────┐
                │  services/ai  (Python, FastAPI, LangGraph)                        │
                │  retrieval · graph · temporal · trust layer · model abstraction · │
                │  Urdu flow · drafting/linter AI · ingestion workers · evaluation  │
                └───────────────┬──────────────────────────────────────────────────┘
                                │
   services/collector ──────────►  PostgreSQL 17 + pgvector + FTS   ·   file storage (originals)
   (Python, scheduled runs)        (Neo4j only for the Graphiti experiment)
```

### 14.2 Ownership rules (ADR-0002)

- **Express owns** every user-facing concern and the access decision. FastAPI has **no user authentication**. It only trusts the service token plus the scope that Express passes in.
- **One database, separate schemas.** `app` is owned by Express: users, cases, documents, drafts, settings, audit. `corpus` and `ai` are owned by FastAPI and the collector: legal documents, chunks, embeddings, graph, temporal versions, verifications, evaluation runs. A service never writes another service's schema. It may read through views that are explicitly granted.
- **Migrations.** Each schema has exactly one migration tool: Prisma or Drizzle for `app` (chosen by Stream A), and Alembic for `corpus` and `ai`.
- **Contracts first.** `packages/contracts` holds the OpenAPI specs for `/api/v1` and `/ai/v1`. The frontend and API are built against the contract, using generated clients and mocks, so the streams can work in parallel.

### 14.3 Technology stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router), TypeScript, Tailwind, shadcn/ui ported from the prototype, next-intl, TanStack Query |
| API | Node.js LTS, Express, TypeScript, Zod validation, Pino logging |
| AI service | Python 3.12, FastAPI, LangGraph (static pipelines), LangChain retrievers, RAGAS, `uv` |
| Data | PostgreSQL 17 + pgvector, Postgres FTS |
| Jobs | A Postgres-backed queue (e.g. pg-boss) for ingestion and evaluation jobs. Redis only if it's later needed. |
| Models | An OpenAI-compatible gateway layer. Free tiers (e.g. Gemini, Groq, OpenRouter free models), Ollama locally, and user-supplied keys. |
| Infra | Docker Compose (dev); container images built in CI; cloud provider deferred |
| Tooling | pnpm workspaces (JS), uv (Python), GitHub Actions, Conventional Commits |

---

## 15. Legal data sources and corpus

### 15.1 Source policy

A source is **ingested** only if all four of these hold:

1. It is official, or an established free public-legal-information service.
2. It is free.
3. It needs no login.
4. Its robots.txt and terms allow automated access.

Sources that need a login or payment are **never** scraped. They may be used manually to spot-check citations.

### 15.2 Source register

Checked on 10 Oct 2026. *Collector-verified* means a scraper exists and has been tested. *Web-confirmed* means the site was confirmed to be public, but its robots.txt and terms still need checking before a scraper is written.

**Tier 1: ingest now (P0)**

| Source | Content | Access | Status |
|---|---|---|---|
| [Pakistan Code](https://pakistancode.gov.pk) (Ministry of Law & Justice) | Federal statutes, ordinances and amendment acts (PDF) | Free, no login | Collector-verified |
| [Sindh High Court caselaw](https://caselaw.shc.gov.pk) | About 70k judgments with rich metadata (citations, parties, bench, connected cases) | Free, no login | Collector-verified. **Filter to civil and criminal matter types.** |
| [Supreme Court of Pakistan](https://www.supremecourt.gov.pk) | Judgments (PDF) | Free, no login; bot protection observed | Scraper scaffolded. Run `--probe` from the team's network, or use `--ingest-dir` for hand-downloaded PDFs. |

**Tier 2: next sources (P1/P2)**

| Source | Content | Access | Status |
|---|---|---|---|
| [Punjab Code / Punjab Laws Online](http://punjabcode.punjab.gov.pk) | Punjab Acts and rules since 1860, plus Urdu translations | Free | Web-confirmed |
| [Sindh Code](https://www.sindhlaws.gov.pk) | Sindh laws (English/Urdu/Sindhi), with civil and criminal categories | Free | Web-confirmed |
| [Islamabad High Court](https://www.ihc.gov.pk) | Judgments | Free | Web-confirmed (site); scraper not built |
| [Peshawar High Court](https://www.peshawarhighcourt.gov.pk) | Judgments from about 2010 | Free | Web-confirmed (site); scraper not built |
| [Balochistan High Court](https://bhc.gov.pk) | Reported judgments by judge and year, all benches | Free | Web-confirmed |
| [National Assembly](https://na.gov.pk) / [Senate](https://senate.gov.pk) | Bills and Acts as passed | Free | Identified |
| [Federal Shariat Court](https://www.federalshariatcourt.gov.pk) | Leading judgments | Free | Collector-verified. **Not in the P0 civil/criminal scope.** |

**Tier 3: gated (do not scrape)**

| Source | Reason | Use |
|---|---|---|
| [Lahore High Court](https://www.lhc.gov.pk) | robots.txt disallows automated access, and the site requires prior permission to download | **Action: email the LHC for research permission now.** Ingest only once permission is granted. |
| [Pakistan Law Site](https://www.pakistanlawsite.com) (PLD Publishers: PLD, SCMR, CLC, PCrLJ, YLR …) | Paid subscription, login | Manual spot-checks only |
| Other paid databases (e.g. LEAP Pakistan, Eastlaw) | Paid, login | Manual spot-checks only |

**Discovery only: not a citable source**

- Unofficial aggregators of judgments of unclear provenance, such as `pakcaselaw.duckdns.org`. They may be used to find what exists, but CaseGuard always cites the official court URL.
- Hugging Face datasets (Deliverable II, Table 4.31). These are bootstrap and coverage checks only, flagged `third_party`, as the collector already enforces.

### 15.3 Seed corpus (P0)

| Area | Statutes | Judgments |
|---|---|---|
| **Criminal** | Pakistan Penal Code 1860; Code of Criminal Procedure 1898; Qanun-e-Shahadat Order 1984; their amendment acts | SHC criminal matter types (start with about 3–5k), SCP where available |
| **Civil** | Code of Civil Procedure 1908; Contract Act 1872; Specific Relief Act 1877; Limitation Act 1908; their amendment acts | SHC civil matter types (start with about 3–5k), SCP where available |
| **Shared** | Constitution of Pakistan 1973: fundamental rights and court-jurisdiction articles | — |

The collector stays source-agnostic. Adding an area of law means a configuration change plus new test questions, not new architecture.

---

## 16. Delivery plan

### 16.1 Workstreams

Owners will be assigned later.

| Stream | Owns | Key interfaces |
|---|---|---|
| **A: Product** | `apps/web` (Next.js rebuild, i18n/RTL, all screens), `apps/api` (auth, roles, cases, documents, uploads, settings, keys, notifications, audit writes, jobs) | Implements `/api/v1`; consumes `/ai/v1` |
| **B: Knowledge** | `services/collector` (civil + criminal runs, SCP probe, amendment acts), chunking, embeddings, indexes, hybrid retrieval, Postgres graph, temporal (b) curation, Graphiti experiment | Writes the `corpus` schema; exposes retrieval functions to C |
| **C: Trust & AI** | `services/ai` (FastAPI, LangGraph pipelines, model abstraction, trust layer, Urdu flow, drafting/linter AI, ingestion workers), evaluation harness and test set | Implements `/ai/v1`; writes the `ai` schema |

### 16.2 Milestones

These are outcome-based, with no fixed dates. The target is **M1–M3 by December 2026**.

| Milestone | Definition of done |
|---|---|
| **M0: Foundation** (week 1–2) | Monorepo, CI and branch protection live. Both OpenAPI contracts drafted. `docker compose up` brings up Postgres + skeleton services. Collector imported into `services/collector`. ADRs accepted. |
| **M1: Vertical slice** | Seed statutes + a first batch of SHC judgments ingested → hybrid retrieval → Research Hub answers in English with citations → existence check + status shown → audit record written. Auth works. The held-out test set is **frozen**. |
| **M2: P0 complete** | Support check + full status rules + flags. Graph edges + GraphRAG. Temporal (b) for curated sections with the as-of-date query. Model abstraction with one free-tier and one local model. Evaluation run for B0/B1/B2/Full, with the first results recorded. |
| **M3: Thin P1 (December target)** | Cases + upload/ingestion. Precedent search UI. Drafting (3 templates). Linter (bail application first, then plaint). Urdu UI + Urdu Q&A. Leakage tests green. Deployed demo environment. |
| **M4: Depth + P2** | Graphiti experiment written up, plaint linter complete, P2 modules (Strategy → Stress-Test → Opponent Claims), Evaluation Dashboard UI, final evaluation on the held-out set, final report. |

**Cut order if behind schedule:** drafting → linter → precedent UI → document upload. **The trust layer and the evaluation run are never cut.**

### 16.3 Engineering process

The process is defined in [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`docs/engineering/branching-and-release.md`](engineering/branching-and-release.md):

- `main` (released) ← `staging` (integration) ← `feature/*` branches
- Pull request reviews and CI gates on every merge
- Conventional Commits
- Semantic-versioned releases

A requirement is **done** when four things are true:

1. Its acceptance criterion passes, in CI where it is testable.
2. It is merged to `staging`.
3. It is documented where user-visible.
4. Its ID appears in the PR description.

---

## 17. Risks

| Risk | Mitigation |
|---|---|
| December scope is large for 3 people alongside coursework | Tiered scope, contract-first parallel streams, an explicit cut order, and a vertical slice first |
| Sources change markup or block bots | Provenance-first collector with fixture tests, a probe mode, and a manual `--ingest-dir` fallback |
| Free-tier rate limits and quota changes | Model abstraction with several providers plus a local model, caching of embeddings, and batch evaluation runs |
| Local 7–8B models are weak at verification and Urdu | NLI/cross-encoder support check first, LLM only as fallback, and a local configuration measured in evaluation (`NFR-19`) |
| Wrong `OVERRULES` or amendment edges | Edges only from explicit metadata or with human confirmation, and provenance on every edge |
| Temporal curation takes longer than expected | A capped list (20–40 sections). Coverage is stated honestly in the UI. |
| Cross-user leakage | Authorisation applied inside the SQL, plus marker tests that block release |
| Evaluation judged by an LLM is imperfect | Extractive ground truth, citation correctness measured deterministically, and a 20% manual spot check |
| Two backends drift apart | Shared OpenAPI contracts, contract tests in CI, and strict schema ownership |

---

## 18. Deferred decisions (P2 register)

Each open decision from Deliverable II is either resolved here or deferred to P2 with a proposed default.

| TBD | Decision | Resolution / proposed default |
|---|---|---|
| TBD-1 | Date-specific historical research | **Resolved (P0)** for curated sections (§10). General coverage is P2 via option (c). |
| TBD-2 | Effect of overruling | P2. Default: overruled precedents stay retrievable but are flagged **Needs review**, and are never silently dropped. |
| TBD-3 | Does the date filter retrieval? | P2. Default: the date filters only curated-section versions; general retrieval is unfiltered and flagged. |
| TBD-4 | Contradictory authorities in strategy | P2. Default: show both with their flags; never auto-resolve. |
| TBD-5 | Citations in stress-test output | P2. Default: same trust chips as in research. |
| TBD-6 | Opponent Claims ↔ Strategy | P2. Default: extracted claims become optional strategy inputs. |
| TBD-7 | Draft version history | P1-lite: a version saved on each explicit save. Diffs are P2. |
| TBD-8 | Persist evaluation runs | **Resolved (P0)**: stored with their full configuration |
| TBD-9 | Evaluation Dashboard | P2. CLI and Markdown reports until then. |
| TBD-10 | Citation correctness metric | **Resolved (P0)**: adopted |
| TBD-11 | Production models | Default: a free-tier cloud model for generation, a local model for the local configuration, and a local NLI/cross-encoder for support checks. Final choice after evaluation. |
| TBD-12 | Graph taxonomy | **Resolved (P0)** for the §9.2 set. Interpretation edges are P2. |
| TBD-13 | Thresholds and review window | **Resolved**: a 180-day window. Support thresholds are calibrated on the development set. |
| TBD-14 | Cross-case selection UI | P1. Default: a multi-select "include other cases" control in the research composer. |
| TBD-15 | Classes needing human review | Default: `OVERRULES` edges, uncertain amendment events, and failed support checks the user disputes |
| TBD-16 | Latency targets | Measure first. Set targets after M2. |
| TBD-17 | Test set design | **Resolved** (§11) |
| TBD-18 | Graph engine | **Resolved**: Postgres. Neo4j is for the experiment only. |
| TBD-19 | FTS vs BM25 | Postgres FTS (P0). BM25 comparison is P2. |
| TBD-20 | AI-access granularity | **Resolved**: per user, plus a provider allow-list |
| TBD-21 | Malware scan and size limits | 25 MB limit (P1). Malware scanning (ClamAV) is P2. |
| TBD-22 | System of record for relationships | **Resolved**: Postgres |
| TBD-23 | Corpus refresh scheduling | P1. Default: a weekly scheduled collector job (cron in the deployment) plus manual trigger. |
| TBD-24 | Case-form validation | P1. Defined with the case screen. |
| TBD-25 | Models and parameters | Defaults in §8.2, tuned on the development set |
| *new* | Domain-expert reviewer | P2. Needed for interpretive test questions. |
| *new* | Organisation accounts | P2. The schema is already account-ready. |
| *new* | Desktop app packaging (Tauri or Electron) | P2. Thin client + local LLM (ADR-0005). |
| *new* | Urdu OCR and Urdu statute ingestion | P2 |

---

## Appendix A — Changes from Deliverable II

| # | Change | Why | Report sections affected |
|---|---|---|---|
| 1 | The scope is tiered P0/P1/P2. Strategy, Stress-Test, Opponent Claims and the Evaluation Dashboard UI move to P2. | Returns to the approved proposal's core, and fits 18 modules to a 3-person team | 1.6, 4.3, 4.12, 5.1.2 |
| 2 | Status is evidence-based only ("Implemented" → mock prototype) | A build plan must start from what actually exists | 4.12, Exec. Summary |
| 3 | Corpus narrowed to **civil + criminal** law, with the architecture kept domain-agnostic | Makes the test set, temporal curation and linter rules feasible | 1.6, 4.9.2, 5.2 |
| 4 | FSC removed from P0. SCP probe and LHC permission request added as actions. | FSC is Shariat jurisdiction, outside civil/criminal | 4.9.2, Table 4.30 |
| 5 | Graph system of record is **Postgres**. Graphiti becomes a comparative experiment. | Citation edges are already structured, and LLM graph extraction at 10k+ judgments is costly and nondeterministic | 3.9–3.10, 5.6, 6.7, App. A |
| 6 | "Arguable" renamed **Needs review**, with computable rules (§7.2) | "Application is arguable" cannot be computed | 2.5, Table 2.1, 5.8 |
| 7 | Temporal scope is option (b): amendment events + curated versions + snapshots | Pakistan Code serves only current consolidated text | 5.7, 6.8, O4 |
| 8 | Roles: Lawyer + Researcher merged into **User**. Organisation accounts move to P2. | Identical permissions apart from case ownership | 1.8, 4.2 |
| 9 | **Urdu** is a first-class feature: UI + conversation (P1), OCR (P2) | The users are Pakistani | 1.6.2 (voice still out), NFR-6 |
| 10 | Desktop app with a bundled local LLM added as a future target, with P0 constraints | Product direction | 5.14, 6.15 |
| 11 | Free-tier and local models first, behind an OpenAI-compatible abstraction | Budget and desktop target | 6.13, AIM-1–7 |
| 12 | Test set made extractive and mechanically checkable, with no expert annotation | Defensible without a lawyer's time | 5.11 |
| 13 | TBD-8, 10, 12, 13, 17, 18, 20 and 22 resolved | Needed to build P0 | 4.11 |
| 14 | Strict Express/FastAPI boundary. FastAPI is internal-only. | One place for auth and access decisions | 6.2.3, 6.3 |
| 15 | Frontend rebuilt in Next.js, porting the prototype's components | Agreed stack. The prototype is TanStack/Vite. | 6.1, Table 6.1 |
| 16 | Monorepo with main/staging/feature branching, CI gates and ADRs | Team process | — |

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| **Chunk** | A citable unit of text (a statute section or judgment paragraph window) with embedding and provenance |
| **Provenance** | The traceable origin of a record: source, URL, file and content hash |
| **Valid time / record time** | When a legal fact held in the world / when the system recorded or verified it |
| **RRF** | Reciprocal Rank Fusion: merges ranked lists using 1/(k + rank) |
| **GraphRAG** | Retrieval in which graph relationships expand or constrain the candidates |
| **Curated section** | A section whose full version history is recorded (§10) |
| **B0/B1/B2/Full** | The evaluation configurations (§11) |
