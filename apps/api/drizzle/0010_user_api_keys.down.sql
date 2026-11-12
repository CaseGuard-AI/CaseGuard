-- Reverses 0010_user_api_keys.sql. Stored user keys are lost (they are unreadable without the
-- table anyway); users re-enter them after the next up.
ALTER TABLE "app"."users" DROP CONSTRAINT "users_default_model_check";
ALTER TABLE "app"."users" DROP CONSTRAINT "users_default_provider_id_providers_id_fk";
ALTER TABLE "app"."users" DROP COLUMN "default_model";
ALTER TABLE "app"."users" DROP COLUMN "default_provider_id";
ALTER TABLE "app"."ai_audit_records" DROP COLUMN "model";
ALTER TABLE "app"."ai_audit_records" DROP COLUMN "provider_id";
DROP TABLE "app"."user_api_keys";
