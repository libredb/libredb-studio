import { withBasePathEnv } from "../../helpers/base-path";
import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { AuthConfigError } from "@/lib/auth-errors";

// ─── Mock dependencies ─────────────────────────────────────────────────────

const mockGetOIDCConfig = mock(() => ({
  issuer: "https://example.auth0.com",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  scope: "openid profile email",
  roleClaim: "",
  adminRoles: ["admin"],
}));

const mockDiscoverProvider = mock(async () => "mock-config");

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockGenerateAuthUrl = mock(async (_config: unknown, _redirectUri: string, _scope: string) => ({
  url: new URL("https://example.auth0.com/authorize?state=abc&code_challenge=xyz"),
  state: {
    code_verifier: "test-verifier",
    state: "test-state",
    nonce: "test-nonce",
  },
}));

const mockEncryptState = mock(async () => "encrypted-state-token");

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockCookieSet = mock((_name: string, _value: string, _options?: Record<string, unknown>) => {});

const mockGetPublicOrigin = mock((req: Request) => new URL(req.url).origin);

mock.module("@/lib/oidc", () => ({
  getOIDCConfig: mockGetOIDCConfig,
  discoverProvider: mockDiscoverProvider,
  generateAuthUrl: mockGenerateAuthUrl,
  encryptState: mockEncryptState,
  decryptState: mock(async () => ({})),
  exchangeCode: mock(async () => ({})),
  mapOIDCRole: mock(() => "user"),
  resetDiscoveryCache: mock(() => {}),
  getPublicOrigin: mockGetPublicOrigin,
}));

const mockCookieStore = {
  get: mock(() => undefined),
  set: mockCookieSet,
  delete: mock(() => {}),
};

