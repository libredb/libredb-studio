import { withBasePathEnv } from "../../helpers/base-path";
import { describe, test, expect, mock, spyOn, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { SignJWT } from "jose";
import { createMockCookies, parseResponseJSON } from "../../helpers/mock-next";

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
const mockLogout = mock(async () => {});
const mockGetSession = mock(
  async () => null as { role: string; username: string; idpSubject?: string; channel?: "bearer" } | null,
);

mock.module("@/lib/auth", () => ({
  login: mock(async () => {}),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  getSession: mockGetSession,
  readSession: mock(async () => {
    const s = await mockGetSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  }),
  logout: mockLogout,
}));

let cookieStore = createMockCookies();

mock.module("next/headers", () => ({
  cookies: mock(async () => cookieStore),
  headers: mock(async () => new Headers()),
}));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockBuildLogoutUrl = mock(async (_returnTo: string, _idTokenHint?: string) => null as string | null);

const mockGetPublicOrigin = mock((req: Request) => new URL(req.url).origin);

mock.module("@/lib/oidc", () => ({
  buildLogoutUrl: mockBuildLogoutUrl,
  getPublicOrigin: mockGetPublicOrigin,
  getOIDCConfig: mock(() => ({})),
  discoverProvider: mock(async () => ({})),
  generateAuthUrl: mock(async () => ({})),
  encryptState: mock(async () => ""),
  decryptState: mock(async () => ({})),
  exchangeCode: mock(async () => ({})),
  mapOIDCRole: mock(() => "user"),
  resetDiscoveryCache: mock(() => {}),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/auth/logout/route");

function makeRequest(url = "http://localhost:3000/api/auth/logout") {
  return new Request(url, { method: "POST" });
}

// ─── Tests (local auth mode) ────────────────────────────────────────────────
describe("POST /api/auth/logout (local)", () => {
  beforeEach(() => {
    mockLogout.mockClear();
    mockBuildLogoutUrl.mockClear();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
  });

  test("returns 200 with success true", async () => {
    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ success: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });

  test("calls logout() once", async () => {
    await POST(makeRequest() as never);

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  test("does not return redirectUrl in local mode", async () => {
    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ success: boolean; redirectUrl?: string }>(res);

    expect(data.redirectUrl).toBeUndefined();
  });

  test("returns 500 when logout throws", async () => {
    mockLogout.mockImplementationOnce(async () => {
      throw new Error("Cookie store unavailable");
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      const res = await POST(makeRequest() as never);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(500);
      expect(data.error).toBe("Cookie store unavailable");
      // A failed logout must never produce a line asserting a logout that did not happen.
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  test("multiple logouts all succeed", async () => {
    const res1 = await POST(makeRequest() as never);
    const res2 = await POST(makeRequest() as never);
    const res3 = await POST(makeRequest() as never);

    const data1 = await parseResponseJSON<{ success: boolean }>(res1);
    const data2 = await parseResponseJSON<{ success: boolean }>(res2);
    const data3 = await parseResponseJSON<{ success: boolean }>(res3);

    expect(data1.success).toBe(true);
    expect(data2.success).toBe(true);
    expect(data3.success).toBe(true);
    expect(mockLogout).toHaveBeenCalledTimes(3);
  });
});

// ─── Tests (OIDC auth mode) ─────────────────────────────────────────────────
describe("POST /api/auth/logout (oidc)", () => {
  beforeEach(() => {
    mockLogout.mockClear();
    mockBuildLogoutUrl.mockClear();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
  });

  test("returns redirectUrl when OIDC logout URL is available", async () => {
    mockBuildLogoutUrl.mockResolvedValue(
      "https://auth0.com/v2/logout?client_id=abc&returnTo=http://localhost:3000/login",
    );

    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ success: boolean; redirectUrl?: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.redirectUrl).toBe("https://auth0.com/v2/logout?client_id=abc&returnTo=http://localhost:3000/login");
  });

  test("calls buildLogoutUrl with correct returnTo", async () => {
    mockBuildLogoutUrl.mockResolvedValue("https://auth0.com/v2/logout");

    await POST(makeRequest("http://localhost:3000/api/auth/logout") as never);

    expect(mockBuildLogoutUrl).toHaveBeenCalledWith("http://localhost:3000/login", undefined);
  });

  test("returns success without redirectUrl when buildLogoutUrl returns null", async () => {
    mockBuildLogoutUrl.mockResolvedValue(null);

    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ success: boolean; redirectUrl?: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.redirectUrl).toBeUndefined();
  });

  test("calls logout() even in OIDC mode", async () => {
    mockBuildLogoutUrl.mockResolvedValue("https://auth0.com/v2/logout");

    await POST(makeRequest() as never);

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
  test("OIDC logout returns to login under the build's prefix", async () => {
    const previous = process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    try {
      await withBasePathEnv("/tools/libredb", async () => {
        mockBuildLogoutUrl.mockClear();
        await POST(new Request("https://studio.example/tools/libredb/api/auth/logout", { method: "POST" }) as never);
        expect(mockBuildLogoutUrl).toHaveBeenCalledWith("https://studio.example/tools/libredb/login", undefined);
      });
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
      else process.env.NEXT_PUBLIC_AUTH_PROVIDER = previous;
    }
  });
});

// ─── Tests (OIDC_LOGOUT_HINT) ───────────────────────────────────────────────
/** An ID token as the provider signed it; the route only decodes it, so any key will do. */
async function idToken(sub: string): Promise<string> {
  return await new SignJWT({ sub, iss: "https://idp.example/realms/libredb" })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode("a-key-the-route-never-verifies-with"));
}

const KEYCLOAK_LOGOUT = "https://idp.example/realms/libredb/protocol/openid-connect/logout";

describe("POST /api/auth/logout (OIDC_LOGOUT_HINT)", () => {
  const originalHint = process.env.OIDC_LOGOUT_HINT;

  beforeEach(() => {
    cookieStore = createMockCookies();
    mockBuildLogoutUrl.mockClear();
    mockBuildLogoutUrl.mockImplementation(async (returnTo: string, idTokenHint?: string) => {
      const url = new URL(KEYCLOAK_LOGOUT);
      url.searchParams.set("post_logout_redirect_uri", returnTo);
      if (idTokenHint !== undefined) url.searchParams.set("id_token_hint", idTokenHint);
      return url.toString();
    });
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "alice", idpSubject: "subject-alice" }));
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    process.env.OIDC_LOGOUT_HINT = "true";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    if (originalHint === undefined) delete process.env.OIDC_LOGOUT_HINT;
    else process.env.OIDC_LOGOUT_HINT = originalHint;
    mockGetSession.mockImplementation(async () => null);
  });

  async function redirectUrl(): Promise<URL> {
    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ success: boolean; redirectUrl?: string }>(res);
    expect(res.status).toBe(200);
    return new URL(data.redirectUrl!);
  }

  test("redirectUrl carries id_token_hint when the hint cookie belongs to the session subject", async () => {
    const hint = await idToken("subject-alice");
    cookieStore.set("oidc-logout-hint", hint);

    const url = await redirectUrl();

    expect(url.searchParams.get("id_token_hint")).toBe(hint);
    expect(mockBuildLogoutUrl).toHaveBeenCalledWith("http://localhost:3000/login", hint);
    expect(cookieStore._deleted).toEqual([{ name: "oidc-logout-hint", path: "/api/auth/logout" }]);
  });

  // Whenever the auth cookies are Secure the hint is __Host-oidc-logout-hint at Path=/: only that name is read, and it
  // is deleted with Secure.
  test("with Secure on, reads and deletes __Host-oidc-logout-hint alone", async () => {
    process.env.AUTH_COOKIE_SECURE = "true";
    try {
      const hint = await idToken("subject-alice");
      cookieStore.set("oidc-logout-hint", hint);
      expect((await redirectUrl()).searchParams.has("id_token_hint")).toBe(false);
      expect(cookieStore._deleted).toEqual([]);

      cookieStore.set("__Host-oidc-logout-hint", hint);
      expect((await redirectUrl()).searchParams.get("id_token_hint")).toBe(hint);
      expect(cookieStore._deleted).toEqual([{ name: "__Host-oidc-logout-hint", path: "/", secure: true }]);
    } finally {
      delete process.env.AUTH_COOKIE_SECURE;
    }
  });

  test("a hint whose sub differs from the session is not sent and the cookie is still deleted", async () => {
    cookieStore.set("oidc-logout-hint", await idToken("subject-mallory"));

    const url = await redirectUrl();

    expect(url.searchParams.has("id_token_hint")).toBe(false);
    expect(mockBuildLogoutUrl).toHaveBeenCalledWith("http://localhost:3000/login", undefined);
    expect(cookieStore._deleted).toEqual([{ name: "oidc-logout-hint", path: "/api/auth/logout" }]);
  });

  test("a hint is not sent without a session, nor for a session that has no idpSubject", async () => {
    cookieStore.set("oidc-logout-hint", await idToken("subject-alice"));
    mockGetSession.mockImplementation(async () => null);
    expect((await redirectUrl()).searchParams.has("id_token_hint")).toBe(false);

    cookieStore.set("oidc-logout-hint", await idToken("subject-alice"));
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "alice" }));
    expect((await redirectUrl()).searchParams.has("id_token_hint")).toBe(false);
    expect(cookieStore._deleted).toHaveLength(2);
  });

  test("a hint cookie that is not a JWT is not sent, the cookie is deleted and the logout succeeds", async () => {
    cookieStore.set("oidc-logout-hint", "not-a-jwt");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const url = await redirectUrl();

      expect(url.searchParams.has("id_token_hint")).toBe(false);
      expect(cookieStore._deleted).toEqual([{ name: "oidc-logout-hint", path: "/api/auth/logout" }]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("the cookie is deleted under the build's prefix", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      cookieStore.set("oidc-logout-hint", await idToken("subject-alice"));
      await POST(new Request("https://studio.example/tools/libredb/api/auth/logout", { method: "POST" }) as never);
      expect(cookieStore._deleted).toEqual([{ name: "oidc-logout-hint", path: "/tools/libredb/api/auth/logout" }]);
    });
  });

  test("with OIDC_LOGOUT_HINT off a matching hint is not sent, and a leftover cookie is still deleted", async () => {
    delete process.env.OIDC_LOGOUT_HINT;
    cookieStore.set("oidc-logout-hint", await idToken("subject-alice"));

    const url = await redirectUrl();

    expect(url.searchParams.has("id_token_hint")).toBe(false);
    expect(mockBuildLogoutUrl).toHaveBeenCalledWith("http://localhost:3000/login", undefined);
    expect(cookieStore._deleted).toEqual([{ name: "oidc-logout-hint", path: "/api/auth/logout" }]);
  });

  test("without a hint cookie nothing is deleted", async () => {
    const url = await redirectUrl();

    expect(url.searchParams.has("id_token_hint")).toBe(false);
    expect(cookieStore._deleted).toEqual([]);
  });

  test("local auth deletes a leftover hint cookie too", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    cookieStore.set("oidc-logout-hint", await idToken("subject-alice"));

    await POST(makeRequest() as never);

    expect(mockBuildLogoutUrl).not.toHaveBeenCalled();
    expect(cookieStore._deleted).toEqual([{ name: "oidc-logout-hint", path: "/api/auth/logout" }]);
  });
});

