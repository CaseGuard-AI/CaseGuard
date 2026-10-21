"use client";

import { Cloud, HardDrive, LoaderCircle, TriangleAlert } from "lucide-react";
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
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { statusOf } from "@/lib/api-query";
import { cn } from "@/lib/utils";
import { changeErrorKey, useProviders, useSetProvider, type Provider } from "./queries";
import { Forbidden, LoadError, Loading } from "./states";

// The provider allow-list (SEC-11). Case data goes only to the providers switched on here.
export function ProvidersPanel() {
  const t = useTranslations("Admin.providers");
  const providers = useProviders();

  if (statusOf(providers.error) === 403) return <Forbidden />;
  if (providers.isPending) return <Loading />;
  if (providers.isError)
    return (
      <LoadError
        network={statusOf(providers.error) === undefined}
        onRetry={() => void providers.refetch()}
      />
    );

  const { items } = providers.data;
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {items.length > 0 && !items.some((p) => p.enabled) && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-sm border border-warning/20 bg-warning-soft p-3 text-sm text-warning"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {t("noneEnabled")}
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const t = useTranslations("Admin");
  const setEnabled = useSetProvider(provider.id);
  const [confirming, setConfirming] = useState(false);
  const switchId = useId();
  const cloud = provider.kind === "cloud";
  const KindIcon = cloud ? Cloud : HardDrive;

  // Turning on a cloud provider widens where data may go, so it needs a confirmation.
  // Turning anything off, or a local provider on, never does.
  function onCheckedChange(enabled: boolean) {
    if (enabled && cloud) setConfirming(true);
    else setEnabled.mutate(enabled);
  }

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-card p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {provider.name}
          <span
            data-kind={provider.kind}
            className={cn(
              "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-bold",
              cloud
                ? "border-warning/20 bg-warning-soft text-warning"
                : "border-success/20 bg-success-soft text-success",
            )}
          >
            <KindIcon className="size-3" aria-hidden />
            {t(cloud ? "providers.cloud" : "providers.local")}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          <span dir="ltr" className="font-mono">
            {provider.id}
          </span>
          {" · "}
          {t(cloud ? "providers.cloudBody" : "providers.localBody")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {setEnabled.isPending && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />
        )}
        <Switch
          id={switchId}
          aria-label={t("providers.enabledFor", { name: provider.name })}
          checked={provider.enabled}
          disabled={setEnabled.isPending}
          onCheckedChange={onCheckedChange}
        />
      </div>
      {setEnabled.isError && statusOf(setEnabled.error) !== 403 && (
        <p role="alert" className="basis-full text-xs text-danger">
          {t(`errors.${changeErrorKey(setEnabled.error)}`)}
        </p>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("providers.confirmTitle", { name: provider.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("providers.confirmBody", { name: provider.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("providers.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => setEnabled.mutate(true)}>
              {t("providers.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
