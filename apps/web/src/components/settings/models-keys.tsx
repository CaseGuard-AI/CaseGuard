"use client";

import { Cloud, HardDrive, KeyRound, LoaderCircle } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";
import { FormField } from "@/components/auth/form-field";
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
import { Label } from "@/components/ui/label";
import { statusOf } from "@/lib/api-query";
import {
  useDeleteKey,
  useKeys,
  useModels,
  usePutKey,
  useUpdateSettings,
  type DefaultModel,
  type ProviderModels,
  type UserKey,
  type UserSettings,
} from "./queries";
import { Section } from "./section";

// UserKeyInput.apiKey in api.v1.
const KEY_MIN = 8;
const KEY_MAX = 512;

/** The message key under `Settings.models.errors` for a failed key save. */
const keyErrorKey = (error: unknown) => {
  const status = statusOf(error);
  if (status === undefined) return "network";
  if (status === 403) return "keyForbidden";
  if (status === 503) return "keysUnavailable";
  if (status === 400) return "keyInvalid";
  return "keyGeneric";
};

/** The message key under `Settings.models.errors` for a failed default-model save. */
const modelErrorKey = (error: unknown) => {
  const status = statusOf(error);
  if (status === undefined) return "network";
  return status === 403 || status === 400 ? "modelUnavailable" : "modelGeneric";
};

// A <select> value for a model; "" is the deployment default (null).
const DEPLOYMENT = "";
const encode = (choice: DefaultModel | null | undefined) =>
  choice ? JSON.stringify([choice.providerId, choice.model]) : DEPLOYMENT;
const decode = (value: string): DefaultModel | null => {
  if (value === DEPLOYMENT) return null;
  const [providerId, model] = JSON.parse(value) as [string, string];
  return { providerId, model };
};

// FR-SET-2 (ADR-0009): the user's own keys for the enabled cloud providers, and the model their
// questions use. The API returns only a key's last four characters, never the key.
export function ModelsKeysSection({ settings }: { settings: UserSettings }) {
  const t = useTranslations("Settings");
  const models = useModels();
  const keys = useKeys();

  const body = () => {
    if (models.isPending || keys.isPending) {
      return (
        <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          {t("loading")}
        </p>
      );
    }
    if (models.isError || keys.isError) {
      const network = statusOf(models.error ?? keys.error) === undefined;
      return (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
          <p>{t(network ? "errors.network" : "models.loadError")}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (models.isError) void models.refetch();
              if (keys.isError) void keys.refetch();
            }}
          >
            {t("retry")}
          </Button>
        </div>
      );
    }
    if (models.data.length === 0) {
      return <p className="text-sm text-muted-foreground">{t("models.empty")}</p>;
    }

    const byProvider = new Map(keys.data.map((key) => [key.providerId, key]));
    return (
      <div className="space-y-6">
        <ul className="space-y-3">
          {models.data.map((provider) => (
            <ProviderRow
              key={provider.providerId}
              provider={provider}
              saved={byProvider.get(provider.providerId)}
            />
          ))}
        </ul>
        <DefaultModelField settings={settings} providers={models.data} />
      </div>
    );
  };

  return (
    <Section title={t("models.title")} body={t("models.body")}>
      {body()}
    </Section>
  );
}

function ProviderRow({ provider, saved }: { provider: ProviderModels; saved?: UserKey }) {
  const t = useTranslations("Settings.models");
  const format = useFormatter();
  const cloud = provider.kind === "cloud";
  const KindIcon = cloud ? Cloud : HardDrive;
  const headingId = useId();

  return (
    <li aria-labelledby={headingId} className="space-y-3 rounded-md border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
          <KindIcon className="size-4 text-muted-foreground" aria-hidden />
          {provider.name}
        </h3>
        {cloud && saved ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" aria-hidden />
            <span
              dir="ltr"
              className="font-mono"
              aria-label={t("savedKey", { last4: saved.last4 })}
            >
              ••••{saved.last4}
            </span>
            <span>
              {t("updated", {
                date: format.dateTime(new Date(saved.updatedAt), { dateStyle: "medium" }),
              })}
            </span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t(cloud ? "noKey" : "noKeyNeeded")}</p>
        )}
      </div>
      {cloud && <KeyForm provider={provider} saved={saved} />}
    </li>
  );
}

