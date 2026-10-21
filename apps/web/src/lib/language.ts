import type { Schemas } from "@/lib/api";

// The language of content (an answer, a quote, a source), as opposed to the UI locale. Quoted
// legal text keeps its own language and direction inside either UI (FR-RES-10).
export type Language = Schemas["Language"];

export const dirOf = (language: Language | undefined): "ltr" | "rtl" =>
  language === "ur" ? "rtl" : "ltr";

const tags: Record<Language, string> = { en: "en", ur: "ur", roman_ur: "ur-Latn" };

/** A BCP 47 tag for the `lang` attribute, or undefined to inherit the page's. */
export const langOf = (language: Language | undefined): string | undefined =>
  language ? tags[language] : undefined;
