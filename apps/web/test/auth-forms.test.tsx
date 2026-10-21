import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import ur from "../messages/ur.json";

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/login",
  useRouter: () => ({ replace: nav.replace }),
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "ayesha@chambers.pk",
  name: "Ayesha Khan",
  role: "user",
  locale: "ur",
  aiEnabled: false,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });

async function renderForm(
  form: "login" | "register",
  response: () => Response,
  locale: "en" | "ur" = "ur",
) {
  const fetchMock = vi.fn<typeof fetch>(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { LoginForm } = await import("@/components/auth/login-form");
  const { RegisterForm } = await import("@/components/auth/register-form");
  const { RedirectIfSignedIn } = await import("@/components/auth/redirect-if-signed-in");
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "ur" ? ur : en}>
      <RedirectIfSignedIn>{form === "login" ? <LoginForm /> : <RegisterForm />}</RedirectIfSignedIn>
    </NextIntlClientProvider>,
  );
  return fetchMock;
}

function fill(fields: Record<string, string>, messages = ur) {
  for (const [field, value] of Object.entries(fields)) {
    const label = messages.Auth.fields[field as keyof typeof messages.Auth.fields];
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

const submit = () => fireEvent.submit(screen.getByRole("button").closest("form")!);

beforeEach(() => {
  nav.replace.mockReset();
  nav.search = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LoginForm", () => {
  it("labels every field from the Urdu messages", async () => {
    await renderForm("login", () => json({}));
    expect(screen.getByLabelText(ur.Auth.fields.email)).toBeTruthy();
    expect(screen.getByLabelText(ur.Auth.fields.password)).toBeTruthy();
    expect(screen.getByRole("button", { name: ur.Auth.login.submit })).toBeTruthy();
  });

  it("shows the localised message for wrong credentials", async () => {
    await renderForm("login", () =>
      json(
        {
          type: "about:blank",
          title: "Unauthorized",
          status: 401,
          detail: "Incorrect email or password.",
        },
        401,
      ),
    );
    fill({ email: "ayesha@chambers.pk", password: "wrong-password" });
    submit();
    expect((await screen.findByRole("alert")).textContent).toBe(ur.Auth.errors.invalidCredentials);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("marks the field named in a validation problem", async () => {
    await renderForm("login", () =>
      json(
        {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          errors: [{ path: "email", message: "Invalid email" }],
        },
        400,
      ),
    );
    fill({ email: "nope", password: "whatever-123" });
    submit();
    await screen.findByText(ur.Auth.errors.email);
    const email = screen.getByLabelText(ur.Auth.fields.email);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(email.getAttribute("aria-describedby")!)?.textContent).toBe(
      ur.Auth.errors.email,
    );
  });

  it("signs in and goes where the user was heading", async () => {
    nav.search = "next=/research";
    const fetchMock = await renderForm("login", () =>
      json({ accessToken: "t", expiresIn: 900, user }),
    );
    fill({ email: "ayesha@chambers.pk", password: "correct-horse-battery" });
    submit();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/research"));
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname).toBe("/api/v1/auth/login");
    expect(await request.json()).toEqual({
      email: "ayesha@chambers.pk",
      password: "correct-horse-battery",
    });
  });

  it("never follows an off-site next", async () => {
    nav.search = "next=//evil.example";
    await renderForm("login", () => json({ accessToken: "t", expiresIn: 900, user }));
    fill({ email: "ayesha@chambers.pk", password: "correct-horse-battery" });
    submit();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
  });

  it("explains when the server can't be reached", async () => {
    await renderForm("login", () => {
      throw new TypeError("Failed to fetch");
    });
    fill({ email: "ayesha@chambers.pk", password: "correct-horse-battery" });
    submit();
    expect((await screen.findByRole("alert")).textContent).toBe(ur.Auth.errors.network);
  });
});

describe("RegisterForm", () => {
  it("turns a taken email into a field error", async () => {
    await renderForm("register", () =>
      json({ type: "about:blank", title: "Conflict", status: 409 }, 409),
    );
    fill({ name: "Ayesha Khan", email: "ayesha@chambers.pk", password: "correct-horse-battery" });
    submit();
    await screen.findByText(ur.Auth.errors.emailTaken);
    expect(screen.getByLabelText(ur.Auth.fields.email).getAttribute("aria-invalid")).toBe("true");
  });

  it("sends the UI locale and asks for at least 10 characters", async () => {
    const fetchMock = await renderForm("register", () =>
      json({ accessToken: "t", expiresIn: 900, user }),
    );
    expect(screen.getByLabelText(ur.Auth.fields.password).getAttribute("minlength")).toBe("10");
    fill({ name: "Ayesha Khan", email: "ayesha@chambers.pk", password: "correct-horse-battery" });
    submit();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
    expect(await (fetchMock.mock.calls[0][0] as Request).json()).toMatchObject({ locale: "ur" });
  });
});
