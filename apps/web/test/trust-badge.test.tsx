import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { TrustBadge } from "@/components/trust-badge";
import en from "../messages/en.json";
import ur from "../messages/ur.json";

function renderIn(locale: "en" | "ur", messages: object) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <TrustBadge status="needs_review" />
    </NextIntlClientProvider>,
  );
}

describe("TrustBadge", () => {
  it("renders the stored status label in English", () => {
    renderIn("en", en);
    expect(screen.getByText("Needs review").dataset.status).toBe("needs_review");
  });

  it("renders the same status in Urdu", () => {
    renderIn("ur", ur);
    expect(screen.getByText("جائزہ درکار")).toBeTruthy();
  });
});
