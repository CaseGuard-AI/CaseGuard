"use client";

import { Download, LoaderCircle, RotateCcw, Save, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { CaseSelect } from "@/components/research/case-picker";
import type { Citation } from "@/components/research/queries";
import { SourcePanel } from "@/components/research/source-panel";
import type { Numbered } from "@/components/research/sources-list";
import { useRouter } from "@/i18n/navigation";
import { statusOf } from "@/lib/api-query";
import { AssistPanel } from "./assist-panel";
import {
  useDeleteDraft,
  useDraft,
  useDraftTemplates,
  useExportDraft,
  useSaveDraft,
  type Draft,
  type DraftAssist,
  type DraftTemplate,
} from "./queries";
import { SectionCitations, numberedCitations } from "./section-citations";

// The drafting studio's editor (FR-DRAFT-1..4): the fields, then one plain textarea per section in
// template order, with AI assist, save, export and delete.
export function DraftEditor({ draftId }: { draftId: string }) {
  const t = useTranslations("Drafting.editor");
  const draft = useDraft(draftId);
  const templates = useDraftTemplates();
  // Bumped by "Reload" after a 409, so the form starts again from the saved draft.
  const [generation, setGeneration] = useState(0);

  if (draft.isPending || templates.isPending)
    return (
      <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );

  if (draft.isError || templates.isError) {
    const missing = statusOf(draft.error) === 404;
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
        <p>{t(missing ? "notFound" : "error")}</p>
        {!missing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void draft.refetch();
              void templates.refetch();
            }}
          >
            {t("retry")}
          </Button>
        )}
      </div>
    );
  }

  const template = templates.data.items.find((x) => x.id === draft.data.templateId);
  if (!template) return <p role="alert">{t("error")}</p>;

  return (
    <DraftForm
      key={`${draft.data.id}:${generation}`}
      draft={draft.data}
      template={template}
      onReload={async () => {
        await draft.refetch();
        setGeneration((g) => g + 1);
      }}
    />
  );
}

type Values = {
  title: string;
  caseId: string | null;
  fields: Record<string, string | null>;
  sections: Record<string, string>;
};

const valuesOf = (draft: Draft): Values => ({
  title: draft.title,
  caseId: draft.caseId,
  fields: { ...draft.fields },
  sections: Object.fromEntries(draft.sections.map((s) => [s.key, s.body])),
});

