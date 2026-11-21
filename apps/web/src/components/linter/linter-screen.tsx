"use client";

import { Briefcase, FileText, LoaderCircle, RotateCcw, ShieldCheck } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, type ChangeEvent } from "react";
import { useCase } from "@/components/cases/queries";
import { CaseSelect } from "@/components/research/case-picker";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { ApiError, statusOf } from "@/lib/api-query";
import { countFindings, FindingsList, SeverityCounts } from "./findings";
import { PastReports } from "./past-reports";
import {
  characterCount,
  DOCUMENT_TYPES,
  MAX_TEXT,
  useCreateLintReport,
  useDeleteLintReport,
  useLintReport,
  useLintRulesets,
  type LintDocumentType,
  type LintReport,
} from "./queries";
import { TextView } from "./text-view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fromUrl = (value: string | null) => (value && UUID.test(value) ? value : null);

const FIELD =
  "rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

/** The words for a failed lint or save: the API's answers, or no answer at all. */
function errorKey(error: unknown) {
  const status = statusOf(error);
  if (status === undefined) return "network";
  if (status === 400 && error instanceof ApiError) {
    if (error.problem?.errors?.some((e) => e.path === "caseId")) return "caseId";
  }
  if (status === 429) return "rateLimited";
  if (status === 503) return "unavailable";
  return "generic";
}

// The procedural linter (FR-LINT-1, FR-LINT-2, FR-LINT-3). `?case=<id>` preselects the case to
// save to and `?report=<id>` opens a past report, so the screen reads the URL (inside Suspense).
export function LinterScreen() {
  const params = useSearchParams();
  const [openId, setOpenId] = useState(() => fromUrl(params.get("report")));

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-6">
        {openId ? (
          <ReportView reportId={openId} onOpen={setOpenId} onClose={() => setOpenId(null)} />
        ) : (
          <LintForm initialCaseId={fromUrl(params.get("case"))} onLinted={setOpenId} />
        )}
      </div>
      <PastReports
        openId={openId}
        onOpen={setOpenId}
        onDeleted={(id) => setOpenId((open) => (open === id ? null : open))}
      />
    </div>
  );
}

