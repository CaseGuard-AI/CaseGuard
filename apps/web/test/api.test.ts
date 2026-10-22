import { afterEach, describe, expect, it, vi } from "vitest";

// Load the client after stubbing fetch, since openapi-fetch may capture it at creation.
async function loadApi(fetchMock: typeof fetch) {
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  return import("@/lib/api");
}

const json = (body: unknown, status = 200, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client (api.v1)", () => {
  it("calls the API base URL and sends the refresh cookie", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ status: "ok" }));
    const { api, API_URL } = await loadApi(fetchMock);

    const { data } = await api.GET("/health");

    expect(data).toEqual({ status: "ok" });
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe(`${API_URL}/health`);
    expect(request.credentials).toBe("include");
  });

  it("returns problem+json validation errors as a Problem", async () => {
    const body = {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      errors: [{ path: "email", message: "Invalid email" }],
    };
    const fetchMock = vi.fn<typeof fetch>(async () => json(body, 400, "application/problem+json"));
    const { api, problemOf } = await loadApi(fetchMock);

    const { error } = await api.POST("/auth/login", {
      body: { email: "not-an-email", password: "x" },
    });

    expect(problemOf(error)?.errors).toEqual([{ path: "email", message: "Invalid email" }]);
  });

  it("problemOf ignores bodies that are not problems", async () => {
    const { problemOf } = await loadApi(vi.fn<typeof fetch>());
    expect(problemOf(undefined)).toBeUndefined();
    expect(problemOf("oops")).toBeUndefined();
    expect(problemOf({ message: "no title" })).toBeUndefined();
  });
});
