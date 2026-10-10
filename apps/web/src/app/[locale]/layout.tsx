import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Nastaliq_Urdu } from "next/font/google";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";
import { directionOf, routing } from "@/i18n/routing";
import "../globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Nastaliq is the conventional script style for Urdu (FR-LANG-2).
const nastaliq = Noto_Nastaliq_Urdu({ variable: "--font-urdu", subsets: ["arabic"] });

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LayoutProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "App" });
  return { title: t("name"), description: t("tagline") };
}

export default async function LocaleLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <html
      lang={locale}
      dir={directionOf(locale)}
      className={`${geistSans.variable} ${geistMono.variable} ${nastaliq.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider>
          <Providers>
            <SiteHeader />
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
