"use client";

import { FilePlus2, LoaderCircle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CaseSelect } from "@/components/research/case-picker";
import { useRouter } from "@/i18n/navigation";
import { ApiError, statusOf } from "@/lib/api-query";
import { useCreateDraft, useDraftTemplates, type DraftTemplateId } from "./queries";

// Start a draft (FR-DRAFT-1, FR-DRAFT-2): a template, and optionally a case whose fields fill it.
// `?case=<id>` preselects the case, for the case dashboard's link. Reads the URL, so it sits
// inside Suspense.
export function NewDraft() {
  const t = useTranslations("Drafting.new");
  const ids = useId();
  const router = useRouter();
  const params = useSearchParams();
  const templates = useDraftTemplates();
  const create = useCreateDraft();
  const [templateId, setTemplateId] = useState<DraftTemplateId | null>(null);
  const [caseId, setCaseId] = useState<string | null>(params.get("case"));
  const [title, setTitle] = useState("");

  const caseRejected =
    create.error instanceof ApiError &&
    create.error.status === 400 &&
    create.error.problem?.errors?.some((e) => e.path === "caseId");

  return (
    <section className="rounded-md border bg-card p-5 sm:p-6">
      <h2 className="text-base font-semibold">{t("title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("body")}</p>
      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!templateId) return;
          create.mutate(
            {
              templateId,
              ...(caseId ? { caseId } : {}),
              ...(title.trim() ? { title: title.trim() } : {}),
            },
            { onSuccess: (draft) => router.push(`/drafting/${draft.id}`) },
          );
        }}
      >
        <fieldset>
          <legend className="text-xs font-medium">{t("template")}</legend>
          {templates.isPending && (
            <p aria-busy="true" className="mt-2 text-sm text-muted-foreground">
              {t("loadingTemplates")}
            </p>
          )}
          {templates.isError && (
            <div
              role="alert"
              className="mt-2 flex flex-wrap items-center gap-3 text-sm text-danger"
            >
              <p>{t("templatesError")}</p>
              <Button variant="outline" size="sm" onClick={() => void templates.refetch()}>
                {t("retry")}
              </Button>
            </div>
          )}
          <div className="mt-2 grid gap-3 md:grid-cols-3">
            {templates.data?.items.map((tpl) => (
              <label
                key={tpl.id}
                className="flex cursor-pointer gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-info-soft"
              >
                <input
                  type="radio"
                  name={`${ids}-template`}
                  value={tpl.id}
                  checked={templateId === tpl.id}
                  onChange={() => setTemplateId(tpl.id)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium">{tpl.title}</span>
                  <span className="block text-xs text-muted-foreground">{tpl.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={`${ids}-case`} className="text-muted-foreground">
            {t("case")}
          </label>
          <CaseSelect id={`${ids}-case`} value={caseId} current={caseId} onChange={setCaseId} />
          <span className="text-xs text-muted-foreground">{t("caseHint")}</span>
        </div>
        <div className="max-w-md space-y-1">
          <label htmlFor={`${ids}-title`} className="text-xs font-medium">
            {t("titleLabel")}
          </label>
          <Input
            id={`${ids}-title`}
            value={title}
            maxLength={200}
            dir="auto"
            placeholder={t("titlePlaceholder")}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={!templateId || create.isPending}>
          {create.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden />
          ) : (
            <FilePlus2 aria-hidden />
          )}
          {t("create")}
        </Button>
        {create.isError && (
          <p role="alert" className="text-sm text-danger">
            {t(
              caseRejected
                ? "caseUnavailable"
                : statusOf(create.error) === undefined
                  ? "networkError"
                  : "error",
            )}
          </p>
        )}
      </form>
    </section>
  );
}
