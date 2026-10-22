> **Status:** In progress · **Issue:** [#116](https://github.com/CaseGuard-AI/CaseGuard/issues/116) · **PR:** TBD

# #116: Real email via Gmail SMTP and `pnpm mail:check`

## Context

**Why:** the api's mailer (`src/lib/mailer.ts`, nodemailer, #61) works, but it has only ever sent to Mailpit. For demos, password-reset emails need to reach real inboxes. The team chose Gmail with an app password: it's free, about 500 emails a day, and takes five minutes to set up.

Nothing in the mailer itself needs to change: `SMTP_HOST/PORT/SECURE/USER/PASSWORD` and `MAIL_FROM` already cover Gmail. What's missing is a way to check a configuration and a guide. The first real setup went wrong in ways the api wouldn't have shown until someone asked for a reset: the user name was a display name instead of the address, the address was in a variable the code never reads, and the host still pointed at Mailpit.

## Approach

- `src/lib/mail-check.ts`: `pnpm mail:check --to <email>` (root and api). It reuses `createMailer` and sends one test message.
  - `parseMailEnv` in `src/config/env.ts` picks only the SMTP settings, so the check runs without a database or secrets.
  - `explainMailError` turns `EAUTH`/535, `EDNS` and connection errors into plain hints (app password, port/secure pairing).
  - It prints host, port, secure and From, never the password.
- `.env.example`: a commented Gmail block.
- `docs/engineering/local-setup.md`: a "Sending real email (Gmail)" section with the 2-Step Verification → app password → `.env` → `mail:check` → forgot-password steps, the daily limit, and the Docker override note. `docker-compose.yml` pins the api to Mailpit. It's linked from the `apps/api/README.md` Email section.
- `test/mail-check.test.ts`: argument parsing, the SMTP-only env and the error hints.

## Verification

- `pnpm --filter ./apps/api lint typecheck` pass. `vitest run test/mail-check.test.ts test/mailer.test.ts` → 5 passed, with 1 skipped without `MAILPIT_URL`.
- Against Gmail (smtp.gmail.com:465, secure, app password): nodemailer `verify()` OK, and `pnpm mail:check --to <own address>` delivered a message.
