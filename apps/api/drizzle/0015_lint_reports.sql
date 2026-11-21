CREATE TABLE "app"."lint_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"case_id" uuid,
	"draft_id" uuid,
	"document_type" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"input_sha256" text NOT NULL,
	"ruleset_id" text NOT NULL,
	"ruleset_version" text NOT NULL,
	"findings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lint_reports_document_type_check" CHECK (document_type in ('bail_application', 'plaint')),
	CONSTRAINT "lint_reports_sha256_check" CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "lint_reports_findings_check" CHECK (jsonb_typeof("app"."lint_reports"."findings") = 'array')
);
--> statement-breakpoint
ALTER TABLE "app"."lint_reports" ADD CONSTRAINT "lint_reports_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lint_reports" ADD CONSTRAINT "lint_reports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lint_reports" ADD CONSTRAINT "lint_reports_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lint_reports_owner_created_idx" ON "app"."lint_reports" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "lint_reports_case_created_idx" ON "app"."lint_reports" USING btree ("case_id","created_at","id");