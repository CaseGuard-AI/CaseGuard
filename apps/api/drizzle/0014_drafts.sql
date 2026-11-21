CREATE TABLE "app"."draft_citations" (
	"draft_id" uuid NOT NULL,
	"citation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_citations_draft_id_citation_id_pk" PRIMARY KEY("draft_id","citation_id")
);
--> statement-breakpoint
CREATE TABLE "app"."drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"case_id" uuid,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"title" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_template_id_check" CHECK (template_id in ('bail_application', 'plaint', 'legal_notice')),
	CONSTRAINT "drafts_fields_check" CHECK (jsonb_typeof("app"."drafts"."fields") = 'object'),
	CONSTRAINT "drafts_sections_check" CHECK (jsonb_typeof("app"."drafts"."sections") = 'array'),
	CONSTRAINT "drafts_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."ai_audit_records" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."draft_citations" ADD CONSTRAINT "draft_citations_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "app"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."drafts" ADD CONSTRAINT "drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."drafts" ADD CONSTRAINT "drafts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."drafts" ADD CONSTRAINT "drafts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "draft_citations_citation_idx" ON "app"."draft_citations" USING btree ("citation_id");--> statement-breakpoint
CREATE INDEX "drafts_owner_updated_idx" ON "app"."drafts" USING btree ("owner_user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "drafts_case_updated_idx" ON "app"."drafts" USING btree ("case_id","updated_at");