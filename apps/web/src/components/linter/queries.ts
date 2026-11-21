"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, problemOf, type Schemas } from "@/lib/api";
import { ApiError, unwrap } from "@/lib/api-query";

export type LintDocumentType = Schemas["LintDocumentType"];
export type LintFinding = Schemas["LintFinding"];
export type LintFindingKind = Schemas["LintFindingKind"];
export type LintSeverity = Schemas["LintSeverity"];
export type LintRuleset = Schemas["LintRuleset"];
export type LintReport = Schemas["LintReport"];
export type LintReportSummary = Schemas["LintReportSummary"];
export type LintReportCreate = Schemas["LintReportCreate"];
export type LintReportUpdate = Schemas["LintReportUpdate"];

export const DOCUMENT_TYPES: LintDocumentType[] = ["bail_application", "plaint"];
export const KINDS: LintFindingKind[] = ["missing_section", "missing_particular", "structure"];
export const SEVERITIES: LintSeverity[] = ["error", "warning", "info"];
/** api.v1 LintReportCreate.text maxLength, in characters (code points). */
export const MAX_TEXT = 200_000;

// Every lint query starts with `lintKey`, so one invalidation refreshes every list.
export const lintKey = ["lint"] as const;
const reportsKey = (caseId?: string) => [...lintKey, "reports", caseId ?? "all"] as const;
const reportKey = (id: string) => [...lintKey, "report", id] as const;
const PAGE = 20;

// The rule sets never change while the app runs: fetched once (FR-LINT-2).
export function useLintRulesets() {
  return useQuery({
    queryKey: [...lintKey, "rulesets"],
    queryFn: () => unwrap(api.GET("/lint/rulesets")),
    staleTime: Infinity,
  });
}

// The caller's reports, newest first, optionally of one case (FR-CASE-4).
export function useLintReports(caseId?: string) {
  return useInfiniteQuery({
    queryKey: reportsKey(caseId),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/lint-reports", { params: { query: { caseId, cursor: pageParam, limit: PAGE } } }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useLintReport(id: string | null) {
  return useQuery({
    queryKey: reportKey(id ?? ""),
    queryFn: () =>
      unwrap(api.GET("/lint-reports/{reportId}", { params: { path: { reportId: id! } } })),
    enabled: Boolean(id),
    retry: false,
  });
}

/** Lints the text and keeps the report. The report is cached, so opening it costs no request. */
export function useCreateLintReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LintReportCreate) => unwrap(api.POST("/lint-reports", { body })),
    onSuccess: (report) => {
      client.setQueryData(reportKey(report.id), report);
      void client.invalidateQueries({ queryKey: [...lintKey, "reports"] });
    },
  });
}

/** Saves the report to a case, detaches it or renames it, in place (FR-CASE-5). */
export function useUpdateLintReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ reportId, body }: { reportId: string; body: LintReportUpdate }) =>
      unwrap(api.PATCH("/lint-reports/{reportId}", { params: { path: { reportId } }, body })),
    onSuccess: (report) => {
      client.setQueryData(reportKey(report.id), report);
      void client.invalidateQueries({ queryKey: [...lintKey, "reports"] });
    },
  });
}

export function useDeleteLintReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (reportId: string) => {
      const { error, response } = await api.DELETE("/lint-reports/{reportId}", {
        params: { path: { reportId } },
      });
      if (!response.ok) throw new ApiError(response.status, problemOf(error));
    },
    onSuccess: (_, reportId) => {
      client.removeQueries({ queryKey: reportKey(reportId) });
      void client.invalidateQueries({ queryKey: [...lintKey, "reports"] });
    },
  });
}

/** Length in characters as the contract counts them: an emoji is one, not two UTF-16 units. */
export const characterCount = (text: string) =>
  text.length - (text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);
