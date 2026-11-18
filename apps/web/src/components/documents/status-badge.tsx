import { CircleAlert, CircleCheck, LoaderCircle, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { DocumentStatus } from "./queries";

// The processing status of a document (FR-DOC-3), always the one the API stored. `flagged` has its
// own warning style and never looks like `done` (FR-DOC-4).
export const documentStatusStyles: Record<DocumentStatus, string> = {
  queued: "border-border bg-muted text-muted-foreground",
  processing: "border-border bg-muted text-muted-foreground",
  done: "border-success/20 bg-success-soft text-success",
  flagged: "border-warning/20 bg-warning-soft text-warning",
  failed: "border-danger/20 bg-danger-soft text-danger",
};

const icons = {
  queued: LoaderCircle,
  processing: LoaderCircle,
  done: CircleCheck,
  flagged: CircleAlert,
  failed: X,
};

export function DocumentStatusBadge({
  status,
  flagCount = 0,
}: {
  status: DocumentStatus;
  flagCount?: number;
}) {
  const t = useTranslations("Documents");
  const Icon = icons[status];
  const moving = status === "queued" || status === "processing";
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-[10px] font-bold uppercase",
        documentStatusStyles[status],
      )}
    >
      <Icon className={cn("size-3", moving && "animate-spin")} aria-hidden />
      {t(`status.${status}`)}
      {status === "flagged" && <span>· {t("flagCount", { count: flagCount })}</span>}
    </span>
  );
}
