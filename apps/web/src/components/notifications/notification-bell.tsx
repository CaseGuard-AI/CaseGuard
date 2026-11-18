"use client";

import { Bell } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { NotificationList } from "./notification-list";
import { useUnreadCount } from "./queries";

// The header bell (FR-NOT-1). The dot shows only when something is unread, so it never sits
// there permanently (plans/0017).
export function NotificationBell() {
  const t = useTranslations("Notifications");
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount().data ?? 0;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={unread > 0 ? t("openUnread", { count: unread }) : t("open")}
        onClick={() => setOpen(true)}
      >
        <Bell />
        {unread > 0 && (
          <span
            data-testid="unread-dot"
            aria-hidden
            className="absolute end-2 top-2 size-2 rounded-full bg-danger ring-2 ring-card"
          />
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="end" closeLabel={t("close")} className="gap-0 sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>{t("title")}</SheetTitle>
            <SheetDescription>{t("subtitle")}</SheetDescription>
          </SheetHeader>
          <NotificationList open={open} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
