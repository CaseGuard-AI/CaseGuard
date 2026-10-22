import { api, type Schemas } from "./api";

// The signed-in session, kept in memory only (FR-AUTH-1). The HttpOnly `cg_refresh` cookie is the
// only thing that survives a reload, and /auth/refresh turns it back into a session.
//
// The API revokes the whole session family when a rotated refresh token is presented again
// (reuse detection, no grace window). So refreshes run one at a time: one promise per tab, and a
// Web Lock across tabs, so each refresh reads the newest cookie. Tabs also share the session over
// a BroadcastChannel, so a new tab rarely needs to refresh at all.

export type User = Schemas["User"];

export type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  // The API could not be reached or rate-limited us. The cookie may still be valid.
  | { status: "unavailable" }
  | { status: "authenticated"; user: User; accessToken: string; expiresAt: number };

type Authenticated = Extract<SessionState, { status: "authenticated" }>;
type Message =
  | { type: "hello" }
  | { type: "session"; session: Authenticated }
  | { type: "user"; user: User }
  | { type: "signed-out" };

const LOCK = "caseguard-auth";
const CHANNEL = "caseguard-session";
// Refresh before a request when the access token has less than this left.
const EXPIRY_SKEW_MS = 30_000;
// How long a new tab waits for another tab to hand over its session.
const HELLO_WAIT_MS = 150;
// Auth routes never carry the bearer token, and their 401s are answers, not expiry.
const isAuthRoute = (path: string) => path.startsWith("/auth/") && path !== "/auth/me";

let state: SessionState = { status: "loading" };
const listeners = new Set<() => void>();
let refreshing: Promise<void> | undefined;
let restoring: Promise<void> | undefined;
// Bumped by sign-in and sign-out, so a refresh that started earlier can't overwrite them.
let generation = 0;

const channel =
  typeof window !== "undefined" && typeof BroadcastChannel === "function"
    ? new BroadcastChannel(CHANNEL)
    : undefined;

function set(next: SessionState) {
  state = next;
  for (const listener of listeners) listener();
}

function broadcast(message: Message) {
  channel?.postMessage(message);
}

const isFresh = (s: SessionState): s is Authenticated =>
  s.status === "authenticated" && s.expiresAt - Date.now() > EXPIRY_SKEW_MS;

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? await locks.request(LOCK, fn) : fn();
}

function fromSession(session: Schemas["Session"]): Authenticated {
  return {
    status: "authenticated",
    user: session.user,
    accessToken: session.accessToken,
    expiresAt: Date.now() + session.expiresIn * 1000,
  };
}

channel?.addEventListener("message", (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === "hello" && state.status === "authenticated") {
    broadcast({ type: "session", session: state });
  } else if (message.type === "session") {
    const current = state;
    if (current.status !== "authenticated" || message.session.expiresAt > current.expiresAt) {
      set(message.session);
    }
  } else if (message.type === "user") {
    if (state.status === "authenticated" && state.user.id === message.user.id) {
      set({ ...state, user: message.user });
    }
  } else if (message.type === "signed-out") {
    set({ status: "anonymous" });
  }
});

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getSnapshot = (): SessionState => state;

const serverSnapshot: SessionState = { status: "loading" };
export const getServerSnapshot = (): SessionState => serverSnapshot;

/**
 * Rotates the refresh cookie into a new session. Single-flight within the tab and locked across
 * tabs. Skips the call when another tab already handed over a fresh session, unless `force`.
 */
export function refresh({ force = false } = {}): Promise<void> {
  refreshing ??= withLock(async () => {
    if (!force && isFresh(state)) return;
    const started = generation;
    try {
      const { data, response } = await api.POST("/auth/refresh");
      if (started !== generation) return;
      if (data) {
        const next = fromSession(data);
        set(next);
        broadcast({ type: "session", session: next });
      } else if (response.status === 401) {
        set({ status: "anonymous" });
      } else {
        set({ status: "unavailable" });
      }
    } catch {
      if (started === generation) set({ status: "unavailable" });
    }
  }).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

/** First load of a tab: take the session from another tab if one answers, else refresh. */
export function restore(): Promise<void> {
  restoring ??= (async () => {
    if (channel) {
      broadcast({ type: "hello" });
      await new Promise((resolve) => setTimeout(resolve, HELLO_WAIT_MS));
    }
    if (state.status !== "authenticated") await refresh();
  })();
  return restoring;
}

/** After login or register. */
export function signIn(session: Schemas["Session"]): void {
  generation++;
  const next = fromSession(session);
  set(next);
  broadcast({ type: "session", session: next });
}

/** After the user changes their own settings, so the header shows them before the next refresh. */
export function updateUser(patch: Partial<Pick<User, "name" | "locale">>): void {
  if (state.status !== "authenticated") return;
  const user = { ...state.user, ...patch };
  set({ ...state, user });
  broadcast({ type: "user", user });
}

/** Revokes the refresh cookie. Clears the session locally even if the API call fails. */
export async function signOut(): Promise<void> {
  try {
    await withLock(() => api.POST("/auth/logout"));
  } catch {
    // Signed out locally either way.
  }
  generation++;
  set({ status: "anonymous" });
  broadcast({ type: "signed-out" });
}

/** The access token for the next request, refreshed first if it is about to expire. */
export async function tokenFor(): Promise<string | undefined> {
  if (state.status !== "authenticated") return undefined;
  if (!isFresh(state)) await refresh();
  return state.status === "authenticated" ? state.accessToken : undefined;
}

api.use({
  async onRequest({ request, schemaPath }) {
    if (isAuthRoute(schemaPath)) return;
    const token = await tokenFor();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
  onResponse({ response, schemaPath }) {
    // The access token was rejected: try the cookie once. A dead cookie ends as anonymous.
    if (response.status === 401 && !isAuthRoute(schemaPath) && state.status === "authenticated") {
      void refresh({ force: true });
    }
  },
});
