import type { ReactNode } from "react";

/** One card on the settings page: a heading, a line of explanation and its controls. */
export function Section({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border bg-card p-5 sm:p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 mb-5 text-sm text-muted-foreground">{body}</p>
      {children}
    </section>
  );
}
