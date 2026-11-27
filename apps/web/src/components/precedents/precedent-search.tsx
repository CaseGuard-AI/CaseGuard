"use client";

import { GitBranch, Info, LoaderCircle, Search } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";
import { FlagChips } from "@/components/research/trust-details";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  precedentErrorKey,
  useSearchPrecedents,
  type PrecedentFilters,
  type PrecedentHit,
} from "./queries";
import { RelationshipsPanel } from "./relationships-panel";

/** Hits per search, retrieved and graph-derived together (api.v1 default and maximum 50). */
const LIMIT = 20;

const fieldClass =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";

/** The form's filters, with empty fields left out (an omitted filter doesn't narrow). */
function filtersOf(form: Record<keyof PrecedentFilters, string>): PrecedentFilters | undefined {
  const entries = Object.entries(form)
    .map(([k, v]) => [k, v.trim()] as const)
    .filter(([, v]) => v !== "");
  return entries.length ? (Object.fromEntries(entries) as PrecedentFilters) : undefined;
}

const emptyFilters: Record<keyof PrecedentFilters, string> = {
  court: "",
  area: "",
  decidedFrom: "",
  decidedTo: "",
  sectionRef: "",
};

// The precedent search screen (FR-PREC-1, ADR-0011): judgments from hybrid retrieval, plus the
// judgments linked to them in the knowledge graph, each labelled by origin (FR-PREC-3).
export function PrecedentSearch() {
  const t = useTranslations("Precedents");
  const search = useSearchPrecedents();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(emptyFilters);
  const [includeGraph, setIncludeGraph] = useState(true);
  const [selected, setSelected] = useState<PrecedentHit | null>(null);
  const ids = {
    court: useId(),
    area: useId(),
    decidedFrom: useId(),
    decidedTo: useId(),
    sectionRef: useId(),
    graph: useId(),
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || search.isPending) return;
    const f = filtersOf(filters);
    search.mutate({
      query: trimmed,
      ...(f ? { filters: f } : {}),
      includeGraphDerived: includeGraph,
      limit: LIMIT,
    });
  }

  const field = (key: keyof PrecedentFilters, type: "text" | "date" = "text", max = 120) => (
    <div className="space-y-1">
      <label htmlFor={ids[key]} className="text-xs font-medium text-muted-foreground">
        {t(`search.${key}`)}
      </label>
      <input
        id={ids[key]}
        type={type}
        value={filters[key]}
        maxLength={type === "text" ? max : undefined}
        placeholder={type === "text" ? t(`search.${key}Placeholder`) : undefined}
        onChange={(e) => setFilters((old) => ({ ...old, [key]: e.target.value }))}
        dir={type === "date" ? "ltr" : "auto"}
        className={fieldClass}
      />
    </div>
  );

  const result = search.data;
  return (
    <div className="space-y-6">
      <form
        onSubmit={submit}
        role="search"
        aria-label={t("search.label")}
        className="space-y-4 rounded-md border bg-card p-4"
      >
        {search.isError && (
          <p
            role="alert"
            className="rounded-sm border border-danger/20 bg-danger-soft p-3 text-sm text-danger"
          >
            {t(`errors.${precedentErrorKey(search.error)}`)}
          </p>
        )}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("search.label")}
              placeholder={t("search.placeholder")}
              maxLength={1000}
              dir="auto"
              className={cn(fieldClass, "ps-9")}
            />
          </div>
          <Button type="submit" disabled={search.isPending || !query.trim()}>
            {search.isPending && <LoaderCircle className="animate-spin" aria-hidden />}
            {t("search.submit")}
          </Button>
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <legend className="sr-only">{t("search.filters")}</legend>
          {field("court")}
          {field("area", "text", 80)}
          {field("decidedFrom", "date")}
          {field("decidedTo", "date")}
          {field("sectionRef")}
        </fieldset>
        <div className="flex items-center gap-3">
          <Switch id={ids.graph} checked={includeGraph} onCheckedChange={setIncludeGraph} />
          <label htmlFor={ids.graph} className="text-sm">
            {t("search.includeGraph")}
            <span className="block text-[11px] text-muted-foreground">
              {t("search.includeGraphHint")}
            </span>
          </label>
        </div>
      </form>

      {!result && !search.isPending && (
        <p className="text-sm text-muted-foreground">{t("results.intro")}</p>
      )}

      {result && (
        <section aria-label={t("results.label")} className="space-y-3">
          {!result.graphAvailable && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-sm border border-warning/20 bg-warning-soft p-3 text-sm text-warning"
            >
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t("results.noGraph")}
            </p>
          )}
          <p className="text-xs font-medium text-muted-foreground">
            {t("results.count", { count: result.hits.length })}
          </p>
          {result.hits.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("results.empty")}</p>
          ) : (
            <ol aria-label={t("results.label")} className="space-y-3">
              {result.hits.map((hit) => (
                <HitCard
                  key={hit.sourceId}
                  hit={hit}
                  hits={result.hits}
                  onOpen={() => setSelected(hit)}
                />
              ))}
            </ol>
          )}
        </section>
      )}

      <RelationshipsPanel hit={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function OriginBadge({ hit, hits }: { hit: PrecedentHit; hits: readonly PrecedentHit[] }) {
  const t = useTranslations("Precedents");
  if (hit.origin === "retrieved" || !hit.via) {
    return (
      <span
        data-origin="retrieved"
        className="inline-flex items-center rounded-sm border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
      >
        {t("origin.retrieved")}
      </span>
    );
  }
  const via = hit.via;
  const related = hits.find((h) => h.sourceId === via.relatedSourceId);
  const values = {
    edge: t(`edgeTypes.${via.type}`),
    title: related?.title ?? t("origin.unknownTitle"),
    section: via.sectionLabel ?? "",
  };
  return (
    <span
      data-origin="graph_derived"
      data-edge={via.type}
      className="inline-flex items-center gap-1 rounded-sm border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
    >
      <GitBranch className="size-3" aria-hidden />
      {via.sectionLabel
        ? t("origin.graphDerivedSection", values)
        : t("origin.graphDerived", values)}
    </span>
  );
}

function HitCard({
  hit,
  hits,
  onOpen,
}: {
  hit: PrecedentHit;
  hits: readonly PrecedentHit[];
  onOpen: () => void;
}) {
  const t = useTranslations("Precedents");
  const format = useFormatter();
  // The whole card opens the relationships panel. The title is the button, so keyboard users tab
  // to it; a click anywhere else on the card bubbles up to the same handler.
  return (
    <li
      data-hit={hit.sourceId}
      data-origin={hit.origin}
      onClick={onOpen}
      className={cn(
        "cursor-pointer space-y-2 rounded-md border bg-card p-4 transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-accent/50",
        hit.origin === "graph_derived" && "ms-4 border-dashed sm:ms-8",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button
          type="button"
          className="text-start text-sm font-semibold outline-none hover:underline"
          aria-label={t("results.open", { title: hit.title })}
          dir="auto"
        >
          {hit.title}
        </button>
        <OriginBadge hit={hit} hits={hits} />
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {hit.citation && <span dir="ltr">{hit.citation}</span>}
        {hit.court && <span>{hit.court}</span>}
        {hit.decidedOn && (
          <span>
            {t("results.decided", {
              date: format.dateTime(new Date(hit.decidedOn), {
                dateStyle: "medium",
                timeZone: "UTC",
              }),
            })}
          </span>
        )}
      </p>
      <FlagChips flags={hit.flags} />
      {hit.snippet && (
        <blockquote className="border-s-2 border-primary bg-muted/60 p-3 text-sm leading-6 whitespace-pre-line">
          {hit.locator && (
            <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              {t("results.locator", { locator: hit.locator })}
            </span>
          )}
          <span dir="auto">{hit.snippet}</span>
        </blockquote>
      )}
    </li>
  );
}
