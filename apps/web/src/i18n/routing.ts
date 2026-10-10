import { defineRouting } from "next-intl/routing";

// English is the default; Urdu is a first-class locale with RTL layout (FR-I18N, FR-LANG-2).
export const routing = defineRouting({
  locales: ["en", "ur"],
  defaultLocale: "en",
});

export type Locale = (typeof routing.locales)[number];

export const directionOf = (locale: Locale): "ltr" | "rtl" => (locale === "ur" ? "rtl" : "ltr");
