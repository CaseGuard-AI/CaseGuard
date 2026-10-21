import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { use } from "react";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/reset-password">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Auth.reset" });
  // The reset token is in the URL on arrival: never send it on in a Referer header.
  return { title: t("title"), referrer: "no-referrer" };
}

export default function ResetPasswordPage({ params }: PageProps<"/[locale]/reset-password">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("Auth.reset");

  return (
    <>
      <h2 className="text-2xl font-bold">{t("title")}</h2>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">{t("subtitle")}</p>
      <ResetPasswordForm />
    </>
  );
}