// A native client's session stands on the identity provider's access token (src/lib/oidc-bearer.ts). It holds no
// Studio cookie and ends its provider session itself, so the route answers with neither a cookie nor an end-session URL.
describe("POST /api/auth/logout (bearer access token)", () => {
  beforeEach(() => {
    cookieStore = createMockCookies();
    mockLogout.mockClear();
    mockBuildLogoutUrl.mockClear();
    mockBuildLogoutUrl.mockResolvedValue(KEYCLOAK_LOGOUT);
    mockGetSession.mockImplementation(async () => ({
      role: "user",
      username: "ada@example.test",
      idpSubject: "subject-ada",
      channel: "bearer",
    }));
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    mockGetSession.mockImplementation(async () => null);
  });

  test("answers success with no redirectUrl, touches no cookie and records the logout", async () => {
    cookieStore.set("auth-token", "a-browser-session-on-the-same-device");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await POST(makeRequest() as never);

      expect(res.status).toBe(200);
      expect(await parseResponseJSON(res)).toEqual({ success: true });
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(mockLogout).not.toHaveBeenCalled();
      expect(mockBuildLogoutUrl).not.toHaveBeenCalled();
      expect(cookieStore._deleted).toEqual([]);
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some((line) => line.includes('"event":"logout"') && line.includes('"actor":"ada@example.test"')),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ─── openshift sign-in mode ─────────────────────────────────────────────────
// Logout forgets the user's token at once and sends nothing: the scoped token cannot delete its own
// useroauthaccesstoken, and the OAuth server's own session is never reused, so no request leaves Studio.
const { startFakeCluster } = await import("../../helpers/openshift-auth/fake-cluster");
const tokenStore = await import("@/lib/openshift-auth/token-store");

describe("POST /api/auth/logout (openshift)", () => {
  let cluster: Awaited<ReturnType<typeof startFakeCluster>>;
  const ISSUER = "https://oauth-openshift.apps.example.com";
  const SESSION = {
    role: "user",
    username: "dev-a",
    idpSubject: "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f",
    idpIssuer: ISSUER,
    sessionHandle: "handle-of-dev-a-0000000000000000000000000",
  };
  const KEY = { sessionHandle: SESSION.sessionHandle, uid: SESSION.idpSubject, name: "dev-a", issuer: ISSUER };

  beforeAll(async () => {
    cluster = await startFakeCluster();
  });

  afterAll(async () => {
    await cluster.close();
  });

  beforeEach(() => {
    cluster.reset();
    cluster.useEnv();
    tokenStore.resetOpenShiftSessions();
    mockLogout.mockClear();
    mockBuildLogoutUrl.mockClear();
    tokenStore.storeOpenShiftSession(SESSION.sessionHandle, {
      token: "sha256~not-a-real-token-1",
      uid: KEY.uid,
      name: KEY.name,
      issuer: ISSUER,
      expiresAtMs: Date.now() + 60_000,
    });
  });

  afterEach(() => {
    mockGetSession.mockReset();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
  });

  test("ends the record, clears the cookie, answers success without a redirect and sends nothing", async () => {
    mockGetSession.mockResolvedValue(SESSION as never);
    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(tokenStore.openShiftBearerToken(KEY)).toBeNull();
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockBuildLogoutUrl).not.toHaveBeenCalled();
    expect(cluster.requests).toEqual([]);
  });

  test("a signed-out caller ends nothing and still answers success", async () => {
    mockGetSession.mockResolvedValue(null);
    expect(await (await POST(makeRequest() as never)).json()).toEqual({ success: true });
    expect(tokenStore.openShiftBearerToken(KEY)).toBe("sha256~not-a-real-token-1");
    expect(cluster.requests).toEqual([]);
  });
});
