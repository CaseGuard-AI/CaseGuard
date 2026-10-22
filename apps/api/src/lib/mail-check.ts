// Sends one test email with the SMTP settings in .env, so a provider can be checked before a
// user ever asks for a password reset (#116).
//
// Usage: tsx src/lib/mail-check.ts --to <email>
//        (Docker: docker compose exec api node dist/lib/mail-check.js --to …)
//
// Prints which server it used and the outcome, never SMTP_PASSWORD.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { parseMailEnv } from "../config/env.js";
import { createLogger } from "./logger.js";
import { MailNotConfiguredError, createMailer } from "./mailer.js";

const email = z.string().trim().pipe(z.email().max(254));

/** Parses the CLI arguments. Rejects anything unknown. */
export function parseMailCheckArgs(argv: string[]): { to: string } {
  const { values } = parseArgs({ args: argv, options: { to: { type: "string" } }, strict: true });
  if (!values.to) throw new Error("--to is required");
  return { to: email.parse(values.to) };
}

/** Turns an SMTP failure into a plain-words hint. */
export function explainMailError(err: unknown): string {
  if (err instanceof MailNotConfiguredError) {
    return "SMTP_HOST is not set in .env, so email is disabled";
  }
  const e = (err ?? {}) as { code?: string; responseCode?: number; message?: string };
  if (e.code === "EAUTH" || e.responseCode === 535) {
    return (
      "the server rejected SMTP_USER / SMTP_PASSWORD. For Gmail, SMTP_USER is the full address " +
      "and SMTP_PASSWORD is a 16-character app password, not the account password"
    );
  }
  if (e.code === "EDNS") return "SMTP_HOST could not be resolved; check the host name";
  if (e.code === "ETIMEDOUT" || e.code === "ECONNECTION" || e.code === "ESOCKET") {
    return (
      "could not connect to SMTP_HOST:SMTP_PORT. Check the port, and that SMTP_SECURE=true " +
      "goes with port 465 and SMTP_SECURE=false with 587 or 1025"
    );
  }
  return e.message ?? String(err);
}

async function main(argv: string[]) {
  const { to } = parseMailCheckArgs(argv);
  const env = parseMailEnv();
  const mailer = createMailer(env, createLogger("silent", false));
  process.stdout.write(
    `Sending a test email to ${to} via ${env.SMTP_HOST ?? "(no SMTP_HOST)"}:${env.SMTP_PORT}` +
      ` (secure=${env.SMTP_SECURE}) from ${env.MAIL_FROM}\n`,
  );
  await mailer.send({
    to,
    subject: "CaseGuard test email",
    text: "This is a test email from CaseGuard (pnpm mail:check). Email delivery works.",
  });
  process.stdout.write("Sent. Check the inbox (and the spam folder).\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join("; ")
        : explainMailError(err);
    process.stderr.write(`mail:check failed: ${message}\n`);
    process.exit(1);
  });
}
