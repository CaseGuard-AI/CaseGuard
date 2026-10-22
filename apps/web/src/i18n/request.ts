import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return {
    locale,
    // Dates (such as a citation's last-verified time) are shown in Pakistan time on server and client.
    timeZone: "Asia/Karachi",
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
