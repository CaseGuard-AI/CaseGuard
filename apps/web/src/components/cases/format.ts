import type { useFormatter } from "next-intl";

type Formatter = ReturnType<typeof useFormatter>;

/**
 * A calendar date from the API (`YYYY-MM-DD`, no time zone) in the user's language. It is read
 * and shown in UTC, so the day never shifts with the browser's zone.
 */
export const formatDay = (format: Formatter, day: string) =>
  format.dateTime(new Date(`${day}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
