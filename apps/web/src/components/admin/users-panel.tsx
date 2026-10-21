"use client";

import { LoaderCircle } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { statusOf } from "@/lib/api-query";
import { changeErrorKey, useAdminUsers, useSetUserAi, type AdminUser } from "./queries";
import { Forbidden, LoadError, Loading } from "./states";

export function UsersPanel({ currentUserId }: { currentUserId: string }) {
  const t = useTranslations("Admin.users");
  const users = useAdminUsers();

  if (statusOf(users.error) === 403) return <Forbidden />;
  if (users.isPending) return <Loading />;
  if (users.isError)
    return (
      <LoadError
        network={statusOf(users.error) === undefined}
        onRetry={() => void users.refetch()}
      />
    );

  const items = users.data.pages.flatMap((page) => page.items);
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((user) => (
            <UserRow key={user.id} user={user} isYou={user.id === currentUserId} />
          ))}
        </ul>
      )}
      {users.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => void users.fetchNextPage()}
          disabled={users.isFetchingNextPage}
        >
          {users.isFetchingNextPage && <LoaderCircle className="animate-spin" aria-hidden />}
          {t("loadMore")}
        </Button>
      )}
    </section>
  );
}

function UserRow({ user, isYou }: { user: AdminUser; isYou: boolean }) {
  const t = useTranslations("Admin");
  const tRoles = useTranslations("Nav.roles");
  const format = useFormatter();
  const setAi = useSetUserAi(user.id);
  const switchId = useId();

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-card p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <span dir="auto">{user.name}</span>
          {isYou && (
            <span className="rounded-sm bg-info-soft px-1.5 py-0.5 text-[10px] font-bold text-info">
              {t("users.you")}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground" dir="ltr">
          {user.email}
        </p>
        <p className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
          <span className="font-semibold">{tRoles(user.role)}</span>
          <span>{t("users.language", { locale: t(`users.locales.${user.locale}`) })}</span>
          <span>
            {t("users.joined", {
              date: format.dateTime(new Date(user.createdAt), { dateStyle: "medium" }),
            })}
          </span>
        </p>
      </div>
      <div className="flex items-center gap-2">
        {setAi.isPending && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />
        )}
        <label htmlFor={switchId} className="text-xs font-semibold">
          {t("users.aiAccess")}
        </label>
        <Switch
          id={switchId}
          aria-label={t("users.aiFor", { name: user.name })}
          checked={user.aiEnabled}
          disabled={setAi.isPending}
          onCheckedChange={(checked) => setAi.mutate(checked)}
        />
      </div>
      {setAi.isError && statusOf(setAi.error) !== 403 && (
        <p role="alert" className="basis-full text-xs text-danger">
          {t(`errors.${changeErrorKey(setAi.error)}`)}
        </p>
      )}
    </li>
  );
}
