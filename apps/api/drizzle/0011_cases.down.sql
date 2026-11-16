-- Reverses 0011_cases.sql. Cases are lost, and conversations saved to one are detached so the
-- next up can add the FK again. Audit rows keep their case_id (append-only).
ALTER TABLE "app"."conversations" DROP CONSTRAINT "conversations_case_id_cases_id_fk";
UPDATE "app"."conversations" SET "case_id" = NULL WHERE "case_id" IS NOT NULL;
DROP TABLE "app"."cases";
