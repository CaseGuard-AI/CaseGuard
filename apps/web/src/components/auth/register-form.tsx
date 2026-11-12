"use client";

import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FormField } from "./form-field";
import { useAuthSubmit } from "./use-auth-submit";

// FR-AUTH-2. Admin is never offered here: the API rejects it, and admins come from the CLI.
const SELF_REGISTER_ROLES = ["lawyer", "researcher"] as const;

// Native radios inside the form, so the choice is read from FormData like the other fields.
function RoleChoice() {
  const t = useTranslations("Auth.register");
  const tRoles = useTranslations("Nav.roles");
  const hintId = useId();

  return (
    <fieldset className="space-y-2" aria-describedby={hintId}>
      <legend className="text-sm font-medium">{t("role")}</legend>
      <div className="grid grid-cols-2 gap-3">
        {SELF_REGISTER_ROLES.map((role) => (
          <label
            key={role}
            className={cn(
              "flex h-11 cursor-pointer items-center gap-3 rounded-md border bg-background px-3 text-sm font-medium transition-colors",
              "hover:bg-accent has-[:checked]:border-primary has-[:checked]:bg-accent",
              "has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
            )}
          >
            <input
              type="radio"
              name="role"
              value={role}
              defaultChecked={role === "lawyer"}
              className="size-4 accent-primary"
            />
            {tRoles(role)}
          </label>
        ))}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {t("roleHint")}
      </p>
    </fieldset>
  );
}

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
        role: form.get("role") === "researcher" ? "researcher" : "lawyer",
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
      <RoleChoice />
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
