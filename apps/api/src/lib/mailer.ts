import nodemailer from "nodemailer";
import type { Env } from "../config/env.js";
import type { Logger } from "./logger.js";

// Transactional email over SMTP (#61). Dev and CI send to Mailpit (docker-compose.yml);
// production points SMTP_* at any provider. Message bodies can hold secrets (reset links),
// so only the subject and message id are ever logged.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** Sends one message. Rejects if SMTP isn't configured or the server refuses it. */
  send(message: MailMessage): Promise<void>;
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super("SMTP is not configured (set SMTP_HOST)");
  }
}

export type MailEnv = Pick<
  Env,
  "SMTP_HOST" | "SMTP_PORT" | "SMTP_SECURE" | "SMTP_USER" | "SMTP_PASSWORD" | "MAIL_FROM"
>;

export function createMailer(env: MailEnv, logger: Logger): Mailer {
  if (!env.SMTP_HOST) {
    logger.warn("SMTP_HOST is not set: email is disabled and every send fails");
    return {
      send: async (message) => {
        logger.error({ subject: message.subject }, "email not sent: SMTP is not configured");
        throw new MailNotConfiguredError();
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } } : {}),
  });

  return {
    send: async (message) => {
      const info = await transport.sendMail({ from: env.MAIL_FROM, ...message });
      logger.info({ subject: message.subject, messageId: info.messageId }, "email sent");
    },
  };
}
