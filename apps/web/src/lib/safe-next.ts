// Where to go after signing in. Only same-site paths count, so `?next=` can't send the user to
// another site (`//evil.example`, `/\evil.example`), and the auth pages never loop back on themselves.
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\\\u0000-\u001f]/.test(value)) return "/";
  if (/^\/(login|register)(\/|\?|$)/.test(value)) return "/";
  return value;
}