function DraftForm({
  draft,
  template,
  onReload,
}: {
  draft: Draft;
  template: DraftTemplate;
  onReload: () => Promise<void>;
}) {
  const t = useTranslations("Drafting.editor");
  const router = useRouter();
  const ids = useId();
  const save = useSaveDraft(draft.id);
  const remove = useDeleteDraft(draft.id);
  const exporter = useExportDraft(draft.id);
  const [saved, setSaved] = useState(() => valuesOf(draft));
  const [values, setValues] = useState(saved);
  const [version, setVersion] = useState(draft.version);
  const [open, setOpen] = useState<Numbered | null>(null);
  // Every citation the editor knows: the draft's, plus any assist returned since (FR-TRUST-10).
  const [known, setKnown] = useState(
    () => new Map<string, Citation>(draft.citations.map((c) => [c.id, c])),
  );
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const conflict = statusOf(save.error) === 409;

  const setSection = (key: string, body: string) =>
    setValues((v) => ({ ...v, sections: { ...v.sections, [key]: body } }));

  const applySuggestion = (key: string, result: DraftAssist, mode: "insert" | "replace") => {
    setKnown((m) => new Map([...m, ...result.citations.map((c) => [c.id, c] as const)]));
    const current = values.sections[key] ?? "";
    setSection(
      key,
      mode === "replace" || !current.trim()
        ? result.text
        : `${current.trimEnd()}\n\n${result.text}`,
    );
  };

  const submit = () =>
    save.mutate(
      {
        version,
        title: values.title.trim() || draft.title,
        caseId: values.caseId,
        fields: values.fields,
        sections: template.sections.map((s) => ({
          key: s.key,
          body: values.sections[s.key] ?? "",
        })),
      },
      {
        onSuccess: (next) => {
          const fresh = valuesOf(next);
          setVersion(next.version);
          setSaved(fresh);
          setValues(fresh);
          setKnown((m) => new Map([...m, ...next.citations.map((c) => [c.id, c] as const)]));
        },
      },
    );

  const saveError = save.isError && !conflict ? saveErrorKey(save.error) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={`${ids}-title`} className="text-xs font-medium text-muted-foreground">
            {t("title")}
          </label>
          <Input
            id={`${ids}-title`}
            value={values.title}
            maxLength={200}
            dir="auto"
            onChange={(event) => setValues((v) => ({ ...v, title: event.target.value }))}
          />
          <p className="text-[11px] text-muted-foreground">
            {t("template", { title: template.title, version: draft.templateVersion })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={submit} disabled={save.isPending || !dirty}>
            {save.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : (
              <Save aria-hidden />
            )}
            {t(dirty ? "save" : "saved")}
          </Button>
          {(["docx", "pdf"] as const).map((format) => (
            <Button
              key={format}
              variant="outline"
              disabled={exporter.isPending}
              title={dirty ? t("exportSavedOnly") : undefined}
              onClick={() => exporter.mutate({ format, title: saved.title })}
            >
              <Download aria-hidden />
              {t(format === "docx" ? "exportDocx" : "exportPdf")}
            </Button>
          ))}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" disabled={remove.isPending}>
                <Trash2 aria-hidden />
                {t("delete")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("deleteBody", { title: saved.title })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    remove.mutate(undefined, { onSuccess: () => router.push("/drafting") })
                  }
                >
                  {t("deleteConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-sm border border-warning/20 bg-warning-soft p-3 text-sm"
        >
          <p>{t("conflict")}</p>
          <Button variant="outline" size="sm" onClick={() => void onReload()}>
            <RotateCcw aria-hidden />
            {t("reload")}
          </Button>
        </div>
      )}
      {saveError && (
        <p role="alert" className="text-sm text-danger">
          {t(saveError)}
        </p>
      )}
      {exporter.isError && (
        <p role="alert" className="text-sm text-danger">
          {t("exportError")}
        </p>
      )}
      {remove.isError && (
        <p role="alert" className="text-sm text-danger">
          {t("deleteError")}
        </p>
      )}

      <section className="rounded-md border bg-card p-5 sm:p-6">
        <h2 className="text-base font-semibold">{t("particulars")}</h2>
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor={`${ids}-case`} className="text-muted-foreground">
              {t("case")}
            </label>
            <CaseSelect
              id={`${ids}-case`}
              value={values.caseId}
              current={draft.caseId}
              onChange={(caseId) => setValues((v) => ({ ...v, caseId }))}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {template.fields.map((f) => (
              <div key={f.key} className="space-y-1">
                <label htmlFor={`${ids}-f-${f.key}`} className="text-xs font-medium">
                  {f.label}
                  {f.required && <span className="text-muted-foreground"> {t("required")}</span>}
                </label>
                <textarea
                  id={`${ids}-f-${f.key}`}
                  rows={f.caseField === "parties" || f.caseField === "relevantLaws" ? 3 : 1}
                  maxLength={4000}
                  dir="auto"
                  value={values.fields[f.key] ?? ""}
                  onChange={(event) =>
                    setValues((v) => ({
                      ...v,
                      fields: { ...v.fields, [f.key]: event.target.value || null },
                    }))
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {template.sections.map((s) => {
        const body = values.sections[s.key] ?? "";
        return (
          <section key={s.key} className="space-y-3 rounded-md border bg-card p-5 sm:p-6">
            <div>
              <h2 className="text-base font-semibold">
                <label htmlFor={`${ids}-s-${s.key}`}>{s.heading}</label>
                {s.required && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {" "}
                    {t("required")}
                  </span>
                )}
              </h2>
              <p id={`${ids}-g-${s.key}`} className="mt-1 text-sm text-muted-foreground">
                {s.guidance}
              </p>
            </div>
            <textarea
              id={`${ids}-s-${s.key}`}
              aria-describedby={`${ids}-g-${s.key}`}
              rows={6}
              maxLength={20000}
              dir="auto"
              value={body}
              onChange={(event) => setSection(s.key, event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <SectionCitations
              items={numberedCitations(body, known)}
              onOpen={setOpen}
              label={t("sectionCitations", { heading: s.heading })}
            />
            {s.assistable && (
              <AssistPanel
                draftId={draft.id}
                sectionKey={s.key}
                heading={s.heading}
                onUse={(result, mode) => applySuggestion(s.key, result, mode)}
                onOpen={setOpen}
              />
            )}
          </section>
        );
      })}
      <SourcePanel item={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function saveErrorKey(error: unknown): string {
  const status = statusOf(error);
  if (status === undefined) return "networkError";
  if (status === 400) return "invalid";
  return "saveError";
}
