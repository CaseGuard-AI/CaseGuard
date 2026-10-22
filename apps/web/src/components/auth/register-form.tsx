"use client";

import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { api } from "@/lib/api";
import { FormField } from "./form-field";
import { useAuthSubmit } from "./use-auth-submit";

export function RegisterForm() {
  const t = useTranslations("Auth");
  const locale = useLocale() as Locale;
  const next = useSearchParams().get("next");
  const { pending, errors, onSubmit } = useAuthSubmit((form) =>
    api.POST("/auth/register", {
      body: {
        name: String(form.get("name")),
        email: String(form.get("email")),
        password: String(form.get("password")),
        locale,
      },
    }),
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {errors.form && (
        <p
          role="alert"
          className="rounded-sm border border-danger/20 bg-danger-soft p-3 text-sm text-danger"
        >
          {errors.form}
        </p>
      )}
      <FormField
        label={t("fields.name")}
        name="name"
        autoComplete="name"
        required
        maxLength={120}
        error={errors.fields.name}
      />
      <FormField
        label={t("fields.email")}
        name="email"
        type="email"
        autoComplete="email"
        dir="ltr"
        required
        maxLength={254}
        error={errors.fields.email}
      />
      <FormField
        label={t("fields.password")}
        name="password"
        type="password"
        autoComplete="new-password"
        dir="ltr"
        required
        minLength={10}
        maxLength={128}
        hint={t("register.passwordHint")}
        error={errors.fields.password}
      />
      <Button type="submit" className="h-11 w-full" disabled={pending}>
        {t("register.submit")}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {t("register.haveAccount")}{" "}
        <Link
          href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
          className="font-semibold text-link"
        >
          {t("register.login")}
        </Link>
      </p>
    </form>
  );
}
