-- Cases (FR-CASE-1, #98) and the conversations.case_id FK (FR-CASE-5). ai_audit_records.case_id
-- keeps no FK: that table is append-only (0004), so it records the case the request carried.
CREATE TABLE "app"."cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"court" text,
	"case_number" text,
	"case_type" text,
	"filed_on" date,
	"status" text,
	"next_hearing_on" date,
	"parties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"judge" text,
	"assigned_lawyer" text,
	"relevant_laws" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_parties_check" CHECK (jsonb_typeof("app"."cases"."parties") = 'array')
);
--> statement-breakpoint
ALTER TABLE "app"."cases" ADD CONSTRAINT "cases_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cases" ADD CONSTRAINT "cases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cases_owner_updated_idx" ON "app"."cases" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."cases"("id") ON DELETE set null ON UPDATE no action;