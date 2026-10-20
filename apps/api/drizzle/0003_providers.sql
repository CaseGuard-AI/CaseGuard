CREATE TABLE "app"."providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_id_check" CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	CONSTRAINT "providers_kind_check" CHECK (kind in ('cloud', 'local'))
);
--> statement-breakpoint
-- Seed: the ADR-0005 provider presets (.env.example). Only the local provider starts enabled;
-- an Admin switches cloud providers on (SEC-11).
INSERT INTO "app"."providers" ("id", "name", "kind", "enabled") VALUES
	('nvidia-nim', 'NVIDIA NIM', 'cloud', false),
	('gemini', 'Google Gemini', 'cloud', false),
	('groq', 'Groq', 'cloud', false),
	('openrouter', 'OpenRouter', 'cloud', false),
	('openai', 'OpenAI', 'cloud', false),
	('anthropic', 'Anthropic', 'cloud', false),
	('ollama', 'Ollama (local)', 'local', true);
