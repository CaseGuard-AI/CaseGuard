import { FileCheck2, Scale, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Suspense, use } from "react";
import { LanguageSwitch } from "@/components/shell/language-switch";

// The prototype's sign-in layout: a navy hero beside the form on large screens, the form alone
// on small ones. Outside the app shell, so it needs no session.
export default function AuthLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations();

  return (
    <div className="grid min-h-screen bg-card lg:grid-cols-[1.05fr_0.95fr]">
      <section className="hidden bg-navy p-12 text-primary-foreground lg:flex lg:flex-col">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-md bg-primary-foreground text-navy">
            <Scale />
          </span>
          <span className="text-lg font-bold">{t("App.name")}</span>
        </div>
        <div className="my-auto max-w-xl">
          <span className="text-xs font-bold text-primary-foreground/50 uppercase">
            {t("Auth.hero.eyebrow")}
          </span>
          <h1 className="mt-5 text-5xl leading-[1.1] font-bold">{t("Auth.hero.title")}</h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-primary-foreground/70">
            {t("Auth.hero.body")}
          </p>
          <div className="mt-10 flex gap-6 text-xs text-primary-foreground/65">
            <span className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-success" />
              {t("Auth.hero.sourceVerified")}
            </span>
            <span className="flex items-center gap-2">
              <FileCheck2 className="size-4 text-success" />
              {t("Auth.hero.procedurallyChecked")}
            </span>
          </div>
        </div>
        <p className="text-xs text-primary-foreground/35">{t("Auth.hero.footer")}</p>
      </section>

      <section className="relative flex items-center justify-center p-6">
        <LanguageSwitch className="absolute end-6 top-6" />
        <div className="cg-rise w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="flex size-9 items-center justify-center rounded-md bg-navy text-primary-foreground">
              <Scale />
            </span>
            <span className="font-bold">{t("App.name")}</span>
          </div>
          {/* The forms read the query (`?next=`, `?token=`), which needs a Suspense boundary for
              static rendering. */}
          <Suspense>{children}</Suspense>
        </div>
      </section>
    </div>
  );
}
