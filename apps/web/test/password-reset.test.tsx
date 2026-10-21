import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ur from "../messages/ur.json";

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/reset-password",
  useRouter: () => ({ replace: nav.replace }),
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));

const problem = (status: number, extra: object = {}) =>
  new Response(JSON.stringify({ type: "about:blank", title: "Error", status, ...extra }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });

async function renderPage(form: "forgot" | "reset" | "login", response: () => Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { ForgotPasswordForm } = await import("@/components/auth/forgot-password-form");
  const { ResetPasswordForm } = await import("@/components/auth/reset-password-form");
  const { LoginForm } = await import("@/components/auth/login-form");
  const session = await import("@/lib/session");
  const Form = { forgot: ForgotPasswordForm, reset: ResetPasswordForm, login: LoginForm }[form];
  render(
    <NextIntlClientProvider locale="ur" messages={ur}>
      <Form />
    </NextIntlClientProvider>,
  );
  return { fetchMock, session };
}

const submit = () => fireEvent.submit(document.querySelector("form")!);
const pathOf = (call: Parameters<typeof fetch>) => new URL((call[0] as Request).url).pathname;

beforeEach(() => {
  nav.replace.mockReset();
  nav.search = "";
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ForgotPasswordForm", () => {
  it.each([
    ["202", () => new Response(null, { status: 202 })],
    ["429", () => problem(429)],
    ["400", () => problem(400, { errors: [{ path: "email", message: "Invalid email" }] })],
  ])("shows 'check your inbox' for %s", async (_, response) => {
    const { fetchMock } = await renderPage("forgot", response);
    fireEvent.change(screen.getByLabelText(ur.Auth.fields.email), {
      target: { value: "ayesha@chambers.pk" },
    });
    submit();
    expect((await screen.findByRole("status")).textContent).toContain(ur.Auth.forgot.sentTitle);
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname).toBe("/api/v1/auth/password-reset");
    expect(await request.json()).toEqual({ email: "ayesha@chambers.pk" });
    expect(
      screen.getByRole("link", { name: ur.Auth.forgot.backToLogin }).getAttribute("href"),
    ).toBe("/login");
  });

  it("explains when the request never reached the server", async () => {
    await renderPage("forgot", () => {
      throw new TypeError("Failed to fetch");
    });
    fireEvent.change(screen.getByLabelText(ur.Auth.fields.email), {
      target: { value: "ayesha@chambers.pk" },
    });
    submit();
    expect((await screen.findByRole("alert")).textContent).toBe(ur.Auth.errors.network);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ResetPasswordForm", () => {
  function arrive(token: string) {
    nav.search = `token=${token}`;
    window.history.replaceState(null, "", `/ur/reset-password?token=${token}`);
  }
  const setPassword = (value = "correct-horse-battery") =>
    fireEvent.change(screen.getByLabelText(ur.Auth.fields.password), { target: { value } });

  it("shows the invalid-link state without a token and sends nothing", async () => {
    const { fetchMock } = await renderPage("reset", () => new Response(null, { status: 204 }));
    expect(screen.getByRole("alert").textContent).toContain(ur.Auth.reset.invalidTitle);
    expect(screen.queryByLabelText(ur.Auth.fields.password)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("takes the token out of the address bar and sends it in the body", async () => {
    arrive("tok-123");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { fetchMock } = await renderPage("reset", () => problem(400));
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(replaceState).toHaveBeenCalledWith(null, "", "/ur/reset-password");
    setPassword();
    submit();
    await screen.findByRole("alert");
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname).toBe("/api/v1/auth/password-reset/confirm");
    expect(await request.json()).toEqual({ token: "tok-123", password: "correct-horse-battery" });
    replaceState.mockRestore();
  });

  it("replaces the form when the token is invalid or expired", async () => {
    arrive("used");
    await renderPage("reset", () =>
      problem(400, { detail: "This reset link is invalid or has expired." }),
    );
    setPassword();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain(ur.Auth.reset.invalidTitle);
    expect(screen.getByRole("link", { name: ur.Auth.reset.requestNew }).getAttribute("href")).toBe(
      "/forgot-password",
    );
    expect(screen.queryByLabelText(ur.Auth.fields.password)).toBeNull();
  });

  it("keeps the form and marks the field for a validation problem", async () => {
    arrive("tok");
    await renderPage("reset", () =>
      problem(400, { errors: [{ path: "password", message: "Too short" }] }),
    );
    setPassword("short");
    submit();
    await screen.findByText(ur.Auth.errors.password);
    expect(screen.getByLabelText(ur.Auth.fields.password).getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.queryByText(ur.Auth.reset.invalidTitle)).toBeNull();
  });

  it("signs this browser out and goes to login after a reset", async () => {
    arrive("tok");
    const { fetchMock, session } = await renderPage(
      "reset",
      () => new Response(null, { status: 204 }),
    );
    setPassword();
    submit();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login?reset=1"));
    expect(fetchMock.mock.calls.map(pathOf)).toEqual([
      "/api/v1/auth/password-reset/confirm",
      "/api/v1/auth/logout",
    ]);
    expect(session.getSnapshot().status).toBe("anonymous");
  });
});

describe("LoginForm and password reset", () => {
  it("links to the forgot-password page", async () => {
    await renderPage("login", () => new Response(null, { status: 204 }));
    expect(screen.getByRole("link", { name: ur.Auth.login.forgot }).getAttribute("href")).toBe(
      "/forgot-password",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("confirms the password changed after a reset", async () => {
    nav.search = "reset=1";
    await renderPage("login", () => new Response(null, { status: 204 }));
    expect(screen.getByRole("status").textContent).toBe(ur.Auth.login.resetDone);
  });
});
