import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { use } from "react";
import { LoginForm } from "@/components/auth/login-form";
import { RedirectIfSignedIn } from "@/components/auth/redirect-if-signed-in";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/login">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Auth.login" });
  return { title: t("submit") };
}

export default function LoginPage({ params }: PageProps<"/[locale]/login">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("Auth.login");

  return (
    <>
      <h2 className="text-2xl font-bold">{t("title")}</h2>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">{t("subtitle")}</p>
      <RedirectIfSignedIn>
        <LoginForm />
      </RedirectIfSignedIn>
    </>
  );
}
