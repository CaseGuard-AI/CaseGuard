"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { FormField } from "./form-field";
import { useAuthSubmit } from "./use-auth-submit";

export function LoginForm() {
  const t = useTranslations("Auth");
  const params = useSearchParams();
  const next = params.get("next");
  const resetDone = params.get("reset") === "1";
  const { pending, errors, onSubmit } = useAuthSubmit((form) =>
    api.POST("/auth/login", {
      body: { email: String(form.get("email")), password: String(form.get("password")) },
    }),
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {resetDone && !errors.form && (
        <p
          role="status"
          className="rounded-sm border border-success/20 bg-success-soft p-3 text-sm text-success"
        >
          {t("login.resetDone")}
        </p>
      )}
      {errors.form && (
        <p
          role="alert"
          className="rounded-sm border border-danger/20 bg-danger-soft p-3 text-sm text-danger"
        >
          {errors.form}
        </p>
      )}
      <FormField
        label={t("fields.email")}
        name="email"
        type="email"
        autoComplete="email"
        dir="ltr"
        required
        error={errors.fields.email}
      />
      <FormField
        label={t("fields.password")}
        name="password"
        type="password"
        autoComplete="current-password"
        dir="ltr"
        required
        error={errors.fields.password}
        labelAction={
          <Link href="/forgot-password" className="text-xs font-semibold text-primary">
            {t("login.forgot")}
          </Link>
        }
      />
      <Button type="submit" className="h-11 w-full" disabled={pending}>
        {t("login.submit")}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {t("login.noAccount")}{" "}
        <Link
          href={next ? `/register?next=${encodeURIComponent(next)}` : "/register"}
          className="font-semibold text-primary"
        >
          {t("login.register")}
        </Link>
      </p>
    </form>
  );
}