function LintForm({
  initialCaseId,
  onLinted,
}: {
  initialCaseId: string | null;
  onLinted: (reportId: string) => void;
}) {
  const t = useTranslations("Linter");
  const ids = { type: useId(), text: useId(), file: useId(), case: useId(), hint: useId() };
  const [documentType, setDocumentType] = useState<LintDocumentType>("bail_application");
  const [text, setText] = useState("");
  const [caseId, setCaseId] = useState<string | null>(initialCaseId);
  const [fileError, setFileError] = useState<"notText" | "fileError" | null>(null);
  const create = useCreateLintReport();

  const count = characterCount(text);
  const tooLong = count > MAX_TEXT;
  const blank = text.trim() === "";

  async function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!(file.type === "text/plain" || /\.txt$/i.test(file.name))) {
      setFileError("notText");
      return;
    }
    try {
      // Read in the browser: the file itself is never uploaded.
      setText(await file.text());
      setFileError(null);
    } catch {
      setFileError("fileError");
    }
  }

  function lint() {
    if (blank || tooLong) return;
    create.mutate(
      { documentType, text, ...(caseId ? { caseId } : {}) },
      { onSuccess: (report) => onLinted(report.id) },
    );
  }

  return (
    <section className="rounded-md border bg-card p-5 sm:p-6">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          lint();
        }}
      >
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.type} className="text-sm font-medium">
              {t("form.typeLabel")}
            </label>
            <select
              id={ids.type}
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value as LintDocumentType)}
              className={`h-9 ${FIELD}`}
            >
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`form.types.${type}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.case} className="flex items-center gap-1 text-sm font-medium">
              <Briefcase className="size-4 text-muted-foreground" aria-hidden />
              {t("form.caseLabel")}
            </label>
            <CaseSelect id={ids.case} value={caseId ?? ""} current={caseId} onChange={setCaseId} />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={ids.text} className="text-sm font-medium">
              {t("form.textLabel")}
            </label>
            <label
              htmlFor={ids.file}
              className="inline-flex cursor-pointer items-center gap-1 text-sm text-primary hover:underline"
            >
              <FileText className="size-4" aria-hidden />
              {t("form.loadFile")}
            </label>
            <input
              id={ids.file}
              type="file"
              accept=".txt,text/plain"
              className="sr-only"
              aria-describedby={ids.hint}
              onChange={(event) => void load(event)}
            />
          </div>
          <textarea
            id={ids.text}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("form.textPlaceholder")}
            dir="auto"
            rows={14}
            aria-invalid={tooLong || undefined}
            className={`min-h-64 w-full resize-y py-2 leading-relaxed ${FIELD}`}
          />
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <p id={ids.hint}>{t("form.fileHint")}</p>
            <p className={tooLong ? "text-danger" : undefined}>
              {t("form.count", { count, max: MAX_TEXT })}
            </p>
          </div>
          {fileError && (
            <p role="alert" className="text-sm text-danger">
              {t(`form.${fileError}`)}
            </p>
          )}
          {tooLong && (
            <p role="alert" className="text-sm text-danger">
              {t("form.tooLong", { max: MAX_TEXT })}
            </p>
          )}
        </div>

        {create.isError && (
          <p role="alert" className="text-sm text-danger">
            {t(`errors.${errorKey(create.error)}`)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={blank || tooLong || create.isPending}>
            {create.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : (
              <ShieldCheck aria-hidden />
            )}
            {t(create.isPending ? "form.linting" : "form.lint")}
          </Button>
          {blank && <p className="text-xs text-muted-foreground">{t("form.empty")}</p>}
        </div>
      </form>
    </section>
  );
}

function ReportView({
  reportId,
  onOpen,
  onClose,
}: {
  reportId: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("Linter");
  const report = useLintReport(reportId);
  const [selected, setSelected] = useState<{ id: string; index: number } | null>(null);

  if (report.isPending)
    return (
      <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {t("report.loading")}
      </p>
    );

  if (report.isError)
    return (
      <div role="alert" className="space-y-3 rounded-md border bg-card p-5 text-sm">
        <p className="text-danger">
          {statusOf(report.error) === 404 ? t("report.missing") : t("errors.network")}
        </p>
        <Button variant="outline" size="sm" onClick={onClose}>
          <RotateCcw aria-hidden />
          {t("result.newLint")}
        </Button>
      </div>
    );

  const data = report.data;
  const index = selected?.id === data.id ? selected.index : null;
  const span = index === null ? null : (data.findings[index]?.span ?? null);

  return (
    <>
      <ReportSummary report={data} onOpen={onOpen} onClose={onClose} />
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="min-w-0 rounded-md border bg-card p-5">
          <h2 className="mb-1 text-base font-semibold">{t("result.title")}</h2>
          <p className="mb-4 text-xs text-muted-foreground">{t("result.englishNote")}</p>
          {data.findings.length === 0 ? (
            <p className="text-sm">{t("result.clean")}</p>
          ) : (
            <Findings
              report={data}
              selected={index}
              onSelect={(i) => setSelected({ id: data.id, index: i })}
            />
          )}
        </section>
        <section className="min-w-0 rounded-md border bg-card p-5">
          <h2 className="mb-1 text-base font-semibold">{t("result.textTitle")}</h2>
          <p className="mb-4 text-xs text-muted-foreground">{t("result.unchanged")}</p>
          <TextView text={data.text} span={span} label={t("result.textTitle")} />
        </section>
      </div>
    </>
  );
}

function Findings({
  report,
  selected,
  onSelect,
}: {
  report: LintReport;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const rulesets = useLintRulesets();
  const ruleset = rulesets.data?.items.find((r) => r.id === report.rulesetId);
  return (
    <FindingsList
      findings={report.findings}
      ruleset={ruleset}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

function ReportSummary({
  report,
  onOpen,
  onClose,
}: {
  report: LintReport;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("Linter");
  const rulesets = useLintRulesets();
  const ruleset = rulesets.data?.items.find((r) => r.id === report.rulesetId);

  return (
    <section className="space-y-3 rounded-md border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold" dir="auto">
            {report.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("result.ruleset", {
              title: ruleset?.title ?? t(`form.types.${report.documentType}`),
              version: report.rulesetVersion,
            })}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          <RotateCcw aria-hidden />
          {t("result.newLint")}
        </Button>
      </div>
      <SeverityCounts counts={countFindings(report.findings)} />
      {report.caseId ? (
        <SavedIn caseId={report.caseId} />
      ) : (
        <SaveToCase report={report} onSaved={onOpen} />
      )}
    </section>
  );
}

function SavedIn({ caseId }: { caseId: string }) {
  const t = useTranslations("Linter.result");
  const found = useCase(caseId);
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <Briefcase className="size-4 text-muted-foreground" aria-hidden />
      <span dir="auto">{t("inCase", { title: found.data?.title ?? "…" })}</span>
      <Link href={`/cases/${caseId}`} className="text-xs text-primary hover:underline">
        {t("openCase")}
      </Link>
    </p>
  );
}

// api.v1 has no way to move a report into a case, so saving creates the same text as a report in
// the case (FR-CASE-5) and then deletes the unsaved one.
function SaveToCase({ report, onSaved }: { report: LintReport; onSaved: (id: string) => void }) {
  const t = useTranslations("Linter");
  const id = useId();
  const [caseId, setCaseId] = useState<string | null>(null);
  const create = useCreateLintReport();
  const remove = useDeleteLintReport();

  function save() {
    if (!caseId) return;
    create.mutate(
      {
        documentType: report.documentType,
        text: report.text,
        title: report.title,
        caseId,
        ...(report.draftId ? { draftId: report.draftId } : {}),
      },
      {
        onSuccess: (saved) => {
          onSaved(saved.id);
          remove.mutate(report.id);
        },
      },
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Briefcase className="size-4 text-muted-foreground" aria-hidden />
      <label htmlFor={id} className="text-muted-foreground">
        {t("form.caseLabel")}
      </label>
      <CaseSelect id={id} value={caseId ?? ""} pending={create.isPending} onChange={setCaseId} />
      <Button size="sm" variant="outline" disabled={!caseId || create.isPending} onClick={save}>
        {create.isPending && <LoaderCircle className="animate-spin" aria-hidden />}
        {t(create.isPending ? "result.saving" : "result.save")}
      </Button>
      {create.isError && (
        <p role="alert" className="w-full text-xs text-danger">
          {t(
            errorKey(create.error) === "generic"
              ? "result.saveError"
              : `errors.${errorKey(create.error)}`,
          )}
        </p>
      )}
    </div>
  );
}
