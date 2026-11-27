import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { PageKey } from "./nav-items";

// `generateMetadata` for a screen: its title, joined to the app name by the layout's template.
export function pageMetadata(page: PageKey) {
  return async ({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> => {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: "Pages" });
    return { title: t(`${page}.title`) };
  };
}
