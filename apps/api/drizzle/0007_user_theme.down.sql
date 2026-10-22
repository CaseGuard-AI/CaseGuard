-- Reverses 0007_user_theme.sql.
ALTER TABLE "app"."users" DROP CONSTRAINT "users_theme_check";
ALTER TABLE "app"."users" DROP COLUMN "theme";
