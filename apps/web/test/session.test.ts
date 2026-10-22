import { afterEach, describe, expect, it, vi } from "vitest";

// A BroadcastChannel stand-in: messages reach every other channel with the same name, as they
// would reach other tabs.
class FakeChannel {
  static open: FakeChannel[] = [];
  private listeners: ((event: { data: unknown }) => void)[] = [];
  constructor(readonly name: string) {
    FakeChannel.open.push(this);
  }
  addEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
    this.listeners.push(listener);
  }
  postMessage(data: unknown) {
    for (const peer of FakeChannel.open) {
      if (peer !== this && peer.name === this.name) {
        queueMicrotask(() => peer.listeners.forEach((listener) => listener({ data })));
      }
    }
  }
  close() {}
}

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "ayesha@chambers.pk",
  name: "Ayesha Khan",
  role: "user",
  locale: "en",
  aiEnabled: false,
} as const;

const sessionBody = (expiresIn = 900, accessToken = "token-1") => ({
  accessToken,
  expiresIn,
  user,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });

const problem = (status: number) => json({ type: "about:blank", title: "x", status }, status);

async function load(fetchImpl: typeof fetch) {
  const fetchMock = vi.fn<typeof fetch>(fetchImpl);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.resetModules();
  const session = await import("@/lib/session");
  const { api } = await import("@/lib/api");
  const paths = () =>
    fetchMock.mock.calls.map(([request]) => new URL((request as Request).url).pathname);
  return { session, api, fetchMock, paths };
}

const peer = () => new FakeChannel("caseguard-session");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  FakeChannel.open = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("session store", () => {
  it("runs concurrent refreshes as one request", async () => {
    const { session, paths } = await load(async () => json(sessionBody()));

    await Promise.all([session.refresh(), session.refresh(), session.refresh({ force: true })]);

    expect(paths()).toEqual(["/api/v1/auth/refresh"]);
    expect(session.getSnapshot()).toMatchObject({
      status: "authenticated",
      user: { name: "Ayesha Khan" },
    });
  });

  it("is anonymous when the cookie is rejected", async () => {
    const { session } = await load(async () => problem(401));
    await session.refresh();
    expect(session.getSnapshot().status).toBe("anonymous");
  });

  it("is unavailable, not signed out, when rate-limited or offline", async () => {
    const limited = await load(async () => problem(429));
    await limited.session.refresh();
    expect(limited.session.getSnapshot().status).toBe("unavailable");

    const offline = await load(async () => {
      throw new TypeError("Failed to fetch");
    });
    await offline.session.refresh();
    expect(offline.session.getSnapshot().status).toBe("unavailable");
  });

  it("refreshes before a request only when the token is about to expire", async () => {
    const fresh = await load(async () => json(sessionBody(900, "token-2")));
    fresh.session.signIn(sessionBody(900));
    expect(await fresh.session.tokenFor()).toBe("token-1");
    expect(fresh.paths()).toEqual([]);

    const expiring = await load(async () => json(sessionBody(900, "token-2")));
    expiring.session.signIn(sessionBody(10));
    expect(await expiring.session.tokenFor()).toBe("token-2");
    expect(expiring.paths()).toEqual(["/api/v1/auth/refresh"]);
  });

  it("sends the bearer token to API routes but not to auth routes", async () => {
    const { session, api, fetchMock } = await load(async () => json([]));
    session.signIn(sessionBody());

    await api.GET("/conversations");
    await api.POST("/auth/logout");

    const [conversations, logout] = fetchMock.mock.calls.map(([request]) => request as Request);
    expect(conversations.headers.get("Authorization")).toBe("Bearer token-1");
    expect(logout.headers.get("Authorization")).toBeNull();
  });

  it("ignores a refresh that started before a sign-in", async () => {
    let answer!: (response: Response) => void;
    const { session } = await load(() => new Promise<Response>((resolve) => (answer = resolve)));

    const refreshing = session.refresh();
    await tick();
    session.signIn(sessionBody());
    answer(problem(401));
    await refreshing;

    expect(session.getSnapshot().status).toBe("authenticated");
  });

  it("signs out locally even when the API call fails, and tells other tabs", async () => {
    const { session } = await load(async () => {
      throw new TypeError("Failed to fetch");
    });
    session.signIn(sessionBody());
    const other = peer();
    const heard: unknown[] = [];
    other.addEventListener("message", ({ data }) => heard.push(data));

    await session.signOut();
    await tick();

    expect(session.getSnapshot().status).toBe("anonymous");
    expect(heard).toContainEqual({ type: "signed-out" });
  });

  it("follows sign-out in another tab", async () => {
    const { session } = await load(async () => json({}));
    session.signIn(sessionBody());

    peer().postMessage({ type: "signed-out" });
    await tick();

    expect(session.getSnapshot().status).toBe("anonymous");
  });

  it("hands its session to a new tab that asks", async () => {
    const { session } = await load(async () => json({}));
    session.signIn(sessionBody());
    const newTab = peer();
    const heard: { type: string }[] = [];
    newTab.addEventListener("message", ({ data }) => heard.push(data as { type: string }));

    newTab.postMessage({ type: "hello" });
    await tick();

    expect(heard).toContainEqual(expect.objectContaining({ type: "session" }));
  });

  it("restores from another tab without calling /auth/refresh", async () => {
    const { session, paths } = await load(async () => json(sessionBody()));
    const otherTab = peer();
    otherTab.addEventListener("message", ({ data }) => {
      if ((data as { type: string }).type === "hello") {
        otherTab.postMessage({
          type: "session",
          session: {
            status: "authenticated",
            user,
            accessToken: "shared",
            expiresAt: Date.now() + 600_000,
          },
        });
      }
    });

    await session.restore();

    expect(paths()).toEqual([]);
    expect(session.getSnapshot()).toMatchObject({ status: "authenticated", accessToken: "shared" });
  });

  it("restores through the cookie when no other tab answers", async () => {
    const { session, paths } = await load(async () => json(sessionBody()));
    await Promise.all([session.restore(), session.restore()]);
    expect(paths()).toEqual(["/api/v1/auth/refresh"]);
    expect(session.getSnapshot().status).toBe("authenticated");
  });
});