mock.module("next/headers", () => ({
  cookies: mock(async () => mockCookieStore),
  // auth.ts also imports headers() (loopback-aware cookie flags); the mock
  // replaces the module wholesale, so it has to expose every imported name.
  headers: mock(async () => ({ get: () => null })),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────

const { GET } = await import("@/app/api/auth/oidc/login/route");

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/auth/oidc/login", () => {
  beforeEach(() => {
    mockGetOIDCConfig.mockClear();
    mockDiscoverProvider.mockClear();
    mockGenerateAuthUrl.mockClear();
    mockEncryptState.mockClear();
    mockCookieSet.mockClear();
    mockGetPublicOrigin.mockClear();
    mockGetPublicOrigin.mockImplementation((req: Request) => new URL(req.url).origin);
  });

  test("redirects to OIDC provider authorization URL", async () => {
    const req = new Request("http://localhost:3000/api/auth/oidc/login");
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBe("https://example.auth0.com/authorize?state=abc&code_challenge=xyz");
  });

  test("sets oidc-state cookie", async () => {
    const req = new Request("http://localhost:3000/api/auth/oidc/login");
    await GET(req);

    expect(mockCookieSet).toHaveBeenCalledTimes(1);
    const [name, value, options] = mockCookieSet.mock.calls[0];
    expect(name).toBe("oidc-state");
    expect(value).toBe("encrypted-state-token");
    expect(options!.httpOnly).toBe(true);
    expect(options!.maxAge).toBe(300);
  });

  // The state cookie has to follow the same Secure rule as the session cookie.
  // If the browser drops it - plain http with a Secure flag - the PKCE verifier
  // is gone by the time the provider redirects back, and the callback fails on
  // a missing state instead of logging the user in.
  test("applies the shared Secure rule to the oidc-state cookie", async () => {
    for (const [override, expected] of [
      ["true", true],
      ["false", false],
    ] as const) {
      process.env.AUTH_COOKIE_SECURE = override;
      mockCookieSet.mockClear();
      try {
        await GET(new Request("http://localhost:3000/api/auth/oidc/login"));
      } finally {
        delete process.env.AUTH_COOKIE_SECURE;
      }
      const [, , options] = mockCookieSet.mock.calls[0];
      expect(options!.secure).toBe(expected);
    }
  });

  test("uses correct redirect URI based on request origin", async () => {
    const req = new Request("https://app.example.com/api/auth/oidc/login");
    await GET(req);

    expect(mockGenerateAuthUrl).toHaveBeenCalledTimes(1);
    const [, redirectUri] = mockGenerateAuthUrl.mock.calls[0];
    expect(redirectUri).toBe("https://app.example.com/api/auth/oidc/callback");
  });

  test("uses public origin from getPublicOrigin for redirect_uri", async () => {
    mockGetPublicOrigin.mockReturnValue("https://app.libredb.org");

    const req = new Request("http://0.0.0.0:10000/api/auth/oidc/login");
    await GET(req);

    expect(mockGenerateAuthUrl).toHaveBeenCalledTimes(1);
    const [, redirectUri] = mockGenerateAuthUrl.mock.calls[0];
    expect(redirectUri).toBe("https://app.libredb.org/api/auth/oidc/callback");
  });

  test("redirects to /login?error=oidc_config when config fails", async () => {
    // AuthConfigError by type, not a message containing "config": the route classifies with
    // instanceof, and this message deliberately does not contain the word.
    mockGetOIDCConfig.mockImplementationOnce(() => {
      throw new AuthConfigError("OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET are required");
    });

    const req = new Request("http://localhost:3000/api/auth/oidc/login");
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/login?error=oidc_config");
  });

  test("redirects to /login?error=oidc_discovery when discovery fails", async () => {
    // A plain Error from discovery. Its text mentions config on purpose: a regression back to
    // substring matching on error.message would classify this as oidc_config, and the
    // assertion below is what pins the classification to the type instead.
    mockDiscoverProvider.mockImplementationOnce(async () => {
      throw new Error("getaddrinfo ENOTFOUND idp.internal (check your config)");
    });

    const req = new Request("http://localhost:3000/api/auth/oidc/login");
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/login?error=oidc_discovery");
    expect(location).not.toContain("ENOTFOUND");
  });

  test("redirects to /login?error=oidc_failed when the provider answered and a later step throws", async () => {
    // Discovery succeeded, so "the identity provider could not be reached" would be false. This
    // is the callback route's generic code, for which "try again" is the right advice.
    mockGenerateAuthUrl.mockImplementationOnce(async () => {
      throw new Error("authorization_endpoint missing from discovery document");
    });

    const res = await GET(new Request("http://localhost:3000/api/auth/oidc/login"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=oidc_failed");
  });

  test("classifies an AuthConfigError thrown after discovery as oidc_config", async () => {
    // The state cookie is signed after the provider answered, and a missing or too-short JWT
    // secret is still the operator's configuration. The type check has to win over "where it
    // happened".
    mockEncryptState.mockImplementationOnce(async () => {
      throw new AuthConfigError("JWT_SECRET is required for OIDC state encryption");
    });

    const res = await GET(new Request("http://localhost:3000/api/auth/oidc/login"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=oidc_config");
  });

  // The audit record carries the class and nothing else. An operator bringing up SSO can tell "a
  // variable is missing" from "the issuer did not answer" in the audit trail, and neither line ever
  // holds the error text. Real audit module, spied at the sink: the route's own catch is the code
  // under test.
  function auditLines(spy: ReturnType<typeof spyOn>): Record<string, unknown>[] {
    return spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>);
  }

  test("records a missing-configuration failure as oidc_config", async () => {
    mockGetOIDCConfig.mockImplementationOnce(() => {
      throw new AuthConfigError("OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET are required");
    });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await GET(new Request("http://localhost:3000/api/auth/oidc/login"));
      const lines = auditLines(spy);

      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe("login_failure");
      expect(lines[0].route).toBe("GET /api/auth/oidc/login");
      expect(lines[0].reason).toBe("oidc_config");
      expect(JSON.stringify(lines[0])).not.toContain("OIDC_ISSUER");
      // No proxy headers are trusted by default, so the address is "unknown" and the line omits it
      // rather than recording a placeholder.
      expect(lines[0]).not.toHaveProperty("ip");
    } finally {
      spy.mockRestore();
    }
  });

  test("records a discovery failure as oidc_discovery without the error text", async () => {
    mockDiscoverProvider.mockImplementationOnce(async () => {
      throw new Error("only requests to HTTPS are allowed");
    });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await GET(new Request("http://localhost:3000/api/auth/oidc/login"));
      const lines = auditLines(spy);

      expect(lines).toHaveLength(1);
      expect(lines[0].reason).toBe("oidc_discovery");
      expect(JSON.stringify(lines[0])).not.toContain("HTTPS");
    } finally {
      spy.mockRestore();
    }
  });

  test("keeps the redirect code when the audit sink throws", async () => {
    // The audit call sits inside the route's catch. If it were allowed to throw, the route would
    // return a 500 instead of the redirect, and the user would see nothing at all.
    mockDiscoverProvider.mockImplementationOnce(async () => {
      throw new Error("getaddrinfo ENOTFOUND idp.internal");
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await GET(new Request("http://localhost:3000/api/auth/oidc/login"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login?error=oidc_discovery");
      // Isolated, not swallowed: the sink failure is logged with the route, so an empty catch
      // would fail here. The logger emits a format string first when a stack is attached, so
      // every argument is searched.
      expect(
        errorSpy.mock.calls.some((call) =>
          call.some((arg) => String(arg).includes("Failed to record OIDC login_failure audit event")),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
  test("OIDC authorization and state cookie share the prefixed callback path", async () => {
    await withBasePathEnv("/~/libredb", async () => {
      mockGenerateAuthUrl.mockClear();
      mockCookieSet.mockClear();
      await GET(new Request("https://studio.example/~/libredb/api/auth/oidc/login"));
      expect(mockGenerateAuthUrl.mock.calls[0][1]).toBe("https://studio.example/~/libredb/api/auth/oidc/callback");
      expect(mockCookieSet.mock.calls[0][2]).toMatchObject({ path: "/~/libredb", sameSite: "lax", httpOnly: true });
    });
  });
});