function KeyForm({ provider, saved }: { provider: ProviderModels; saved?: UserKey }) {
  const t = useTranslations("Settings");
  const put = usePutKey();
  const remove = useDeleteKey();
  // The typed key lives only here until the PUT succeeds, then it is cleared.
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<"saved" | "deleted">();
  const name = provider.name;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setDone(undefined);
    const trimmed = apiKey.trim();
    if (trimmed.length < KEY_MIN) return setError(t("models.errors.keyTooShort", { min: KEY_MIN }));
    if (trimmed.length > KEY_MAX) return setError(t("models.errors.keyTooLong", { max: KEY_MAX }));
    setError(undefined);
    put.mutate(
      { providerId: provider.providerId, apiKey: trimmed },
      {
        onSuccess: () => {
          setApiKey("");
          setDone("saved");
        },
        onError: (failure) => setError(t(`models.errors.${keyErrorKey(failure)}`)),
        // Drops the mutation's copy of the key (its `variables`) once the request is over.
        onSettled: () => put.reset(),
      },
    );
  };

  const onDelete = () => {
    setDone(undefined);
    setError(undefined);
    remove.mutate(provider.providerId, {
      onSuccess: () => setDone("deleted"),
      onError: (failure) =>
        setError(
          t(statusOf(failure) === undefined ? "errors.network" : "models.errors.deleteGeneric"),
        ),
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3">
      <FormField
        label={t("models.keyLabel", { name })}
        hint={t(saved ? "models.keyHintReplace" : "models.keyHint")}
        name={`apiKey-${provider.providerId}`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        value={apiKey}
        onChange={(event) => {
          setApiKey(event.target.value);
          setError(undefined);
          setDone(undefined);
        }}
        error={error}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={put.isPending || remove.isPending || !apiKey}>
          {put.isPending && <LoaderCircle className="animate-spin" aria-hidden />}
          {t(saved ? "models.replace" : "models.save")}
        </Button>
        {saved && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={put.isPending || remove.isPending}
                aria-label={t("models.deleteFor", { name })}
              >
                {remove.isPending && <LoaderCircle className="animate-spin" aria-hidden />}
                {t("models.delete")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("models.confirmTitle", { name })}</AlertDialogTitle>
                <AlertDialogDescription>{t("models.confirmBody", { name })}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("models.cancel")}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onDelete}>
                  {t("models.confirmDelete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        {done && (
          <p role="status" className="text-sm text-success">
            {t(done === "saved" ? "models.keySaved" : "models.keyDeleted")}
          </p>
        )}
      </div>
    </form>
  );
}

// Only cloud providers are offered: a default model is used only with the user's own key
// (DefaultModel in api.v1); local models already run on the deployment's own settings.
function DefaultModelField({
  settings,
  providers,
}: {
  settings: UserSettings;
  providers: ProviderModels[];
}) {
  const t = useTranslations("Settings");
  const update = useUpdateSettings();
  const id = useId();
  const hintId = `${id}-hint`;

  const current = update.isPending ? update.variables.defaultModel : settings.defaultModel;
  const offered = providers.filter((p) => p.kind === "cloud" && p.models.length > 0);
  const provider = current && providers.find((p) => p.providerId === current.providerId);
  const listed =
    !current ||
    offered.some((p) => p.providerId === current.providerId && p.models.includes(current.model));

  const hint = !current
    ? t("models.defaultHint")
    : !listed || !provider
      ? t("models.unavailableHint")
      : !provider.hasKey
        ? t("models.noKeyHint", { name: provider.name })
        : t("models.withKeyHint", { name: provider.name });

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("models.defaultLabel")}</Label>
      <select
        id={id}
        value={encode(current)}
        disabled={update.isPending}
        aria-busy={update.isPending || undefined}
        aria-describedby={hintId}
        aria-invalid={update.isError || undefined}
        onChange={(event) => update.mutate({ defaultModel: decode(event.target.value) })}
        className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-50"
      >
        <option value={DEPLOYMENT}>{t("models.deploymentDefault")}</option>
        {!listed && current && (
          <option value={encode(current)}>{t("models.unlisted", { model: current.model })}</option>
        )}
        {offered.map((p) => (
          <optgroup key={p.providerId} label={p.name}>
            {p.models.map((model) => (
              <option key={model} value={encode({ providerId: p.providerId, model })}>
                {model}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {update.isError && (
        <p role="alert" className="text-xs text-danger">
          {t(`models.errors.${modelErrorKey(update.error)}`)}
        </p>
      )}
      {update.isSuccess && (
        <p role="status" className="text-sm text-success">
          {t("saved")}
        </p>
      )}
    </div>
  );
}
