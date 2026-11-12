-- User API keys and the default model (FR-SET-2, SEC-4, ADR-0009). 0008 (roles) and 0009 are
-- reserved for other branches. ai_audit_records' append-only trigger (0004) blocks UPDATE only,
-- so adding columns to it is allowed.
CREATE TABLE "app"."user_api_keys" (
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_api_keys_user_id_provider_id_pk" PRIMARY KEY("user_id","provider_id"),
	CONSTRAINT "user_api_keys_last4_check" CHECK (char_length(last4) = 4)
);
--> statement-breakpoint
ALTER TABLE "app"."ai_audit_records" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "app"."ai_audit_records" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "default_provider_id" text;--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "default_model" text;--> statement-breakpoint
ALTER TABLE "app"."user_api_keys" ADD CONSTRAINT "user_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_api_keys" ADD CONSTRAINT "user_api_keys_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "app"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_default_provider_id_providers_id_fk" FOREIGN KEY ("default_provider_id") REFERENCES "app"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_default_model_check" CHECK ((default_provider_id is null) = (default_model is null));