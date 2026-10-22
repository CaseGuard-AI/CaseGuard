"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import type { Schemas } from "@/lib/api";
import { signIn } from "@/lib/session";
import { authErrors, type FormErrors } from "./auth-errors";

type AuthResult = { data?: Schemas["Session"]; error?: unknown; response: Response };

// Submits a login or register form. On success the session store signs in, and
// RedirectIfSignedIn takes the user on; on failure the errors come back localised.
export function useAuthSubmit(request: (form: FormData) => Promise<AuthResult>) {
  const t = useTranslations("Auth.errors");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrors({ fields: {} });
    try {
      const { data, error, response } = await request(new FormData(event.currentTarget));
      if (data) signIn(data);
      else setErrors(authErrors(response.status, error, t));
    } catch {
      setErrors(authErrors(undefined, undefined, t));
    } finally {
      setPending(false);
    }
  }

  return { pending, errors, onSubmit };
}
