"use client";

import { LoaderCircle, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent, type ReactNode } from "react";
import { FormField } from "@/components/auth/form-field";
import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import { usePathname, useRouter } from "@/i18n/navigation";
import { statusOf } from "@/lib/api-query";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { markLocaleApplied } from "./account-preferences";
import { ModelsKeysSection } from "./models-keys";
import { useSettings, useUpdateSettings, type UserSettings } from "./queries";
import { Section } from "./section";

type Locale = UserSettings["locale"];

const NAME_MAX = 120;
const locales: Locale[] = ["en", "ur"];
const themes: { value: Theme; icon: LucideIcon }[] = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

/** The message key under `Settings.errors` for a failed save. */
const saveErrorKey = (error: unknown) => {
  const status = statusOf(error);
  return status === undefined ? "network" : status === 400 ? "invalid" : "generic";
};

// FR-SET-1 and FR-SET-2: the user's name, language, theme, model keys and default model.
// Each section saves on its own.
export function SettingsForm() {
  const t = useTranslations("Settings");
  const settings = useSettings();

  if (settings.isPending) {
    return (
      <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  if (settings.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
        <p>{t(statusOf(settings.error) === undefined ? "errors.network" : "loadError")}</p>
        <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid max-w-2xl gap-6">
      <ProfileSection settings={settings.data} />
      <LanguageSection settings={settings.data} />
      <ThemeSection settings={settings.data} />
      <ModelsKeysSection settings={settings.data} />
    </div>
  );
}

function ProfileSection({ settings }: { settings: UserSettings }) {
  const t = useTranslations("Settings");
  const session = useSession();
  const update = useUpdateSettings();
  const [name, setName] = useState(settings.name);
  const [invalid, setInvalid] = useState<"required" | "tooLong">();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const problem = !trimmed ? "required" : trimmed.length > NAME_MAX ? "tooLong" : undefined;
    setInvalid(problem);
    if (problem) return;
    update.mutate({ name: trimmed }, { onSuccess: (saved) => setName(saved.name) });
  };

  const error = invalid
    ? t(`profile.errors.${invalid}`, { max: NAME_MAX })
    : update.isError
      ? t(`errors.${saveErrorKey(update.error)}`)
      : undefined;

  return (
    <Section title={t("profile.title")} body={t("profile.body")}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <FormField
          label={t("profile.name")}
          name="name"
          autoComplete="name"
          dir="auto"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setInvalid(undefined);
            update.reset();
          }}
          error={error}
        />
        {session.status === "authenticated" && (
          <FormField
            label={t("profile.email")}
            hint={t("profile.emailHint")}
            value={session.user.email}
            dir="ltr"
            readOnly
          />
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={update.isPending || name === settings.name}>
            {update.isPending && <LoaderCircle className="animate-spin" aria-hidden />}
            {t("profile.save")}
          </Button>
          {update.isSuccess && (
            <p role="status" className="text-sm text-success">
              {t("saved")}
            </p>
          )}
        </div>
      </form>
    </Section>
  );
}

function LanguageSection({ settings }: { settings: UserSettings }) {
  const t = useTranslations("Settings");
  const update = useUpdateSettings();
  const router = useRouter();
  const pathname = usePathname();
  const current = useLocale();

  // Saved first, then the page moves to the new locale, so the saved value never lags the URL.
  const choose = (locale: Locale) =>
    update.mutate(
      { locale },
      {
        onSuccess: () => {
          markLocaleApplied();
          if (locale !== current) router.replace(pathname, { locale });
        },
      },
    );

  return (
    <Section title={t("language.title")} body={t("language.body")}>
      <Choices
        legend={t("language.title")}
        name="locale"
        value={update.isPending ? update.variables.locale : settings.locale}
        pending={update.isPending}
        error={update.isError ? t(`errors.${saveErrorKey(update.error)}`) : undefined}
        onChange={choose}
        options={locales.map((locale) => ({
          value: locale,
          // Each language is named in itself, so it is readable whichever UI is showing.
          label: (
            <span lang={locale} dir={locale === "ur" ? "rtl" : "ltr"}>
              {t(`language.names.${locale}`)}
            </span>
          ),
        }))}
      />
    </Section>
  );
}

function ThemeSection({ settings }: { settings: UserSettings }) {
  const t = useTranslations("Settings");
  const update = useUpdateSettings();

  // AccountPreferences applies the theme once the saved value lands in the cache.
  return (
    <Section title={t("theme.title")} body={t("theme.body")}>
      <Choices
        legend={t("theme.title")}
        name="theme"
        value={update.isPending ? update.variables.theme : settings.theme}
        pending={update.isPending}
        error={update.isError ? t(`errors.${saveErrorKey(update.error)}`) : undefined}
        onChange={(theme) => update.mutate({ theme })}
        options={themes.map(({ value, icon: Icon }) => ({
          value,
          label: (
            <>
              <Icon className="size-4 text-muted-foreground" aria-hidden />
              {t(`theme.${value}`)}
            </>
          ),
        }))}
      />
    </Section>
  );
}

// A radio group of cards, built on native radios so keyboard and screen readers work as usual.
function Choices<T extends string>({
  legend,
  name,
  value,
  options,
  pending,
  error,
  onChange,
}: {
  legend: string;
  name: string;
  value: T | undefined;
  options: { value: T; label: ReactNode }[];
  pending: boolean;
  error?: string;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset disabled={pending} aria-busy={pending || undefined} className="space-y-3">
      <legend className="sr-only">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-md border bg-background p-3 text-sm font-medium transition-colors",
              "hover:bg-accent has-[:checked]:border-primary has-[:checked]:bg-accent",
              "has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 has-[:disabled]:cursor-wait",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="size-4 accent-primary"
            />
            {option.label}
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}
