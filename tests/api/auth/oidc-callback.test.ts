import { withBasePathEnv } from "../../helpers/base-path";
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { OIDCState } from "@/lib/oidc";

// ─── Mock dependencies ─────────────────────────────────────────────────────

const mockDecryptState = mock(
  async (): Promise<OIDCState> => ({
    code_verifier: "test-verifier",
    state: "test-state",
    nonce: "test-nonce",
  }),
);

/** OIDC_ISSUER, which openid-client has already matched with the `iss` of every ID token it hands over. */
const ISSUER = "https://example.auth0.com";

const mockGetOIDCConfig = mock(() => ({
  issuer: ISSUER,
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  scope: "openid profile email",
  roleClaim: "roles",
  adminRoles: ["admin"],
}));

const mockDiscoverProvider = mock(async () => "mock-config");

const defaultClaims = {
  iss: ISSUER,
  sub: "user-123",
  email: "user@example.com",
  preferred_username: "testuser",
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockExchangeCode = mock(async (..._args: unknown[]) => ({ ...defaultClaims }) as Record<string, unknown> | null);

const mockMapOIDCRole = mock(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_claims: Record<string, unknown>, _roleClaim: string, _adminRoles: string[]) => "user" as "admin" | "user",
);

const mockGetPublicOrigin = mock((req: Request) => new URL(req.url).origin);

mock.module("@/lib/oidc", () => ({
  getOIDCConfig: mockGetOIDCConfig,
  discoverProvider: mockDiscoverProvider,
  generateAuthUrl: mock(async () => ({})),
  encryptState: mock(async () => ""),
  decryptState: mockDecryptState,
  exchangeCode: mockExchangeCode,
  mapOIDCRole: mockMapOIDCRole,
  resetDiscoveryCache: mock(() => {}),
  getPublicOrigin: mockGetPublicOrigin,
}));

const mockCookieGet = mock(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_name: string) => ({ value: "encrypted-state-cookie" }) as { value: string } | undefined,
);

/** The cookies the route set, by name. The real login() signs the session, so auth-token is the minted JWT. */
const setCookies = new Map<string, string>();

const mockCookieStore = {
  get: mockCookieGet,
  set: mock((name: string, value: string) => {
    setCookies.set(name, value);
  }),
  delete: mock(() => {}),
};

