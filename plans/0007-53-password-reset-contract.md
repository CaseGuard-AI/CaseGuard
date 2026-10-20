> **Status:** In progress · **Issue:** [#53](https://github.com/CaseGuard-AI/CaseGuard/issues/53) · **PR:** #N

# #53 (part 1): password reset in the api.v1 contract

## Context
FR-AUTH-1 includes password reset, but `api.v1.yaml` has no endpoint for it, so #10 left it out. The contracts rules (`packages/contracts/README.md`) say a contract change goes in its **own PR**, reviewed by the producer (`apps/api`) and the consumer (`apps/web`). This PR changes only the contract. The `apps/api` implementation is a later PR under #53.

Branch `feature/contracts-password-reset` off `staging`. PR title: `feat(contracts): password reset endpoints in api.v1`. The change is additive and non-breaking, so there's no `!` and no version bump.

## Changes
1. `packages/contracts/openapi/api.v1.yaml`:
   - `POST /auth/password-reset` (`requestPasswordReset`, public): body `PasswordResetRequest { email }`. Responses: **202 always**, so the reply doesn't reveal whether an email is registered; 400; 429. The token goes out of band and never appears in a response.
   - `POST /auth/password-reset/confirm` (`confirmPasswordReset`, public): body `PasswordResetConfirm { token, password }`, where `password` has the same 10–128 bounds as `RegisterRequest`. Responses: 204, which also **revokes every existing session**; 400 for an unknown, used or expired token; 429.
2. `packages/contracts/README.md`: the Status section mentions password reset.
3. `CHANGELOG.md`: an Added entry.

## Left for the implementation PR (#53)
- Hashed, single-use reset tokens with a short expiry.
- Rate limits.
- Revoking refresh tokens on reset.
- How the token is delivered. There's no email service yet; dev can log a reset link with the token redacted from normal logs.

## Verification
`npx @redocly/cli lint packages/contracts/openapi/*.yaml` passes, and so does the CI `contracts` job.
