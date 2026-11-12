"use client";

import { LoaderCircle, Plus } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { useConversations } from "./queries";

// The research history (FR-RES-8): the user's conversations, most recently active first. The URL
// alone picks the conversation, so choosing one, or starting a new question, only changes `?c=`.
// `onNavigate` lets the mobile drawer close after a choice.
export function HistoryList({
  activeId,
  onNavigate,
}: {
  activeId: string | null;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Research.history");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const router = useRouter();
  const history = useConversations();
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];

  function go(href: string) {
    router.replace(href);
    onNavigate?.();
  }

  return (
    <nav aria-label={t("title")} className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold">{t("title")}</h2>
        <Button variant="outline" size="sm" onClick={() => go("/research")}>
          <Plus aria-hidden />
          {t("newQuestion")}
        </Button>
      </div>

      {history.isPending && (
        <p aria-busy="true" className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          {t("loading")}
        </p>
      )}
      {history.isError && items.length === 0 && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>{t("error")}</p>
          <Button variant="link" size="xs" className="px-0" onClick={() => history.refetch()}>
            {t("retry")}
          </Button>
        </div>
      )}
      {history.isSuccess && items.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      )}

      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((item) => {
            const active = item.id === activeId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => go(`/research?c=${item.id}`)}
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-start transition-colors hover:bg-accent",
                    active && "bg-accent font-semibold",
                  )}
                >
                  <span className="block truncate text-sm" dir="auto">
                    {item.title}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {format.relativeTime(new Date(item.updatedAt), now)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {history.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={history.isFetchingNextPage}
          onClick={() => history.fetchNextPage()}
        >
          {history.isFetchingNextPage && <LoaderCircle className="animate-spin" aria-hidden />}
          {t("loadMore")}
        </Button>
      )}
    </nav>
  );
}
