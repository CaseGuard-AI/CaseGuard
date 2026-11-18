"use client";

import { LoaderCircle, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState, type DragEvent } from "react";
import { problemOf } from "@/lib/api";
import { ApiError, statusOf } from "@/lib/api-query";
import { cn } from "@/lib/utils";
import { useUploadDocument } from "./queries";
import { ACCEPT, checkFile } from "./validate";

type UploadError =
  | "type"
  | "size"
  | "empty"
  | "tooLarge"
  | "unsupported"
  | "archived"
  | "notFound"
  | "network"
  | "generic";

// The server's answer, in the user's words. The API sniffs the content, so a file that passed the
// check here can still be refused (415).
function uploadError(error: unknown): UploadError {
  const status = statusOf(error);
  if (status === undefined) return "network";
  if (status === 413) return "tooLarge";
  if (status === 415) return "unsupported";
  if (status === 404) return "notFound";
  if (status === 400) {
    const problem = error instanceof ApiError ? error.problem : problemOf(error);
    if (problem?.errors?.some((e) => e.path === "caseId")) return "archived";
  }
  return "generic";
}

// One file at a time into a case (FR-DOC-1): a drop zone and a file picker, checked here against
// the contract's types and size before anything is sent.
export function DocumentUploader({ caseId }: { caseId: string }) {
  const t = useTranslations("Documents.upload");
  const upload = useUploadDocument(caseId);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [problem, setProblem] = useState<UploadError | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  function send(file: File | undefined) {
    if (!file) return;
    setUploaded(null);
    const local = checkFile(file);
    setProblem(local);
    if (local) return;
    upload.mutate(file, {
      onSuccess: (doc) => setUploaded(doc.filename),
      onError: (error) => setProblem(uploadError(error)),
    });
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    send(event.dataTransfer.files[0]);
  }

  return (
    <div className="space-y-2">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-2 rounded-md border border-dashed p-5 text-center",
          over && "border-primary bg-accent",
        )}
      >
        <Upload className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-sm">{t("drop")}</p>
        <button
          type="button"
          disabled={upload.isPending}
          onClick={() => input.current?.click()}
          className="inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
        >
          {upload.isPending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          {upload.isPending ? t("uploading") : t("choose")}
        </button>
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {t("hint")}
        </p>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          aria-label={t("choose")}
          aria-describedby={hintId}
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            send(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {t(`errors.${problem}`)}
        </p>
      )}
      {uploaded && (
        <p role="status" className="text-sm text-muted-foreground" dir="auto">
          {t("queued", { name: uploaded })}
        </p>
      )}
    </div>
  );
}
