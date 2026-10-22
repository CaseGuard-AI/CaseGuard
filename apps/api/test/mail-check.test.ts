import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseMailEnv } from "../src/config/env.js";
import { explainMailError, parseMailCheckArgs } from "../src/lib/mail-check.js";
import { MailNotConfiguredError } from "../src/lib/mailer.js";

describe("mail:check", () => {
  it("requires a valid --to", () => {
    expect(parseMailCheckArgs(["--to", " a@example.com "])).toEqual({ to: "a@example.com" });
    expect(() => parseMailCheckArgs([])).toThrow("--to is required");
    expect(() => parseMailCheckArgs(["--to", "nope"])).toThrow(ZodError);
    expect(() => parseMailCheckArgs(["--to", "a@example.com", "--password", "x"])).toThrow();
  });

  it("needs only the SMTP settings, not the database or secrets", () => {
    const env = parseMailEnv({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "me@gmail.com",
    });
    expect(env).toMatchObject({ SMTP_HOST: "smtp.gmail.com", SMTP_PORT: 465, SMTP_SECURE: true });
  });

  it("explains common SMTP failures in plain words", () => {
    expect(explainMailError(new MailNotConfiguredError())).toContain("SMTP_HOST is not set");
    expect(explainMailError({ code: "EAUTH", responseCode: 535 })).toContain("app password");
    expect(explainMailError({ code: "EDNS" })).toContain("could not be resolved");
    expect(explainMailError({ code: "ESOCKET" })).toContain("SMTP_SECURE=true");
    expect(explainMailError(new Error("other"))).toBe("other");
  });
});
