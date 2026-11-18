"use client";

import { Download, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
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
import { useCase } from "@/components/cases/queries";
import { Link } from "@/i18n/navigation";
import { statusOf } from "@/lib/api-query";
import {
  useDeleteDocument,
  useDocuments,
  useDownloadDocument,
  useRetryDocument,
  type Document,
  type DocumentFlag,
} from "./queries";
import { DocumentStatusBadge } from "./status-badge";

// The caller's documents with their processing status (FR-DOC-3), all of them or one case's
// (FR-CASE-4). The list refreshes itself while anything is queued or processing.
export function DocumentsList({ caseId, showCase = false }: { caseId?: string; showCase?: boolean }) {
  const t = useTranslations("Documents.list");
  const documents = useDocuments(caseId);
  const items = documents.data?.pages.flatMap((page) => page.items) ?? [];

  if (documents.isPending)
    return (
      <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );

  if (documents.isError && items.length === 0)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
        <p>{t(statusOf(documents.error) === undefined ? "networkError" : "error")}</p>
        <Button variant="outline" size="sm" onClick={() => void documents.refetch()}>
          {t("retry")}
        </Button>
      </div>
    );

  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">{t(caseId ? "emptyCase" : "empty")}</p>;

  return (
    <div>
      <ul aria-label={t("label")} className="divide-y rounded-md border">
        {items.map((doc) => (
          <DocumentRow key={doc.id} doc={doc} showCase={showCase} />
        ))}
      </ul>
      {documents.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          disabled={documents.isFetchingNextPage}
          onClick={() => documents.fetchNextPage()}
        >
          {documents.isFetchingNextPage && <LoaderCircle className="animate-spin" aria-hidden />}
          {t("loadMore")}
        </Button>
      )}
    </div>
  );
}

function DocumentRow({ doc, showCase }: { doc: Document; showCase: boolean }) {
  const t = useTranslations("Documents");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const size = format.number(doc.sizeBytes / 1_048_576, {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  });

  return (
    <li className="space-y-3 px-4 py-3" data-document={doc.id}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" dir="auto">
            {doc.filename}
          </p>
          <p className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
            <span>{size}</span>
            {doc.pages !== null && <span>{t("pages", { count: doc.pages })}</span>}
            <span>{t("uploaded", { time: format.relativeTime(new Date(doc.createdAt), now) })}</span>
            {showCase && <CaseName caseId={doc.caseId} />}
          </p>
        </div>
        <DocumentStatusBadge status={doc.status} flagCount={doc.flags.length} />
      </div>
      {doc.flags.length > 0 && <Flags flags={doc.flags} />}
      {doc.status === "failed" && (
        <p role="status" className="text-sm text-danger" dir="auto">
          {doc.error ?? t("failedNoReason")}
        </p>
      )}
      <Actions doc={doc} />
    </li>
  );
}

function CaseName({ caseId }: { caseId: string }) {
  const t = useTranslations("Documents");
  const found = useCase(caseId);
  return (
    <Link href={`/cases/${caseId}`} className="underline-offset-2 hover:underline" dir="auto">
      {found.data?.title ?? t("openCase")}
    </Link>
  );
}

// What was uncertain (FR-DOC-4). A code the UI doesn't know still shows the API's message.
function Flags({ flags }: { flags: DocumentFlag[] }) {
  const t = useTranslations("Documents");
  return (
    <div className="rounded-sm border border-warning/20 bg-warning-soft p-3 text-sm">
      <p className="font-medium text-warning">{t("flaggedNote")}</p>
      <ul aria-label={t("flagsLabel")} className="mt-2 space-y-1">
        {flags.map((flag, i) => (
          <li key={i} className="text-foreground">
            <span className="font-medium">
              {t(`stages.${flag.stage}`)} ·{" "}
              {flag.page === null ? t("wholeDocument") : t("page", { page: flag.page })}
            </span>
            : <span dir="auto">{flag.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Actions({ doc }: { doc: Document }) {
  const t = useTranslations("Documents.actions");
  const download = useDownloadDocument();
  const retry = useRetryDocument();
  const remove = useDeleteDocument();
  const failed = [download, retry, remove].find((m) => m.isError);
  const errorKey =
    failed === download ? "downloadError" : failed === retry ? "retryError" : "deleteError";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={download.isPending}
          onClick={() => download.mutate(doc)}
        >
          {download.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden />
          ) : (
            <Download aria-hidden />
          )}
          {t("download")}
        </Button>
        {(doc.status === "failed" || doc.status === "flagged") && (
          <Button
            variant="outline"
            size="sm"
            disabled={retry.isPending}
            onClick={() => retry.mutate(doc.id)}
          >
            {retry.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : (
              <RotateCcw aria-hidden />
            )}
            {t("retry")}
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={remove.isPending}>
              {remove.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : (
                <Trash2 aria-hidden />
              )}
              {t("delete")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("deleteBody", { name: doc.filename })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => remove.mutate(doc.id)}>
                {t("deleteConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-danger">
          {t(statusOf(failed.error) === undefined ? "networkError" : errorKey)}
        </p>
      )}
    </div>
  );
}
