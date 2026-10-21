import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { use } from "react";
import { RegisterForm } from "@/components/auth/register-form";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/register">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Auth.register" });
  return { title: t("submit") };
}

export default function RegisterPage({ params }: PageProps<"/[locale]/register">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("Auth.register");

  return (
    <>
      <h2 className="text-2xl font-bold">{t("title")}</h2>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">{t("subtitle")}</p>
      <RegisterForm />
    </>
  );
}