mock.module("next/headers", () => ({
  cookies: mock(async () => mockCookieStore),
  // auth.ts also imports headers() (loopback-aware cookie flags); the mock
  // replaces the module wholesale, so it has to expose every imported name.
  headers: mock(async () => ({ get: () => null })),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────

const { GET } = await import("@/app/api/auth/oidc/callback/route");
const { verifyJWT } = await import("@/lib/auth");

/** The session the callback minted, verified and decoded from the auth-token cookie it set. */
async function mintedSession() {
  const token = setCookies.get("auth-token");
  if (token === undefined) throw new Error("the callback set no auth-token cookie");
  return await verifyJWT(token);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/auth/oidc/callback", () => {
  beforeEach(() => {
    mockDecryptState.mockClear();
    mockGetOIDCConfig.mockClear();
    mockDiscoverProvider.mockClear();
    mockExchangeCode.mockClear();
    mockMapOIDCRole.mockClear();
    mockCookieGet.mockClear();
    setCookies.clear();
    mockCookieStore.delete.mockClear();
    mockGetPublicOrigin.mockClear();
    mockGetPublicOrigin.mockImplementation((req: Request) => new URL(req.url).origin);

    // Reset defaults
    mockCookieGet.mockReturnValue({ value: "encrypted-state-cookie" });
    mockMapOIDCRole.mockReturnValue("user");
    mockExchangeCode.mockImplementation(async () => ({ ...defaultClaims }));
  });

  test("exchanges code and creates local session", async () => {
    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    const res = await GET(req);

    expect(mockDecryptState).toHaveBeenCalledWith("encrypted-state-cookie");
    expect(mockExchangeCode).toHaveBeenCalledTimes(1);
    expect(await mintedSession()).toMatchObject({ role: "user", username: "user@example.com" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/");
  });

  test("redirects admin to /admin", async () => {
    mockMapOIDCRole.mockReturnValue("admin");

    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    const res = await GET(req);

    expect(await mintedSession()).toMatchObject({ role: "admin", username: "user@example.com" });
    expect(res.headers.get("location")).toContain("/admin");
  });

  // Spec 5.2: the provider's subject joins a session to its grants, and the issuer says which provider it belongs to.
  // `username` keeps its display meaning, so the subject travels in a claim of its own.
  test("the session minted by the callback carries idpSubject and idpIssuer from the ID token", async () => {
    const res = await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    expect(await mintedSession()).toMatchObject({
      role: "user",
      username: "user@example.com",
      idpSubject: "user-123",
      idpIssuer: "https://example.auth0.com",
    });
  });

  // Discovery accepts an issuer that differs from OIDC_ISSUER only by URL normalization, such as the trailing slash
  // of a bare-host issuer, and openid-client then requires that exact issuer in the ID token.
  test("idpIssuer is the ID token's iss as the provider wrote it, not the configured OIDC_ISSUER", async () => {
    mockExchangeCode.mockImplementationOnce(async () => ({ ...defaultClaims, iss: `${ISSUER}/` }));

    await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state"));

    expect(await mintedSession()).toMatchObject({ idpSubject: "user-123", idpIssuer: "https://example.auth0.com/" });
  });

  test("a claim set without iss redirects to /login?error=oidc_no_claims and sets no auth-token", async () => {
    mockExchangeCode.mockImplementationOnce(async () => ({
      sub: "user-123",
      email: "user@example.com",
      preferred_username: "testuser",
    }));

    const res = await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_no_claims");
    expect(setCookies.has("auth-token")).toBe(false);
  });

  test("a claim set whose sub is not a string redirects to /login?error=oidc_no_claims and sets no auth-token", async () => {
    mockExchangeCode.mockImplementationOnce(async () => ({ iss: ISSUER, sub: 123, email: "user@example.com" }));

    const res = await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_no_claims");
    expect(setCookies.has("auth-token")).toBe(false);
  });

  // The return path from the session-ended redirect (#1420) rode through the provider in the
  // signed state; it is checked again here before it becomes a Location.
  test("returns to the page the session ended on, inside the mount", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      mockMapOIDCRole.mockReturnValue("admin");
      mockDecryptState.mockResolvedValueOnce({ code_verifier: "v", state: "s", nonce: "n", return_to: "/x?y=1" });
      const res = await GET(new Request("https://studio.example/tools/libredb/api/auth/oidc/callback?code=c&state=s"));
      expect(res.headers.get("location")).toBe("https://studio.example/tools/libredb/x?y=1");
    });
  });

  test("an unsafe return path in the state falls back to the role's landing page", async () => {
    mockDecryptState.mockResolvedValueOnce({
      code_verifier: "v",
      state: "s",
      nonce: "n",
      return_to: "/%2e%2e//evil.example",
    });
    const res = await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=c&state=s"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  test("deletes oidc-state cookie after success", async () => {
    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    await GET(req);

    expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-state", path: "/" });
  });

  test("redirects to /login?error=oidc_state_missing when no cookie", async () => {
    mockCookieGet.mockReturnValue(undefined);

    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("error=oidc_state_missing");
  });

  test("redirects to /login?error=oidc_state_invalid when decrypt fails", async () => {
    mockDecryptState.mockImplementationOnce(async () => {
      throw new Error("Invalid token");
    });

    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("error=oidc_state_invalid");
    expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-state", path: "/" });
  });

  test("redirects to /login?error=oidc_no_claims when no claims", async () => {
    mockExchangeCode.mockImplementationOnce(async () => null);

    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("error=oidc_no_claims");
  });

  test("redirects to /login?error=oidc_failed on exchange error", async () => {
    mockExchangeCode.mockImplementationOnce(async () => {
      throw new Error("Token exchange failed");
    });

    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("error=oidc_failed");
  });

  test("uses sub as username fallback when email is missing", async () => {
    mockExchangeCode.mockImplementationOnce(async () => ({
      iss: ISSUER,
      sub: "user-123",
    }));

    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    await GET(req);

    expect(await mintedSession()).toMatchObject({ role: "user", username: "user-123" });
  });

  test("passes claims to mapOIDCRole with correct config", async () => {
    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    await GET(req);

    expect(mockMapOIDCRole).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "user-123", email: "user@example.com" }),
      "roles",
      ["admin"],
    );
  });
  test("OIDC callback preserves the mount through exchange, redirect and state cleanup", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      mockCookieGet.mockReturnValue({ value: "encrypted-state-cookie" });
      mockDecryptState.mockResolvedValue({ code_verifier: "v", state: "s", nonce: "n" });
      mockGetOIDCConfig.mockImplementation(() => ({
        issuer: "https://example.auth0.com",
        clientId: "id",
        clientSecret: "secret",
        scope: "openid",
        roleClaim: "roles",
        adminRoles: ["admin"],
      }));
      mockExchangeCode.mockResolvedValue({ ...defaultClaims });
      mockExchangeCode.mockClear();
      mockMapOIDCRole.mockReturnValue("user");
      mockCookieStore.delete.mockClear();
      const url = "https://studio.example/tools/libredb/api/auth/oidc/callback?code=c&state=s";
      const response = await GET(new Request(url));
      expect(mockExchangeCode.mock.calls[0]?.[1]?.toString()).toBe(url);
      expect(response.headers.get("location")).toBe("https://studio.example/tools/libredb/");
      expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-state", path: "/tools/libredb" });
      mockCookieGet.mockReturnValue(undefined);
      expect((await GET(new Request(url))).headers.get("location")).toBe(
        "https://studio.example/tools/libredb/login?error=oidc_state_missing",
      );
    });
  });
});
