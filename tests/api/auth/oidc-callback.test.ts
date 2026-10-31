import { withBasePathEnv } from "../../helpers/base-path";
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
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
  rolePrefix: undefined as string | undefined,
  adminRoles: ["admin"],
  userRoles: ["user"],
}));

const mockDiscoverProvider = mock(async () => "mock-config");

const defaultClaims = {
  iss: ISSUER,
  sub: "user-123",
  email: "user@example.com",
  preferred_username: "testuser",
};

/** The raw ID token the exchange hands over next to its claims; only the logout hint cookie carries it. */
const ID_TOKEN = "header.payload.signature";

type Exchanged = { claims: Record<string, unknown>; idToken: string } | null;

/** What exchangeCode() resolves to for a claim set. */
function exchanged(claims: Record<string, unknown>, idToken = ID_TOKEN): Exchanged {
  return { claims, idToken };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockExchangeCode = mock(async (..._args: unknown[]) => exchanged({ ...defaultClaims }));

const mockMapOIDCRole = mock(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_claims: Record<string, unknown>, _roleClaim: string, _adminRoles: string[], _userRoles?: string[]) =>
    "user" as "admin" | "user" | null,
);

const mockGetPublicOrigin = mock((req: Request) => new URL(req.url).origin);

const mockReadRoleClaimValues = mock((claims: Record<string, unknown>, roleClaim: string): string[] => {
  if (!roleClaim) return [];
  const parts = roleClaim.split(".");
  let value: unknown = claims;
  for (const part of parts) {
    if (value == null || typeof value !== "object") return [];
    value = (value as Record<string, unknown>)[part];
  }
  if (value == null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
});

const mockMapOIDCClaimRoles = mock((values: readonly string[], prefix: string) => {
  if (!prefix) return { roles: [], overflow: false };
  const matching: string[] = [];
  let overflow = false;
  for (const val of values) {
    if (val.startsWith(prefix)) {
      if (["*", "admin", "user"].includes(val.toLowerCase())) continue;
      if (val.length > 64) overflow = true;
      matching.push(val);
    }
  }
  const deduped = Array.from(new Set(matching)).sort();
  if (deduped.length > 20) overflow = true;
  return { roles: overflow ? [] : deduped, overflow };
});

mock.module("@/lib/oidc", () => ({
  getOIDCConfig: mockGetOIDCConfig,
  discoverProvider: mockDiscoverProvider,
  generateAuthUrl: mock(async () => ({})),
  encryptState: mock(async () => ""),
  decryptState: mockDecryptState,
  exchangeCode: mockExchangeCode,
  mapOIDCRole: mockMapOIDCRole,
  mapOIDCClaimRoles: mockMapOIDCClaimRoles,
  readRoleClaimValues: mockReadRoleClaimValues,
  resetDiscoveryCache: mock(() => {}),
  getPublicOrigin: mockGetPublicOrigin,
}));

const mockCookieGet = mock(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (_name: string) => ({ value: "encrypted-state-cookie" }) as { value: string } | undefined,
);

/** The cookies the route set, by name. The real login() signs the session, so auth-token is the minted JWT. */
const setCookies = new Map<string, string>();
/** The options each cookie was set with, by name. */
const setCookieOptions = new Map<string, Record<string, unknown> | undefined>();

const mockCookieStore = {
  get: mockCookieGet,
  set: mock((name: string, value: string, options?: Record<string, unknown>) => {
    setCookies.set(name, value);
    setCookieOptions.set(name, options);
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
const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");
const { grantedSnapshot } = await import("../../helpers/governance/granted-snapshot");

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
    setCookieOptions.clear();
    mockCookieStore.delete.mockClear();
    mockGetPublicOrigin.mockClear();
    mockGetPublicOrigin.mockImplementation((req: Request) => new URL(req.url).origin);

    // Reset defaults
    mockCookieGet.mockReturnValue({ value: "encrypted-state-cookie" });
    mockMapOIDCRole.mockReturnValue("user");
    mockExchangeCode.mockImplementation(async () => exchanged({ ...defaultClaims }));
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

  // The provider's subject joins a session to its grants (docs/GOVERNANCE.md#sign-in), and the issuer says which
  // provider it belongs to. `username` keeps its display meaning, so the subject travels in a claim of its own.
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
    mockExchangeCode.mockImplementationOnce(async () => exchanged({ ...defaultClaims, iss: `${ISSUER}/` }));

    await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state"));

    expect(await mintedSession()).toMatchObject({ idpSubject: "user-123", idpIssuer: "https://example.auth0.com/" });
  });

  test("a claim set without iss redirects to /login?error=oidc_no_claims and sets no auth-token", async () => {
    mockExchangeCode.mockImplementationOnce(async () =>
      exchanged({
        sub: "user-123",
        email: "user@example.com",
        preferred_username: "testuser",
      }),
    );

    const res = await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_no_claims");
    expect(setCookies.has("auth-token")).toBe(false);
  });

  test("a claim set whose sub is not a string redirects to /login?error=oidc_no_claims and sets no auth-token", async () => {
    mockExchangeCode.mockImplementationOnce(async () =>
      exchanged({ iss: ISSUER, sub: 123, email: "user@example.com" }),
    );

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
    mockExchangeCode.mockImplementationOnce(async () => exchanged({ iss: ISSUER, sub: "user-123" }));

    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    await GET(req);

    expect(await mintedSession()).toMatchObject({ role: "user", username: "user-123" });
  });

  test("passes over an email the provider marks unverified, so a chosen address cannot open another person's workspace", async () => {
    mockExchangeCode.mockImplementationOnce(async () =>
      exchanged({ ...defaultClaims, email: "victim@example.com", email_verified: false }),
    );

    await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state"));

    expect(await mintedSession()).toMatchObject({ username: "testuser" });
  });

  test("never takes an email-shaped preferred_username, and falls back to sub", async () => {
    mockExchangeCode.mockImplementationOnce(async () =>
      exchanged({ iss: ISSUER, sub: "user-123", preferred_username: "victim@example.com" }),
    );

    await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state"));

    expect(await mintedSession()).toMatchObject({ username: "user-123" });
  });

  test("passes claims to mapOIDCRole with correct config", async () => {
    const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
    await GET(req);

    expect(mockMapOIDCRole).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "user-123", email: "user@example.com" }),
      "roles",
      ["admin"],
      ["user"],
    );
  });

  test("no matching role redirects to /login?error=oidc_no_role, sets no auth-token and audits oidc_no_role", async () => {
    mockMapOIDCRole.mockReturnValue(null);
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const req = new Request("http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_no_role");
      // The real login() signs auth-token into the cookie store; this path sets no cookie at all.
      expect(setCookies.has("auth-token")).toBe(false);
      expect(setCookies.size).toBe(0);
      // The exchange used the state up, so its cookie goes as it does after a sign-in.
      expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-state", path: "/" });

      const lines = spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        event: "login_failure",
        action: "login",
        outcome: "failure",
        reason: "oidc_no_role",
        route: "GET /api/auth/oidc/callback",
        // The provider authenticated the account, so the refusal names it, as a sign-in would.
        actor: "user@example.com",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("the no-role refusal names the account by the same claims a sign-in would", async () => {
    mockMapOIDCRole.mockReturnValue(null);
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      mockExchangeCode.mockImplementationOnce(async () =>
        exchanged({
          iss: ISSUER,
          sub: "user-123",
          preferred_username: "testuser",
        }),
      );
      await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=c&state=s"));
      mockExchangeCode.mockImplementationOnce(async () => exchanged({ iss: ISSUER, sub: "f:ldap:jdoe" }));
      await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=c&state=s"));

      const records = spy.mock.calls.map((call: unknown[]) => {
        const line = JSON.parse(call[0] as string) as { event: string; reason?: string; actor: string };
        return [line.event, line.reason, line.actor];
      });
      expect(records).toEqual([
        ["login_failure", "oidc_no_role", "testuser"],
        ["login_failure", "oidc_no_role", "f:ldap:jdoe"],
      ]);
      expect(setCookies.has("auth-token")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("the no-role refusal keeps the mount in its redirect and its state cleanup", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      mockMapOIDCRole.mockReturnValue(null);
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await GET(
          new Request("https://studio.example/tools/libredb/api/auth/oidc/callback?code=c&state=s"),
        );
        expect(res.headers.get("location")).toBe("https://studio.example/tools/libredb/login?error=oidc_no_role");
        expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-state", path: "/tools/libredb" });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("a no-role refusal still redirects with its own code when the audit emit throws", async () => {
    mockMapOIDCRole.mockReturnValue(null);
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const res = await GET(new Request("http://localhost:3000/api/auth/oidc/callback?code=c&state=s"));
      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_no_role");
      expect(setCookies.has("auth-token")).toBe(false);
    } finally {
      spy.mockRestore();
    }
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
        rolePrefix: undefined,
        adminRoles: ["admin"],
        userRoles: ["user"],
      }));
      mockExchangeCode.mockResolvedValue(exchanged({ ...defaultClaims }));
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

  describe("OIDC_LOGOUT_HINT", () => {
    const originalHint = process.env.OIDC_LOGOUT_HINT;
    const callbackUrl = "http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state";

    beforeEach(() => {
      process.env.OIDC_LOGOUT_HINT = "true";
    });

    afterEach(() => {
      if (originalHint === undefined) delete process.env.OIDC_LOGOUT_HINT;
      else process.env.OIDC_LOGOUT_HINT = originalHint;
      delete process.env.AUTH_SESSION_TTL_SECONDS;
    });

    test("with OIDC_LOGOUT_HINT on, the callback writes oidc-logout-hint scoped to /api/auth/logout", async () => {
      process.env.AUTH_SESSION_TTL_SECONDS = "28800";

      const res = await GET(new Request(callbackUrl));

      expect(res.headers.get("location")).toBe("http://localhost:3000/");
      expect(setCookies.get("oidc-logout-hint")).toBe(ID_TOKEN);
      expect(setCookieOptions.get("oidc-logout-hint")).toEqual({
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        maxAge: 28800,
        path: "/api/auth/logout",
      });
    });

    test("the hint cookie is scoped under the build's prefix", async () => {
      await withBasePathEnv("/tools/libredb", async () => {
        await GET(new Request("https://studio.example/tools/libredb/api/auth/oidc/callback?code=c&state=s"));
        expect(setCookieOptions.get("oidc-logout-hint")?.path).toBe("/tools/libredb/api/auth/logout");
      });
    });

    test("a token of exactly 3800 bytes is written", async () => {
      const token = "a".repeat(3800);
      mockExchangeCode.mockImplementationOnce(async () => exchanged({ ...defaultClaims }, token));

      await GET(new Request(callbackUrl));

      expect(setCookies.get("oidc-logout-hint")).toBe(token);
    });

    test("a token over 3800 bytes writes no cookie and deletes a stale one at the same path", async () => {
      mockExchangeCode.mockImplementationOnce(async () => exchanged({ ...defaultClaims }, "a".repeat(3801)));

      const res = await GET(new Request(callbackUrl));

      expect(res.headers.get("location")).toBe("http://localhost:3000/");
      expect(setCookies.has("auth-token")).toBe(true);
      expect(setCookies.has("oidc-logout-hint")).toBe(false);
      expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-logout-hint", path: "/api/auth/logout" });
    });

    test("with OIDC_LOGOUT_HINT unset the callback neither writes nor deletes the hint cookie", async () => {
      delete process.env.OIDC_LOGOUT_HINT;

      await GET(new Request(callbackUrl));

      expect(setCookies.has("auth-token")).toBe(true);
      expect(setCookies.has("oidc-logout-hint")).toBe(false);
      expect(mockCookieStore.delete).not.toHaveBeenCalledWith(expect.objectContaining({ name: "oidc-logout-hint" }));
    });

    test("a failed sign-in writes no hint cookie", async () => {
      mockExchangeCode.mockImplementationOnce(async () => exchanged({ sub: "user-123" }));

      await GET(new Request(callbackUrl));

      expect(setCookies.has("oidc-logout-hint")).toBe(false);
    });
  });

  // Under governance a session counts only with a subject (docs/GOVERNANCE.md#sign-in) and only for the identity
  // provider at OIDC_ISSUER. The callback mints no session that every request would refuse, because OIDC_AUTO_REDIRECT
  // would answer each refusal with the next sign-in, in a loop.
  describe("under governance", () => {
    const KEYS = ["GOVERNANCE_SOURCE", "OIDC_ISSUER"] as const;
    const saved: Record<string, string | undefined> = {};
    const callbackUrl = "http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state";
    let logSpy: ReturnType<typeof spyOn<Console, "log">>;

    beforeEach(() => {
      for (const key of KEYS) saved[key] = process.env[key];
      process.env.GOVERNANCE_SOURCE = "postgres";
      process.env.OIDC_ISSUER = ISSUER;
      logSpy = spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      resetGovernanceState();
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    /** Swaps in a fresh snapshot whose only revocation ends the sessions of `subject` issued at or before `atMs`. */
    function recordRevocation(subject: string, atMs: number): void {
      recordGovernanceSnapshot({ ...grantedSnapshot([], [], Date.now()), revocations: new Map([[subject, atMs]]) });
    }

    function auditReasons(): unknown[] {
      return logSpy.mock.calls.map((call) => (JSON.parse(String(call[0])) as Record<string, unknown>).reason);
    }

    async function expectRefusedAsConfiguration(res: Response): Promise<void> {
      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_config");
      expect(setCookies.has("auth-token")).toBe(false);
      // The exchange used the state up, so its cookie goes as it does after a sign-in.
      expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-state", path: "/" });
      expect(auditReasons()).toEqual(["oidc_config"]);
    }

    test("an ID token whose iss is not OIDC_ISSUER signs no one in and lands on /login?error=oidc_config", async () => {
      // openid-client accepts this for Microsoft Entra ID, whose common endpoint names each user's own tenant in iss.
      mockExchangeCode.mockImplementationOnce(async () =>
        exchanged({
          ...defaultClaims,
          iss: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
        }),
      );

      await expectRefusedAsConfiguration(await GET(new Request(callbackUrl)));
    });

    test("an ID token with an empty sub signs no one in and lands on /login?error=oidc_config", async () => {
      mockExchangeCode.mockImplementationOnce(async () => exchanged({ ...defaultClaims, sub: "" }));

      await expectRefusedAsConfiguration(await GET(new Request(callbackUrl)));
    });

    test("an ID token from OIDC_ISSUER with a subject signs in as it does without governance", async () => {
      const res = await GET(new Request(callbackUrl));

      expect(res.headers.get("location")).toBe("http://localhost:3000/");
      expect(await mintedSession()).toMatchObject({ idpSubject: "user-123", idpIssuer: ISSUER });
      expect(auditReasons()).toEqual([undefined]);
    });

    // Every request refuses a session issued at or before its subject's revoked_before (docs/GOVERNANCE.md#sign-in).
    // A revocation dated ahead of this second, as when the control plane's clock runs ahead of Studio's or a row's
    // revoked_before is unreadable and counts as infinity, would refuse the session the callback is about to mint, and
    // OIDC_AUTO_REDIRECT would answer that refusal with the next silent sign-in, again and again.
    test("a subject whose sessions are revoked from this second on gets no session and lands on /login?error=oidc_session_revoked", async () => {
      recordRevocation("user-123", Date.now() + 60_000);

      const res = await GET(new Request(callbackUrl));

      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_session_revoked");
      expect(setCookies.has("auth-token")).toBe(false);
      expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-state", path: "/" });
      expect(auditReasons()).toEqual(["oidc_session_revoked"]);
    });

    test("a revocation that refuses sessions issued for good, an unreadable revoked_before, also mints none", async () => {
      recordRevocation("user-123", Number.POSITIVE_INFINITY);

      const res = await GET(new Request(callbackUrl));

      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_session_revoked");
      expect(setCookies.has("auth-token")).toBe(false);
    });

    // The control: a revocation ends the sessions issued before it, and a sign-in after it gets a session the
    // revocation does not refuse, as docs/GOVERNANCE.md#sign-in states.
    test("a sign-in after the subject's revoked_before gets a session", async () => {
      recordRevocation("user-123", Date.now() - 60_000);

      const res = await GET(new Request(callbackUrl));

      expect(res.headers.get("location")).toBe("http://localhost:3000/");
      expect(await mintedSession()).toMatchObject({ idpSubject: "user-123" });
      expect(auditReasons()).toEqual([undefined]);
    });

    test("another subject's revocation does not refuse this sign-in", async () => {
      recordRevocation("someone-else", Date.now() + 60_000);

      await GET(new Request(callbackUrl));

      expect(await mintedSession()).toMatchObject({ idpSubject: "user-123" });
    });

    test("an iss that differs from OIDC_ISSUER only by the trailing slash of a bare host signs in", async () => {
      mockExchangeCode.mockImplementationOnce(async () => exchanged({ ...defaultClaims, iss: `${ISSUER}/` }));

      await GET(new Request(callbackUrl));

      expect(await mintedSession()).toMatchObject({ idpSubject: "user-123", idpIssuer: `${ISSUER}/` });
    });
  });

  describe("claim roles (OIDC_ROLE_PREFIX)", () => {
    const callbackUrl = "http://localhost:3000/api/auth/oidc/callback?code=auth-code&state=test-state";

    test("session with claim roles carries claimRoles when OIDC_ROLE_PREFIX is set", async () => {
      mockGetOIDCConfig.mockReturnValueOnce({
        issuer: ISSUER,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        scope: "openid profile email",
        roleClaim: "roles",
        rolePrefix: "team-",
        adminRoles: ["admin"],
        userRoles: ["user"],
      });
      mockExchangeCode.mockImplementationOnce(async () =>
        exchanged({ ...defaultClaims, roles: ["user", "team-billing", "team-dev"] }),
      );

      const res = await GET(new Request(callbackUrl));
      expect(res.status).toBe(307);
      const session = await mintedSession();
      expect(session?.claimRoles).toEqual(["team-billing", "team-dev"]);
    });

    test("feature off gives the old session shape without claimRoles", async () => {
      mockGetOIDCConfig.mockReturnValueOnce({
        issuer: ISSUER,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        scope: "openid profile email",
        roleClaim: "roles",
        rolePrefix: undefined,
        adminRoles: ["admin"],
        userRoles: ["user"],
      });
      mockExchangeCode.mockImplementationOnce(async () =>
        exchanged({ ...defaultClaims, roles: ["user", "team-billing"] }),
      );

      const res = await GET(new Request(callbackUrl));
      expect(res.status).toBe(307);
      const session = await mintedSession();
      expect(session?.claimRoles).toBeUndefined();
    });

    test("oidc_role_overflow refusal and audit when claim roles exceed limits", async () => {
      mockGetOIDCConfig.mockReturnValueOnce({
        issuer: ISSUER,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        scope: "openid profile email",
        roleClaim: "roles",
        rolePrefix: "team-",
        adminRoles: ["admin"],
        userRoles: ["user"],
      });
      // 21 matching roles
      const tooManyRoles = Array.from({ length: 21 }, (_, i) => `team-${i}`);
      mockExchangeCode.mockImplementationOnce(async () =>
        exchanged({ ...defaultClaims, roles: ["user", ...tooManyRoles] }),
      );

      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await GET(new Request(callbackUrl));
        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_role_overflow");
        expect(setCookies.has("auth-token")).toBe(false);
        expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-state", path: "/" });

        const lines = spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>);
        expect(lines[0]).toMatchObject({
          event: "login_failure",
          reason: "oidc_role_overflow",
          route: "GET /api/auth/oidc/callback",
        });
      } finally {
        spy.mockRestore();
      }
    });

    test("OIDC_USER_ROLES still refuses a claim-roles-only account as oidc_no_role", async () => {
      mockGetOIDCConfig.mockReturnValueOnce({
        issuer: ISSUER,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        scope: "openid profile email",
        roleClaim: "roles",
        rolePrefix: "team-",
        adminRoles: ["admin"],
        userRoles: ["user"],
      });
      mockMapOIDCRole.mockReturnValueOnce(null);
      mockExchangeCode.mockImplementationOnce(async () => exchanged({ ...defaultClaims, roles: ["team-billing"] }));

      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await GET(new Request(callbackUrl));
        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=oidc_no_role");
        expect(setCookies.has("auth-token")).toBe(false);
        expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "oidc-state", path: "/" });

        const lines = spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>);
        expect(lines[0]).toMatchObject({
          event: "login_failure",
          reason: "oidc_no_role",
          route: "GET /api/auth/oidc/callback",
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

// Whenever the auth cookies are Secure, the callback reads __Host-oidc-state alone, deletes it with Secure at Path=/ on
// every exit that consumes the state, and keeps the logout hint as __Host-oidc-logout-hint at Path=/.
describe("GET /api/auth/oidc/callback with host-prefixed names", () => {
  const callbackUrl = "https://studio.example.com/api/auth/oidc/callback?code=auth-code&state=test-state";
  const STATE_DELETION = { name: "__Host-oidc-state", path: "/", secure: true };

  beforeEach(() => {
    process.env.AUTH_COOKIE_SECURE = "true";
    mockDecryptState.mockClear();
    mockCookieGet.mockClear();
    setCookies.clear();
    setCookieOptions.clear();
    mockCookieStore.delete.mockClear();
    mockMapOIDCRole.mockReturnValue("user");
    mockExchangeCode.mockImplementation(async () => exchanged({ ...defaultClaims }));
    mockCookieGet.mockImplementation((name: string) =>
      name === "__Host-oidc-state" ? { value: "encrypted-state-cookie" } : undefined,
    );
  });

  afterEach(() => {
    delete process.env.AUTH_COOKIE_SECURE;
    delete process.env.OIDC_LOGOUT_HINT;
    mockCookieGet.mockImplementation(() => ({ value: "encrypted-state-cookie" }));
  });

  test("signs in from __Host-oidc-state, sets __Host-auth-token and deletes the state with Secure", async () => {
    const res = await GET(new Request(callbackUrl));
    expect(res.headers.get("location")).toBe("https://studio.example.com/");
    expect(mockCookieGet).toHaveBeenCalledWith("__Host-oidc-state");
    expect(setCookies.has("__Host-auth-token")).toBe(true);
    expect(setCookies.has("auth-token")).toBe(false);
    expect(mockCookieStore.delete).toHaveBeenCalledWith(STATE_DELETION);
  });

  test("a plain-named state cookie is never read: the callback answers oidc_state_missing", async () => {
    mockCookieGet.mockImplementation((name: string) =>
      name === "oidc-state" ? { value: "encrypted-state-cookie" } : undefined,
    );
    const res = await GET(new Request(callbackUrl));
    expect(res.headers.get("location")).toContain("error=oidc_state_missing");
    expect(mockDecryptState).not.toHaveBeenCalledWith("encrypted-state-cookie");
  });

  test("a state that does not decrypt and a sign-in with no role both delete __Host-oidc-state with Secure", async () => {
    mockDecryptState.mockImplementationOnce(async () => {
      throw new Error("Invalid token");
    });
    expect((await GET(new Request(callbackUrl))).headers.get("location")).toContain("error=oidc_state_invalid");
    expect(mockCookieStore.delete).toHaveBeenCalledWith(STATE_DELETION);

    mockCookieStore.delete.mockClear();
    mockMapOIDCRole.mockReturnValue(null);
    expect((await GET(new Request(callbackUrl))).headers.get("location")).toContain("error=oidc_no_role");
    expect(mockCookieStore.delete).toHaveBeenCalledWith(STATE_DELETION);
  });

  test("the logout hint is __Host-oidc-logout-hint at Path=/, and a token too large deletes it with Secure", async () => {
    process.env.OIDC_LOGOUT_HINT = "true";
    await GET(new Request(callbackUrl));
    expect(setCookies.get("__Host-oidc-logout-hint")).toBe(ID_TOKEN);
    expect(setCookieOptions.get("__Host-oidc-logout-hint")).toMatchObject({ path: "/", secure: true, httpOnly: true });

    mockExchangeCode.mockImplementationOnce(async () => exchanged({ ...defaultClaims }, "a".repeat(3801)));
    await GET(new Request(callbackUrl));
    expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: "__Host-oidc-logout-hint", path: "/", secure: true });
  });

  // The size check counts the name the cookie is written under: a long base path makes __Host-oidc-logout-hint<suffix>
  // too long for a token the plain name would still hold, so the token is not written and a stale hint is deleted.
  test("a token that fits only beside the plain name is not kept under a long base path's __Host- name", async () => {
    process.env.OIDC_LOGOUT_HINT = "true";
    const segment = "a".repeat(280);
    const hintName = `__Host-oidc-logout-hint.${segment}`;
    mockCookieGet.mockImplementation((name: string) =>
      name === `__Host-oidc-state.${segment}` ? { value: "encrypted-state-cookie" } : undefined,
    );
    mockExchangeCode.mockImplementationOnce(async () => exchanged({ ...defaultClaims }, "a".repeat(3800)));
    await withBasePathEnv(`/${segment}`, async () => {
      await GET(new Request(`https://studio.example.com/${segment}/api/auth/oidc/callback?code=c&state=test-state`));
    });
    expect(setCookies.has(`__Host-auth-token.${segment}`)).toBe(true);
    expect(setCookies.has(hintName)).toBe(false);
    expect(mockCookieStore.delete).toHaveBeenCalledWith({ name: hintName, path: "/", secure: true });
  });
});
