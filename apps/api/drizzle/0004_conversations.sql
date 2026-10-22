CREATE TABLE "app"."ai_audit_records" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"conversation_id" uuid,
	"case_id" uuid,
	"question" text NOT NULL,
	"language" text,
	"law_as_of" date,
	"outcome" text NOT NULL,
	"response_text" text,
	"answer_language" text,
	"citations" jsonb,
	"error" text,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_audit_records_outcome_check" CHECK (outcome in ('answered', 'unanswerable', 'error'))
);
--> statement-breakpoint
CREATE TABLE "app"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"conversation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"language" text,
	"answerable" boolean,
	"citations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK (role in ('user', 'assistant'))
);
--> statement-breakpoint
ALTER TABLE "app"."ai_audit_records" ADD CONSTRAINT "ai_audit_records_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_audit_records" ADD CONSTRAINT "ai_audit_records_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_audit_records" ADD CONSTRAINT "ai_audit_records_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_audit_records_owner_created_idx" ON "app"."ai_audit_records" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_owner_updated_idx" ON "app"."conversations" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_seq_idx" ON "app"."messages" USING btree ("conversation_id","seq");--> statement-breakpoint
-- Audit records are append-only (PRD §13.3). The only update allowed is the FK's own
-- ON DELETE SET NULL when a conversation is removed; any other change raises.
CREATE FUNCTION "app"."ai_audit_records_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.conversation_id IS NULL
		AND (to_jsonb(NEW) - 'conversation_id') = (to_jsonb(OLD) - 'conversation_id') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'app.ai_audit_records is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ai_audit_records_no_update" BEFORE UPDATE ON "app"."ai_audit_records"
	FOR EACH ROW EXECUTE FUNCTION "app"."ai_audit_records_append_only"();
