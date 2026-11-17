"use client";

import { LoaderCircle, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";
import { FormField } from "@/components/auth/form-field";
import { Section } from "@/components/settings/section";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api-query";
import { cn } from "@/lib/utils";
import {
  useCreateCase,
  useUpdateCase,
  type Case,
  type CaseInput,
  type CaseUpdate,
  type Party,
} from "./queries";

// The bounds of `caseFields` in api.v1 (Deliverable II TBD-24). The API checks the same rules.
const MAX = {
  title: 200,
  court: 120,
  caseNumber: 80,
  caseType: 80,
  status: 80,
  judge: 200,
  assignedLawyer: 120,
  summary: 4000,
  partyName: 200,
  partyLabel: 40,
  law: 120,
  list: 50,
} as const;

type TextField =
  "title" | "court" | "caseNumber" | "caseType" | "status" | "judge" | "assignedLawyer" | "summary";
type DateField = "filedOn" | "nextHearingOn";
type PartyRow = { key: number; side: Party["side"]; name: string; label: string };
type LawRow = { key: number; value: string };
type Draft = Record<TextField | DateField, string> & {
  parties: PartyRow[];
  relevantLaws: LawRow[];
};
/** The fields as the API takes them: trimmed, empty text and dates as `null`. */
type Values = Required<CaseInput>;
type Errors = Record<string, string>;

// React keys for the party and law rows, so removing one row never reuses another's inputs.
let rowKey = 0;
const nextKey = () => ++rowKey;

const nullable = [
  "court",
  "caseNumber",
  "caseType",
  "status",
  "judge",
  "assignedLawyer",
  "summary",
] as const;
const dates = ["filedOn", "nextHearingOn"] as const;

function toDraft(initial: Case | undefined): Draft {
  return {
    title: initial?.title ?? "",
    court: initial?.court ?? "",
    caseNumber: initial?.caseNumber ?? "",
    caseType: initial?.caseType ?? "",
    status: initial?.status ?? "",
    judge: initial?.judge ?? "",
    assignedLawyer: initial?.assignedLawyer ?? "",
    summary: initial?.summary ?? "",
    filedOn: initial?.filedOn ?? "",
    nextHearingOn: initial?.nextHearingOn ?? "",
    parties: (initial?.parties ?? []).map((p) => ({
      key: nextKey(),
      side: p.side,
      name: p.name,
      label: p.label ?? "",
    })),
    relevantLaws: (initial?.relevantLaws ?? []).map((value) => ({ key: nextKey(), value })),
  };
}

function toValues(draft: Draft): Values {
  const text = Object.fromEntries(
    nullable.map((field) => [field, draft[field].trim() || null]),
  ) as Pick<Values, (typeof nullable)[number]>;
  const day = Object.fromEntries(dates.map((field) => [field, draft[field] || null])) as Pick<
    Values,
    DateField
  >;
  return {
    title: draft.title.trim(),
    ...text,
    ...day,
    parties: draft.parties.map(({ side, name, label }) => ({
      side,
      name: name.trim(),
      ...(label.trim() ? { label: label.trim() } : {}),
    })),
    relevantLaws: draft.relevantLaws.map((law) => law.value.trim()),
  };
}

type Translate = (key: string, values?: Record<string, number>) => string;

// The same rules as the contract, so most mistakes are caught before a request.
function validate(values: Values, t: Translate): Errors {
  const errors: Errors = {};
  const tooLong = (max: number) => t("form.errors.tooLong", { max });
  if (!values.title) errors.title = t("form.errors.titleRequired");
  else if (values.title.length > MAX.title) errors.title = tooLong(MAX.title);
  for (const field of nullable) {
    const value = values[field];
    if (value && value.length > MAX[field]) errors[field] = tooLong(MAX[field]);
  }
  if (values.parties.length > MAX.list)
    errors.parties = t("form.errors.tooMany", { max: MAX.list });
  values.parties.forEach((party, i) => {
    if (!party.name) errors[`parties.${i}.name`] = t("form.errors.partyName");
    else if (party.name.length > MAX.partyName)
      errors[`parties.${i}.name`] = tooLong(MAX.partyName);
    if (party.label && party.label.length > MAX.partyLabel)
      errors[`parties.${i}.label`] = tooLong(MAX.partyLabel);
  });
  if (values.relevantLaws.length > MAX.list)
    errors.relevantLaws = t("form.errors.tooMany", { max: MAX.list });
  values.relevantLaws.forEach((law, i) => {
    if (!law) errors[`relevantLaws.${i}`] = t("form.errors.law");
    else if (law.length > MAX.law) errors[`relevantLaws.${i}`] = tooLong(MAX.law);
  });
  return errors;
}

/** Only the fields that differ from the saved case, for a partial PATCH. */
function changes(values: Values, saved: Values): CaseUpdate {
  return Object.fromEntries(
    (Object.keys(values) as (keyof Values)[])
      .filter((key) => JSON.stringify(values[key]) !== JSON.stringify(saved[key]))
      .map((key) => [key, values[key]]),
  ) as CaseUpdate;
}

/** A new case sends only what was filled in; the API stores the rest empty. */
function filled(values: Values): CaseInput {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== null,
    ),
  ) as CaseInput;
}

