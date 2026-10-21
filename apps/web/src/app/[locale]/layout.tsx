import type { Metadata } from "next";
import { Inter, Noto_Nastaliq_Urdu } from "next/font/google";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/shell/app-shell";
import { directionOf, routing } from "@/i18n/routing";
import "../globals.css";

// Inter matches the prototype (ADR-0006).
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
// Nastaliq is the conventional script style for Urdu (FR-LANG-2).
const nastaliq = Noto_Nastaliq_Urdu({ variable: "--font-urdu", subsets: ["arabic"] });

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LayoutProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "App" });
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
  };
}

export default async function LocaleLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const dir = directionOf(locale);

  return (
    <html
      lang={locale}
      dir={dir}
      className={`${inter.variable} ${nastaliq.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <NextIntlClientProvider>
          <Providers dir={dir}>
            <AppShell>{children}</AppShell>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
