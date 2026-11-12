ALTER TABLE "app"."users" DROP CONSTRAINT "users_role_check";--> statement-breakpoint
UPDATE "app"."users" SET "role" = 'lawyer' WHERE "role" = 'user';--> statement-breakpoint
ALTER TABLE "app"."users" ALTER COLUMN "role" SET DEFAULT 'lawyer';--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_role_check" CHECK (role in ('lawyer', 'researcher', 'admin'));