// Every path the form can show an error at. Anything else from a 400 goes in the form's alert.
function knownPath(path: string, draft: Draft) {
  if ((["title", ...nullable, ...dates, "parties", "relevantLaws"] as string[]).includes(path))
    return true;
  const party = /^parties\.(\d+)\.(name|label|side)$/.exec(path);
  if (party) return Number(party[1]) < draft.parties.length;
  const law = /^relevantLaws\.(\d+)$/.exec(path);
  return law ? Number(law[1]) < draft.relevantLaws.length : false;
}

// Create and edit a case (FR-CASE-1) with the fields of Deliverable II Table 4.29. Editing sends
// only what changed: a cleared field is `null` and an emptied list `[]`.
export function CaseForm({ initial }: { initial?: Case }) {
  const t = useTranslations("Cases");
  const router = useRouter();
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [saved] = useState(() => (initial ? toValues(toDraft(initial)) : undefined));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const create = useCreateCase();
  const update = useUpdateCase(initial?.id ?? "");
  const pending = create.isPending || update.isPending;

  const values = toValues(draft);
  const patch = saved ? changes(values, saved) : undefined;
  const unchanged = patch !== undefined && Object.keys(patch).length === 0;

  function edit(next: Partial<Draft>, ...cleared: string[]) {
    setDraft((old) => ({ ...old, ...next }));
    setFormError(undefined);
    if (cleared.some((path) => errors[path]))
      setErrors((old) =>
        Object.fromEntries(Object.entries(old).filter(([k]) => !cleared.includes(k))),
      );
  }

  function onError(error: unknown) {
    if (!(error instanceof ApiError)) return setFormError(t("form.errors.network"));
    if (error.status !== 400) return setFormError(t("form.errors.generic"));
    const reported = error.problem?.errors ?? [];
    const mapped: Errors = {};
    for (const { path } of reported)
      if (knownPath(path, draft)) mapped[path] = t("form.errors.rejected");
    setErrors(mapped);
    if (Object.keys(mapped).length < reported.length || reported.length === 0)
      setFormError(t("form.errors.server"));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found = validate(values, t);
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;
    const done = { onSuccess: (c: Case) => router.push(`/cases/${c.id}`), onError };
    if (initial) {
      if (!unchanged) update.mutate(patch!, done);
    } else create.mutate(filled(values), done);
  }

  const text = (field: TextField, extra?: { hint?: string }) => (
    <FormField
      label={t(`fields.${field}`)}
      name={field}
      dir="auto"
      maxLength={MAX[field]}
      value={draft[field]}
      onChange={(event) => edit({ [field]: event.target.value }, field)}
      error={errors[field]}
      {...extra}
    />
  );
  const date = (field: DateField) => (
    <FormField
      label={t(`fields.${field}`)}
      name={field}
      type="date"
      value={draft[field]}
      onChange={(event) => edit({ [field]: event.target.value }, field)}
      error={errors[field]}
    />
  );

  return (
    <form onSubmit={onSubmit} noValidate className="grid max-w-3xl gap-6">
      <Section title={t("form.details")} body={t("form.detailsBody")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">{text("title")}</div>
          {text("caseType", { hint: t("form.caseTypeHint") })}
          {text("status", { hint: t("form.statusHint") })}
          <div className="sm:col-span-2">
            <TextArea
              label={t("fields.summary")}
              value={draft.summary}
              maxLength={MAX.summary}
              error={errors.summary}
              onChange={(summary) => edit({ summary }, "summary")}
            />
          </div>
        </div>
      </Section>

      <Section title={t("form.court")} body={t("form.courtBody")}>
        <div className="grid gap-4 sm:grid-cols-2">
          {text("court")}
          {text("caseNumber")}
          {text("judge")}
          {text("assignedLawyer")}
          {date("filedOn")}
          {date("nextHearingOn")}
        </div>
      </Section>

      <Section title={t("fields.parties")} body={t("form.partiesBody")}>
        <div className="space-y-4">
          {draft.parties.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("form.noParties")}</p>
          )}
          {draft.parties.map((party, i) => {
            const set = (change: Partial<PartyRow>, ...cleared: string[]) =>
              edit(
                {
                  parties: draft.parties.map((p) =>
                    p.key === party.key ? { ...p, ...change } : p,
                  ),
                },
                ...cleared,
              );
            return (
              <fieldset
                key={party.key}
                className="grid gap-3 rounded-md border p-3 sm:grid-cols-[10rem_1fr_10rem_auto] sm:items-start"
              >
                <legend className="sr-only">{t("form.party", { n: i + 1 })}</legend>
                <SideSelect
                  label={t("form.partySide", { n: i + 1 })}
                  value={party.side}
                  onChange={(side) => set({ side })}
                />
                <FormField
                  label={t("form.partyName", { n: i + 1 })}
                  dir="auto"
                  maxLength={MAX.partyName}
                  value={party.name}
                  onChange={(event) => set({ name: event.target.value }, `parties.${i}.name`)}
                  error={errors[`parties.${i}.name`]}
                />
                <FormField
                  label={t("form.partyLabel", { n: i + 1 })}
                  placeholder={t("form.partyLabelExample")}
                  dir="auto"
                  maxLength={MAX.partyLabel}
                  value={party.label}
                  onChange={(event) => set({ label: event.target.value }, `parties.${i}.label`)}
                  error={errors[`parties.${i}.label`]}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="sm:mt-6"
                  aria-label={t("form.removeParty", { n: i + 1 })}
                  onClick={() =>
                    edit({ parties: draft.parties.filter((p) => p.key !== party.key) })
                  }
                >
                  <X aria-hidden />
                </Button>
              </fieldset>
            );
          })}
          {errors.parties && (
            <p role="alert" className="text-xs text-danger">
              {errors.parties}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={draft.parties.length >= MAX.list}
            onClick={() =>
              edit({
                parties: [
                  ...draft.parties,
                  { key: nextKey(), side: "claimant", name: "", label: "" },
                ],
              })
            }
          >
            <Plus aria-hidden />
            {t("form.addParty")}
          </Button>
        </div>
      </Section>

      <Section title={t("fields.relevantLaws")} body={t("form.lawsBody")}>
        <div className="space-y-3">
          {draft.relevantLaws.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("form.noLaws")}</p>
          )}
          {draft.relevantLaws.map((law, i) => (
            <div key={law.key} className="flex items-start gap-2">
              <div className="flex-1">
                <FormField
                  label={t("form.law", { n: i + 1 })}
                  placeholder={t("form.lawExample")}
                  dir="auto"
                  maxLength={MAX.law}
                  value={law.value}
                  onChange={(event) =>
                    edit(
                      {
                        relevantLaws: draft.relevantLaws.map((l) =>
                          l.key === law.key ? { ...l, value: event.target.value } : l,
                        ),
                      },
                      `relevantLaws.${i}`,
                    )
                  }
                  error={errors[`relevantLaws.${i}`]}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mt-6"
                aria-label={t("form.removeLaw", { n: i + 1 })}
                onClick={() =>
                  edit({ relevantLaws: draft.relevantLaws.filter((l) => l.key !== law.key) })
                }
              >
                <X aria-hidden />
              </Button>
            </div>
          ))}
          {errors.relevantLaws && (
            <p role="alert" className="text-xs text-danger">
              {errors.relevantLaws}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={draft.relevantLaws.length >= MAX.list}
            onClick={() =>
              edit({ relevantLaws: [...draft.relevantLaws, { key: nextKey(), value: "" }] })
            }
          >
            <Plus aria-hidden />
            {t("form.addLaw")}
          </Button>
        </div>
      </Section>

      {formError && (
        <p
          role="alert"
          className="rounded-sm border border-danger/20 bg-danger-soft p-3 text-sm text-danger"
        >
          {formError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || unchanged}>
          {pending && <LoaderCircle className="animate-spin" aria-hidden />}
          {t(initial ? "form.save" : "form.create")}
        </Button>
        <Button variant="outline" asChild>
          <Link href={initial ? `/cases/${initial.id}` : "/cases"}>{t("form.cancel")}</Link>
        </Button>
      </div>
    </form>
  );
}

function SideSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Party["side"];
  onChange: (side: Party["side"]) => void;
}) {
  const t = useTranslations("Cases");
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as Party["side"])}
        className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <option value="claimant">{t("sides.claimant")}</option>
        <option value="respondent">{t("sides.respondent")}</option>
      </select>
    </div>
  );
}

function TextArea({
  label,
  value,
  maxLength,
  error,
  onChange,
}: {
  label: string;
  value: string;
  maxLength: number;
  error?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        name="summary"
        dir="auto"
        value={value}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive",
        )}
      />
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
