-- Reverses 0008_user_roles.sql. Lawyers and Researchers both become `user` again.
ALTER TABLE "app"."users" DROP CONSTRAINT "users_role_check";
UPDATE "app"."users" SET "role" = 'user' WHERE "role" IN ('lawyer', 'researcher');
ALTER TABLE "app"."users" ALTER COLUMN "role" SET DEFAULT 'user';
ALTER TABLE "app"."users" ADD CONSTRAINT "users_role_check" CHECK (role in ('user', 'admin'));
