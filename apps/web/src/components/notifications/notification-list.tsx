"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Info,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { useMarkAllRead, useMarkRead, useNotifications, type Notification } from "./queries";

const KINDS: Record<string, { icon: LucideIcon; className: string }> = {
  document_done: { icon: CheckCircle2, className: "text-success" },
  // Flagged is processed with uncertain parts: never styled as done (FR-DOC-4).
  document_flagged: { icon: AlertTriangle, className: "text-warning" },
  document_failed: { icon: CircleAlert, className: "text-danger" },
};
// A kind added to the contract later still renders, with a generic text.
const OTHER = { icon: Info, className: "text-muted-foreground" };
const known = (kind: string) => kind in KINDS;

export function NotificationList({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const t = useTranslations("Notifications");
  const query = useNotifications(open);
  const markAll = useMarkAllRead();
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = query.data?.pages[0]?.unreadCount ?? 0;

  if (query.isPending) {
    return (
      <p aria-busy="true" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-3 p-4 text-sm" role="alert">
        <p>{t("error")}</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t("retry")}
        </Button>
      </div>
    );
  }
  if (items.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t("empty")}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex justify-end border-b px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={unread === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          {t("markAllRead")}
        </Button>
      </div>
      <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
        {items.map((n) => (
          <Item key={n.id} item={n} onNavigate={onNavigate} />
        ))}
      </ul>
      {query.hasNextPage && (
        <div className="border-t p-3 text-center">
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Item({ item, onNavigate }: { item: Notification; onNavigate: () => void }) {
  const t = useTranslations("Notifications");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const markRead = useMarkRead();
  const { icon: Icon, className } = KINDS[item.kind] ?? OTHER;
  const unread = item.readAt === null;

  return (
    <li>
      <Link
        href={`/cases/${item.caseId}`}
        data-unread={unread || undefined}
        className={cn(
          "flex gap-3 px-4 py-3 text-sm hover:bg-muted/60",
          unread && "bg-muted/30 font-medium",
        )}
        onClick={() => {
          if (unread) markRead.mutate(item.id);
          onNavigate();
        }}
      >
        <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block break-words">
            {t(known(item.kind) ? `kind.${item.kind}` : "kind.other", { filename: item.filename })}
          </span>
          <span className="block text-xs font-normal text-muted-foreground">
            {format.relativeTime(new Date(item.createdAt), now)}
          </span>
        </span>
        {unread && <span className="sr-only">{t("unread")}</span>}
      </Link>
    </li>
  );
}
