import { useTranslations } from "next-intl";

// The three trust statuses (PRD §7.2). Always render the status stored by the trust layer;
// never derive one in the UI (FR-TRUST-10).
export type TrustStatus = "verified" | "needs_review" | "unverified";

const styles: Record<TrustStatus, string> = {
  verified: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  needs_review: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  unverified: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function TrustBadge({ status }: { status: TrustStatus }) {
  const t = useTranslations("Home.trust");
  return (
    <span
      data-status={status}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {t(status)}
    </span>
  );
}
