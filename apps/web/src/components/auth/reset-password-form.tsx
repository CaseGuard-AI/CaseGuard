"use client";

import { LinkIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import { api, problemOf } from "@/lib/api";
import { signOut } from "@/lib/session";
import { authErrors, type FormErrors } from "./auth-errors";
import { FormField } from "./form-field";

// The token arrives as `?token=` from the email link. It is read once, kept in state and taken
// out of the address bar and history straight away (the page also sends no Referer).
export function ResetPasswordForm() {
  const t = useTranslations("Auth");
  const tErrors = useTranslations("Auth.errors");
  const router = useRouter();
  const params = useSearchParams();
  const [token] = useState(() => params.get("token"));
  const [invalid, setInvalid] = useState(!token);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const password = String(new FormData(event.currentTarget).get("password"));
    setPending(true);
    setErrors({ fields: {} });
    try {
      const { error, response } = await api.POST("/auth/password-reset/confirm", {
        body: { token, password },
      });
      if (response.ok) {
        // The API revoked every session, so sign this browser (and its other tabs) out too.
        await signOut();
        router.replace("/login?reset=1");
        return;
      }
      // A 400 without field errors is the token itself: unknown, used or expired.
      if (response.status === 400 && !problemOf(error)?.errors?.length) setInvalid(true);
      else setErrors(authErrors(response.status, error, tErrors));
    } catch {
      setErrors(authErrors(undefined, undefined, tErrors));
    } finally {
      setPending(false);
    }
  }

  if (invalid) {
    return (
      <div className="space-y-6">
        <div
          role="alert"
          className="flex gap-3 rounded-sm border border-danger/20 bg-danger-soft p-4"
        >
          <LinkIcon className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-danger">{t("reset.invalidTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("reset.invalidBody")}</p>
          </div>
        </div>
        <Button asChild className="h-11 w-full">
          <Link href="/forgot-password">{t("reset.requestNew")}</Link>
        </Button>
      </div>
    );
  }

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
        {t("reset.submit")}
      </Button>
    </form>
  );
}
