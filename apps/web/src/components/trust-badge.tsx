import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// The three trust statuses (PRD §7.2). Always render the status stored by the trust layer;
// never derive one in the UI (FR-TRUST-10). The prototype's "arguable" is our "needs_review".
export type TrustStatus = "verified" | "needs_review" | "unverified";

const styles: Record<TrustStatus, string> = {
  verified: "border-success/20 bg-success-soft text-success",
  needs_review: "border-warning/20 bg-warning-soft text-warning",
  unverified: "border-danger/20 bg-danger-soft text-danger",
};

const icons = { verified: CircleCheck, needs_review: CircleAlert, unverified: X };

export function TrustBadge({ status }: { status: TrustStatus }) {
  const t = useTranslations("Trust");
  const Icon = icons[status];
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-[10px] font-bold uppercase",
        styles[status],
      )}
    >
      <Icon className="size-3" aria-hidden />
      {t(status)}
    </span>
  );
}
