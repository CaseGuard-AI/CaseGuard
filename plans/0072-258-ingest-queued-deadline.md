> **Status:** In review · **Issue:** [#258](https://github.com/CaseGuard-AI/CaseGuard/issues/258) · **PR:** (this PR)

# #258: the ingest attempt deadline no longer counts time spent queued

## Context
`runIngestStep` set `deadline = now + ATTEMPT_TIMEOUT_MS` (30 min) as soon as services/ai accepted the submit. The services/ai worker runs one attempt at a time and OCR is slow, so a document waiting in its queue could fail with "Processing took too long" before it ever started. With `DOCUMENT_MAX_ATTEMPTS = 3`, a backlog of more than about 90 minutes could use up every attempt.

## Change
- `IngestJob.deadline` (the 30-minute attempt limit) is now set the first time a poll, or the submit reply, reports `running`.
- A new optional `IngestJob.queuedDeadline` is set at submit to `now + QUEUED_TIMEOUT_MS` (6 h). An attempt still `queued` after that fails as timed out, and is retried while it has attempts left. So a stuck queue still ends the document as `failed` (NFR-13).
- Jobs enqueued before this change have a `deadline` from submit and no `queuedDeadline`. They keep the old behaviour, because the check uses `deadline ?? queuedDeadline`.
- A retry clears both deadlines, and the new attempt's submit sets them again.

## Verification
- `apps/api/test/document-jobs.test.ts` has these new or changed tests, and the four marked "new" fail on the old code:
  - (new) a document queued for 40 min and then running for 20 min doesn't time out.
  - (changed) an attempt running past 30 min times out.
  - (new) an attempt queued past 6 h times out and is retried.
  - (new) a last attempt queued past 6 h leaves the document failed.
  - (new) a pre-#258 job still times out.
- apps/api lint, typecheck and the full test suite (431 tests) pass against a scratch DB.
