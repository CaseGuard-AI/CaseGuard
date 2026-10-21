import { problemOf } from "@/lib/api";

export type Field = "email" | "password" | "name";
export type FormErrors = { form?: string; fields: Partial<Record<Field, string>> };

const fields: readonly string[] = ["email", "password", "name"] satisfies Field[];

// Maps an auth response to messages in the UI language. The API's own text is English, so we show
// ours, and fall back to the API's only for a field we don't know (FR-I18N-1).
export function authErrors(
  status: number | undefined,
  error: unknown,
  t: (key: string) => string,
): FormErrors {
  if (status === undefined) return { form: t("network"), fields: {} };
  if (status === 401) return { form: t("invalidCredentials"), fields: {} };
  if (status === 409) return { fields: { email: t("emailTaken") } };
  if (status === 429) return { form: t("tooMany"), fields: {} };

  const problem = problemOf(error);
  if (status === 400 && problem?.errors?.length) {
    const result: FormErrors = { fields: {} };
    for (const { path, message } of problem.errors) {
      if (fields.includes(path)) result.fields[path as Field] ??= t(path);
      else result.form ??= message;
    }
    return result;
  }
  return { form: t("generic"), fields: {} };
}
