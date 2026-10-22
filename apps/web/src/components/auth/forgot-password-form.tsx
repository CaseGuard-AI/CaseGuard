"use client";

import { MailCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { FormField } from "./form-field";

// Any answer from the API (202, 400, 429) shows "check your inbox", so the page never reveals
// whether an email has an account. Only a request that never got an answer shows an error.
export function ForgotPasswordForm() {
  const t = useTranslations("Auth");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [networkError, setNetworkError] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email"));
    setPending(true);
    setNetworkError(false);
    try {
      await api.POST("/auth/password-reset", { body: { email } });
      setSent(true);
    } catch {
      setNetworkError(true);
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-6">
        <div
          role="status"
          className="flex gap-3 rounded-sm border border-success/20 bg-success-soft p-4"
        >
          <MailCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-semibold">{t("forgot.sentTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("forgot.sentBody")}</p>
          </div>
        </div>
        <Button asChild variant="outline" className="h-11 w-full">
          <Link href="/login">{t("forgot.backToLogin")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {networkError && (
        <p
          role="alert"
          className="rounded-sm border border-danger/20 bg-danger-soft p-3 text-sm text-danger"
        >
          {t("errors.network")}
        </p>
      )}
      <FormField
        label={t("fields.email")}
        name="email"
        type="email"
        autoComplete="email"
        dir="ltr"
        required
        maxLength={254}
      />
      <Button type="submit" className="h-11 w-full" disabled={pending}>
        {t("forgot.submit")}
      </Button>
      <p className="text-center text-sm">
        <Link href="/login" className="font-semibold text-link">
          {t("forgot.backToLogin")}
        </Link>
      </p>
    </form>
  );
}
