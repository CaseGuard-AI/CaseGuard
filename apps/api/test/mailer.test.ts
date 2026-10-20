import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseEnv } from "../src/config/env.js";
import { createLogger } from "../src/lib/logger.js";
import { MailNotConfiguredError, createMailer, type MailEnv } from "../src/lib/mailer.js";

const base: MailEnv = {
  SMTP_HOST: undefined,
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: undefined,
  SMTP_PASSWORD: undefined,
  MAIL_FROM: "CaseGuard <no-reply@caseguard.local>",
};

describe("mailer", () => {
  it("without SMTP_HOST, send fails closed and logs no body", async () => {
    const logger = createLogger("silent", false);
    const error = vi.spyOn(logger, "error");
    const mailer = createMailer(base, logger);
    await expect(
      mailer.send({ to: "a@example.com", subject: "Hi", text: "secret-link" }),
    ).rejects.toBeInstanceOf(MailNotConfiguredError);
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-link");
  });

  it("parses SMTP settings from the environment", () => {
    const env = parseEnv({
      API_DATABASE_URL: "postgresql://x@localhost/db",
      AI_SERVICE_TOKEN: "t".repeat(16),
      JWT_SECRET: "j".repeat(32),
      SMTP_HOST: "localhost",
      SMTP_PORT: "1025",
      SMTP_SECURE: "false",
    });
    expect(env).toMatchObject({ SMTP_HOST: "localhost", SMTP_PORT: 1025, SMTP_SECURE: false });
  });
});

// Runs where Mailpit is available (CI service container, or `docker compose up -d mailpit`).
const mailpit = process.env.MAILPIT_URL;

describe.skipIf(!mailpit)("mailer → Mailpit", () => {
  it("delivers a message that Mailpit receives", async () => {
    const mailer = createMailer(
      {
        ...base,
        SMTP_HOST: new URL(mailpit!).hostname,
        SMTP_PORT: Number(process.env.MAILPIT_SMTP_PORT ?? 1025),
      },
      createLogger("silent", false),
    );
    const subject = `test ${randomUUID()}`;
    await mailer.send({ to: "user@example.com", subject, text: "Hello from CaseGuard" });

    const search = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
    );
    const { messages } = (await search.json()) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    expect(messages).toHaveLength(1);
    expect(messages[0]!.To[0]!.Address).toBe("user@example.com");

    const message = (await (
      await fetch(`${mailpit}/api/v1/message/${messages[0]!.ID}`)
    ).json()) as {
      Text: string;
    };
    expect(message.Text).toContain("Hello from CaseGuard");
  });
});
