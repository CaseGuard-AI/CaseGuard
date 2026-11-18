-- Documents uploaded to a case (FR-DOC-1, #101) and the per-attempt stage log (FR-DOC-2). The
-- files themselves live in the blob store (data-storage §6); pg-boss keeps its jobs in the
-- `pgboss` schema, which bootstrap.sql creates (caseguard_app cannot CREATE SCHEMA, ADR-0007).
CREATE TABLE "app"."document_stages" (
	"document_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"stage" text NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_stages_document_id_attempt_stage_pk" PRIMARY KEY("document_id","attempt","stage")
);
--> statement-breakpoint
CREATE TABLE "app"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"pages" integer,
	"attempt" integer DEFAULT 1 NOT NULL,
	"processed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_status_check" CHECK (status in ('queued', 'processing', 'done', 'flagged', 'failed')),
	CONSTRAINT "documents_flags_check" CHECK (jsonb_typeof("app"."documents"."flags") = 'array'),
	CONSTRAINT "documents_size_check" CHECK (size_bytes > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."document_stages" ADD CONSTRAINT "document_stages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_stages" ADD CONSTRAINT "document_stages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_stages" ADD CONSTRAINT "document_stages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_owner_created_idx" ON "app"."documents" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_case_created_idx" ON "app"."documents" USING btree ("case_id","created_at");