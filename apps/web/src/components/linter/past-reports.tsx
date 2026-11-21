"use client";

import { Briefcase, LoaderCircle, Trash2 } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SeverityCounts } from "./findings";
import { useDeleteLintReport, useLintReports, type LintReportSummary } from "./queries";

// The caller's lint reports, newest first. Opening one shows it on the screen; delete asks first.
export function PastReports({
  openId,
  onOpen,
  onDeleted,
}: {
  openId: string | null;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("Linter.past");
  const reports = useLintReports();
  const items = reports.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="rounded-md border bg-card p-5">
      <h2 className="text-base font-semibold">{t("title")}</h2>
      <div className="mt-3">
        {reports.isPending && (
          <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {t("loading")}
          </p>
        )}
        {reports.isError && items.length === 0 && (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
            <p>{t("error")}</p>
            <Button variant="outline" size="sm" onClick={() => void reports.refetch()}>
              {t("retry")}
            </Button>
          </div>
        )}
        {reports.isSuccess && items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}
        {items.length > 0 && (
          <ul aria-label={t("title")} className="divide-y rounded-md border">
            {items.map((item) => (
              <ReportRow
                key={item.id}
                item={item}
                open={item.id === openId}
                onOpen={() => onOpen(item.id)}
                onDeleted={() => onDeleted(item.id)}
              />
            ))}
          </ul>
        )}
        {reports.hasNextPage && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full"
            disabled={reports.isFetchingNextPage}
            onClick={() => reports.fetchNextPage()}
          >
            {reports.isFetchingNextPage && <LoaderCircle className="animate-spin" aria-hidden />}
            {t("loadMore")}
          </Button>
        )}
      </div>
    </section>
  );
}

function ReportRow({
  item,
  open,
  onOpen,
  onDeleted,
}: {
  item: LintReportSummary;
  open: boolean;
  onOpen: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("Linter.past");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const remove = useDeleteLintReport();

  return (
    <li className={cn("flex items-start gap-2 px-3 py-3", open && "bg-accent")}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={open || undefined}
        className="min-w-0 flex-1 text-start"
      >
        <span className="flex items-center gap-1 truncate text-sm font-medium" dir="auto">
          {item.caseId && <Briefcase className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
          {item.title}
        </span>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {format.relativeTime(new Date(item.createdAt), now)}
        </span>
        <span className="mt-1 block">
          <SeverityCounts counts={item.findingCounts} />
        </span>
      </button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${t("delete")}: ${item.title}`}
            disabled={remove.isPending}
          >
            <Trash2 aria-hidden />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate(item.id, { onSuccess: onDeleted })}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {remove.isError && (
        <p role="alert" className="text-xs text-danger">
          {t("deleteError")}
        </p>
      )}
    </li>
  );
}
