# Screenshots

Proof that each built feature works, one PNG per screen. The images are made by a repeatable
Playwright script (`scripts/screenshots/capture.ts`), never by hand, so they can be regenerated
after any UI change (#239).

| Image | Feature | FR-ID | What it proves |
| --- | --- | --- | --- |
| `01-login.png` | Sign in | FR-AUTH-1 | The sign-in screen renders, with the forgot-password and register links. |
| `02-register.png` | Register | FR-AUTH-1, FR-AUTH-2 | Self-registration as a Lawyer or Researcher; Admin can't be chosen. |
| `03-dashboard-recent-research-cases-drafts.png` | Dashboard | FR-DASH-1 | The signed-in user's own recent research, cases and drafts. |
| `04-cases-list.png` | Cases list | FR-CASE-1 | The user's cases, with the seeded case listed. |
| `05-case-new.png` | New case | FR-CASE-1 | The case form with the fields of Deliverable II, Table 4.29. |
| `06-case-dashboard.png` | Case dashboard | FR-CASE-4, FR-CASE-5 | One case linking its research, documents, drafts and lint reports. |
| `07-research-answer-with-citations.png` | Research answer | FR-RES-1, FR-RES-5, FR-RES-6 | An answer whose citations each carry a verification status. |
| `08-research-history.png` | Research history | FR-RES-8 | Saved conversations, including the one saved to the case. |
| `09-precedent-search-results.png` | Precedent search | FR-PREC-1, FR-PREC-3 | Judgment hits, with graph-derived ones labelled as such. |
| `10-precedent-relationships.png` | Precedent relationships | FR-PREC-2, FR-PREC-4 | A judgment's typed relationships with provenance and status. |
| `11-drafting-templates.png` | Drafting studio | FR-DRAFT-1, FR-DRAFT-2 | The templates, and the seeded draft started from a case. |
| `12-draft-editor-ai-assist.png` | Draft editor with AI assist | FR-DRAFT-3, FR-DRAFT-4 | A section drafted by AI, with its citations checked by the trust layer. |
| `13-linter-findings.png` | Procedural linter | FR-LINT-1, FR-LINT-2, FR-LINT-3 | Findings for a bail application, each with its rule source. |
| `14-lint-report-saved-to-case.png` | Lint report on a case | FR-CASE-5 | The lint report listed on the case it was saved to. |
| `15-documents-list.png` | Documents | FR-DOC-1, FR-DOC-3 | An uploaded PDF and its processing status. |
| `16-settings-models-keys.png` | Settings | FR-SET-1, FR-SET-2 | Language, theme, default model and the user's own API keys. |
| `17-admin-console.png` | Admin console | FR-AUTH-2, FR-AUTH-3 | The Admin-only console: users' AI access and model providers. |
| `18-urdu-rtl-dark.png` | Urdu, right-to-left, dark theme | FR-I18N-2, FR-LANG-2, FR-SET-1 | The dashboard in Urdu with an RTL layout and the dark theme. |
| `19-sidebar-soon-badges.png` | Sidebar | FR-EVAL-3 | P2 screens (Strategy, Stress-Test) carry a "Soon" badge; Evaluation sits under Admin. |

## Prerequisites

1. The full stack is running: `pnpm dev` (web on `:3000`, api on `:4000`, ai on `:8000`) with a
   migrated database (`pnpm db:migrate`, `pnpm db:migrate:ai`).
2. For 07, 09, 10, 12 and 15, the corpus is loaded (`pnpm data:pull -- --dump latest`), the graph
   is built (`pnpm ai:graph-build`) and a model provider is configured in `.env`. Without them those
   screens are skipped (see below), and the rest are still captured.
3. Chromium for Playwright 1.65.0 (build 1254). It is reused from `%LOCALAPPDATA%\ms-playwright`
   when present; otherwise run `pnpm exec playwright install chromium` once.
4. The Admin console (17). By default the script registers a second throwaway user and promotes it
   with `pnpm db:create-admin --email <email>`, which promotes an existing user without a password
   prompt. That needs the api's database settings in `.env`. To use an existing Admin instead, set
   `SCREENSHOTS_ADMIN_EMAIL` and `SCREENSHOTS_ADMIN_PASSWORD`.

Each run registers a new throwaway Lawyer (`screenshots+<run>@example.com`). Use a dev database,
never a shared one. Registration is rate-limited to 20 per 15 minutes per IP, so a handful of
runs in a row is fine.

## Regenerate

```sh
pnpm dev            # in another terminal
pnpm screenshots
```

Then open every image and check it before committing. Each image is the 1440×900 viewport,
scrolled so the screen's key element is in view (or one element, for 14). The `next dev`
dev-tools badges are hidden. The repo is public, so 17 masks every user except the run's
throwaway `@example.com` accounts.

| Variable | Default | Use |
| --- | --- | --- |
| `SCREENSHOTS_WEB_URL` | `http://localhost:3000` | apps/web |
| `SCREENSHOTS_API_URL` | `http://localhost:4000/api/v1` | apps/api, for seeding |
| `SCREENSHOTS_ADMIN_EMAIL`, `SCREENSHOTS_ADMIN_PASSWORD` | unset | An existing Admin for 17 |
| `SCREENSHOTS_RESEARCH_QUESTION` | `What is the punishment under s. 302 PPC?` | The question for 07 |
| `SCREENSHOTS_PRECEDENT_QUERY` | `bail under s. 497 CrPC` | The search for 09 and 10 |

Other Playwright flags pass through, for example `pnpm screenshots -g 13` to capture one screen
(the seed still runs). `pnpm screenshots --list` loads the script without opening a browser.

## Skipped screens

Screens that need the corpus, the graph or a model are skipped with a logged reason
(`[screenshots] skip <name>: <reason>`) when the service answers 503 or shows an error, so no image
ever shows a failure. The old image is deleted first, so a skipped screen never leaves a stale one.

## With the AI service on Colab

On a laptop that can't hold the models, run the AI service with `notebooks/colab-ai-service.ipynb`.
Set `AI_SERVICE_URL` in `.env` to the tunnel URL its step 10 prints, then start only web and api:
`pnpm exec concurrently -k -n web,api "pnpm dev:web" "pnpm dev:api"`.

An Admin must enable the cloud provider that `CASEGUARD_ENV` configures (for example NVIDIA NIM)
under Admin → Model providers. The api sends only enabled providers, so with Ollama alone 07 and 12
are skipped.

| Image | Skipped when |
| --- | --- |
| 07 | The research answer fails, is unanswerable, or has no citations |
| 09 | Precedent search answers an error or finds nothing |
| 10 | As 09, or no hit has a relationship in the graph |
| 12 | Drafting assist shows an error or returns no text |
| 15 | The uploaded PDF fails, or is still processing after two minutes. services/ai reads the upload from the local `uploads/` folder, so 15 needs the AI service on the same machine as the api: with the AI service on Colab it is skipped. Only the embedder loads for it, so on a small laptop run services/ai with no model provider (07 and 12 are then skipped) and `pnpm screenshots -g 15` |
| 17 | `pnpm db:create-admin` fails |
| 19 | No "Soon" badge in the sidebar |
