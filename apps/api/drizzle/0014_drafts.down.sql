-- Reverses 0014_drafts.sql. Drafts and their citation links are lost; the citations themselves
-- stay in services/ai's trust store. Audit records keep every other column.
DROP TABLE "app"."draft_citations";
DROP TABLE "app"."drafts";
ALTER TABLE "app"."ai_audit_records" DROP COLUMN "draft_id";
