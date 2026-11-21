-- Reverses 0016_lint_reports_draft_fk.sql. draft_id values cleared on the way up stay null.
ALTER TABLE "app"."lint_reports" DROP CONSTRAINT "lint_reports_draft_id_drafts_id_fk";
