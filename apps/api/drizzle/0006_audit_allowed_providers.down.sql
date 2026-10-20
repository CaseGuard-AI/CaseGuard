-- Reverses 0006_audit_allowed_providers.sql.
ALTER TABLE "app"."ai_audit_records" DROP COLUMN "allowed_providers";
