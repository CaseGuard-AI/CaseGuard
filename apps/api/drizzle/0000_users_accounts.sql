-- The app schema itself is created and owned by infra/db/sql/bootstrap.sql (ADR-0002);
-- caseguard_app cannot create schemas, so drizzle-kit's CREATE SCHEMA is removed here.
CREATE TABLE "app"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'individual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_kind_check" CHECK (kind in ('individual'))
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK (role in ('user', 'admin')),
	CONSTRAINT "users_locale_check" CHECK (locale in ('en', 'ur'))
);
--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "app"."users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_account_id_idx" ON "app"."users" USING btree ("account_id");