"use client";

import { History, LoaderCircle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useRouter } from "@/i18n/navigation";
import { statusOf } from "@/lib/api-query";
import { AnswerCard } from "./answer-card";
import { AskBox } from "./ask-box";
import { CasePicker, NewCaseChip, useCaseAvailable } from "./case-picker";
import { HistoryList } from "./history-list";
import { researchErrorKey, useAsk, useConversation } from "./queries";
import { SourcePanel } from "./source-panel";
import type { Numbered } from "./sources-list";

// The Research Hub (#14): the thread of the conversation in `?c=`, the ask box, and the source
// panel for the citation that is open. A first question starts the conversation. The history
// (FR-RES-8) is a column at the start side on desktop and a drawer on smaller screens.
export function ResearchHub() {
  const t = useTranslations("Research");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  // The URL alone decides the conversation, so the sidebar's Research link starts a fresh one.
  // `?case=` starts the next new conversation in that case (FR-CASE-5, FR-CASE-6).
  const params = useSearchParams();
  const conversationId = params.get("c");
  const newCaseId = conversationId ? null : params.get("case");
  const caseAvailable = useCaseAvailable(newCaseId);
  const conversation = useConversation(conversationId);
  const ask = useAsk((id) => router.replace(`/research?c=${id}`));
  const [open, setOpen] = useState<Numbered | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // A conversation that is gone, or isn't this user's, starts a fresh page.
  const missing = statusOf(conversation.error) === 404;
  useEffect(() => {
    if (missing) router.replace("/research");
  }, [missing, router]);

  async function onAsk(question: string, lawAsOf?: string) {
    try {
      await ask.mutateAsync({
        conversationId: missing ? null : conversationId,
        question,
        lawAsOf,
        caseId: newCaseId && caseAvailable ? newCaseId : undefined,
      });
      return true;
    } catch {
      return false;
    }
  }

  const messages = conversation.data?.messages ?? [];

  return (
    <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-8">
      <aside className="hidden lg:block lg:border-e lg:pe-6">
        <HistoryList activeId={conversationId} />
      </aside>
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="start"
          closeLabel={tCommon("close")}
          aria-describedby={undefined}
          className="overflow-y-auto"
        >
          <SheetHeader>
            <SheetTitle>{t("history.title")}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <HistoryList activeId={conversationId} onNavigate={() => setHistoryOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
      <div className="min-w-0 space-y-6">
        <Button
          variant="outline"
          size="sm"
          className="lg:hidden"
          onClick={() => setHistoryOpen(true)}
        >
          <History aria-hidden />
          {t("history.open")}
        </Button>
        {conversation.data && <CasePicker conversation={conversation.data} />}
        {newCaseId && (
          <NewCaseChip caseId={newCaseId} onClear={() => router.replace("/research")} />
        )}
        {conversation.isLoading && (
          <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {t("loading")}
          </p>
        )}
        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="ms-auto max-w-2xl rounded-md bg-muted p-4">
              <p className="text-[11px] font-bold text-muted-foreground">{t("you")}</p>
              <p className="mt-1 text-sm whitespace-pre-line" dir="auto">
                {message.text}
              </p>
            </div>
          ) : (
            <AnswerCard key={message.id} message={message} onOpen={setOpen} />
          ),
        )}
        {ask.isPending && (
          <>
            <div className="ms-auto max-w-2xl rounded-md bg-muted p-4">
              <p className="text-[11px] font-bold text-muted-foreground">{t("you")}</p>
              <p className="mt-1 text-sm whitespace-pre-line" dir="auto">
                {ask.variables.question}
              </p>
            </div>
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              {t("asking")}
            </p>
          </>
        )}
        <AskBox
          pending={ask.isPending}
          error={ask.isError ? t(`errors.${researchErrorKey(ask.error)}`) : undefined}
          onAsk={onAsk}
        />
        <SourcePanel item={open} onClose={() => setOpen(null)} />
      </div>
    </div>
  );
}
