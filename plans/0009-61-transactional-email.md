> **Status:** Done · **Issue:** [#61](https://github.com/CaseGuard-AI/CaseGuard/issues/61) · **PR:** [#63](https://github.com/CaseGuard-AI/CaseGuard/pull/63)

# #61: transactional email (SMTP + Mailpit)

## Context
Password reset (#53) has to email a reset link, but `apps/api` had no way to send mail. This issue adds email on its own, before #53, following the one-issue-per-PR rule. The user chose SMTP through nodemailer, with Mailpit catching mail in dev and CI. The approach is provider-agnostic and free.

Branch `feature/api-transactional-email` off `staging`. PR title: `feat(api): transactional email over SMTP with Mailpit for dev and CI`.

## Changes
1. **`apps/api/src/lib/mailer.ts`**: `createMailer(env, logger)` returns a `Mailer` with a single method, `send({ to, subject, text, html? })`.
   - Without `SMTP_HOST`, every send rejects with `MailNotConfiguredError` and logs an error, so it fails closed.
   - Only the subject and message id are ever logged, never the recipient or the body.
2. **`src/config/env.ts`**: `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE` (a stringbool, default false), `SMTP_USER`, `SMTP_PASSWORD`, and `MAIL_FROM` (with a default). A blank `KEY=` counts as unset.
3. **Wiring**: `AppDeps.mailer` in `src/app.ts`, created in `src/server.ts`. Test helpers inject a no-op mailer. No route uses it yet; #53 will be the first.
4. **`docker-compose.yml`**: a `mailpit` service (`axllent/mailpit:v1.31.3`) on `edge`, with UI and API on `127.0.0.1:8025` and SMTP on `127.0.0.1:1025`. The api container gets `SMTP_HOST=mailpit` and `SMTP_PORT=1025`.
5. **`.env.example`**: the `SMTP_*` and `MAIL_FROM` block. Its defaults point at local Mailpit.
6. **CI** (`.github/workflows/ci.yml`, `api` job): a Mailpit service container and `MAILPIT_URL=http://localhost:8025`.
7. **Tests** (`test/mailer.test.ts`):
   - Fails closed without SMTP, and the body never appears in the logs.
   - The env parses correctly.
   - A Mailpit round-trip, run only when `MAILPIT_URL` is set: send a message, find it by its unique subject through `/api/v1/search`, and check the recipient and text through `/api/v1/message/{id}`.
8. **Docs**: an Email section in `apps/api/README.md`, Mailpit in `docs/engineering/local-setup.md`, and a `CHANGELOG.md` entry.

## Verification
- Lint and typecheck pass. `MAILPIT_URL=… vitest run` against a local Mailpit container passes 21 tests, the Mailpit test included.
- `docker compose config` is valid with `.env.example`. The CI `compose-smoke` job boots the full stack with Mailpit.
