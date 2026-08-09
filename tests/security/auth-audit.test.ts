import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AuthConfigError } from "@/lib/auth-errors";

/**
 * Threat: an authentication event that leaves no trace.
 *
 * Every way into and out of a session must produce exactly one audit record with a reason drawn
 * from the closed union. The logout record in particular must carry the identity that was
 * destroyed, which is only possible if getSession() runs BEFORE logout() clears the cookie.
 */

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin@libredb.org" }),
);
const mockLogout = mock(async () => {});
const mockLogin = mock(async () => {});

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  logout: mockLogout,
  login: mockLogin,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
}));

const mockDecryptState = mock(async () => ({
  code_verifier: "verifier",
  state: "state",
  nonce: "nonce",
}));
const mockExchangeCode = mock(
  async () => ({ email: "user@example.com", sub: "user-123" }) as Record<string, unknown> | null,
);
const mockDiscoverProvider = mock(async () => "mock-config");
const mockGetOIDCConfig = mock(() => ({ roleClaim: "roles", adminRoles: ["admin"] }));

mock.module("@/lib/oidc", () => ({
  getOIDCConfig: mockGetOIDCConfig,
  discoverProvider: mockDiscoverProvider,
  generateAuthUrl: mock(async () => ({})),
  encryptState: mock(async () => ""),
  decryptState: mockDecryptState,
  exchangeCode: mockExchangeCode,
  mapOIDCRole: mock(() => "user" as "admin" | "user"),
  resetDiscoveryCache: mock(() => {}),
  buildLogoutUrl: mock(() => null as string | null),
  getPublicOrigin: mock((req: Request) => new URL(req.url).origin),
}));

const cookieStore = {
  get: mock((name: string) => (name === "oidc-state" ? { name, value: "state-cookie" } : undefined)),
  set: mock(() => {}),
  delete: mock(() => {}),
};

mock.module("next/headers", () => ({
  cookies: mock(async () => cookieStore),
  headers: mock(async () => new Headers()),
}));

const { POST: logoutRoute } = await import("@/app/api/auth/logout/route");
const { GET: oidcCallback } = await import("@/app/api/auth/oidc/callback/route");

function auditLines(spy: ReturnType<typeof spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>);
}

function callbackRequest(): Request {
  return new Request("http://localhost:3000/api/auth/oidc/callback?code=abc&state=state");
}

beforeEach(() => {
  mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin@libredb.org" }));
  mockLogout.mockClear();
  cookieStore.get.mockImplementation((name: string) =>
    name === "oidc-state" ? { name, value: "state-cookie" } : undefined,
  );
  mockDecryptState.mockImplementation(async () => ({ code_verifier: "v", state: "s", nonce: "n" }));
  mockExchangeCode.mockImplementation(async () => ({ email: "user@example.com", sub: "user-123" }));
  mockDiscoverProvider.mockImplementation(async () => "mock-config");
});

describe("logout", () => {
  test("records the identity that was destroyed, not an anonymous one", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await logoutRoute(new Request("http://localhost:3000/api/auth/logout", { method: "POST" }) as never);
      const lines = auditLines(spy);

      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe("logout");
      expect(lines[0].actor).toBe("admin@libredb.org");
      expect(lines[0].outcome).toBe("success");
      expect(mockLogout).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("does not emit an audit line when there was no session to destroy", async () => {
    // No session means no state transition occurred. "anonymous logged out" would be noise, and
    // this route is public and unrated-limited, so recording it would let an unauthenticated
    // caller flood the audit trail (and the admin UI's 1000-entry ring buffer) for free.
    mockGetSession.mockImplementation(async () => null);
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await logoutRoute(new Request("http://localhost:3000/api/auth/logout", { method: "POST" }) as never);

      expect(auditLines(spy)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("emits no audit line when logout() throws, even though a session existed", async () => {
    // The property this task is named for: a failure between reading the identity and destroying
    // the session must never produce a line asserting a logout that did not happen.
    mockLogout.mockImplementationOnce(async () => {
      throw new Error("cookie store unavailable");
    });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await logoutRoute(new Request("http://localhost:3000/api/auth/logout", { method: "POST" }) as never);

      expect(auditLines(spy)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("does not fail the logout response when the audit emit itself throws", async () => {
    // The emit is isolated in its own try/catch, separate from logout() above: an audit failure
    // must never change the outcome of the logout it is recording.
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const response = await logoutRoute(
        new Request("http://localhost:3000/api/auth/logout", { method: "POST" }) as never,
      );

      expect(response.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the OIDC callback", () => {
  test("records a successful federated login", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await oidcCallback(callbackRequest());
      const lines = auditLines(spy);

      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe("login_success");
      expect(lines[0].actor).toBe("user@example.com");
      expect(lines[0].route).toBe("GET /api/auth/oidc/callback");
    } finally {
      spy.mockRestore();
    }
  });

  test("records a missing state cookie", async () => {
    cookieStore.get.mockImplementation(() => undefined);
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await oidcCallback(callbackRequest());
      const lines = auditLines(spy);

      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe("login_failure");
      expect(lines[0].reason).toBe("oidc_state_missing");
      expect(lines[0].actor).toBe("anonymous");
    } finally {
      spy.mockRestore();
    }
  });

  test("records an undecryptable state cookie", async () => {
    mockDecryptState.mockImplementation(async () => {
      throw new Error("bad state");
    });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await oidcCallback(callbackRequest());
      const lines = auditLines(spy);

      expect(lines).toHaveLength(1);
      expect(lines[0].reason).toBe("oidc_state_invalid");
    } finally {
      spy.mockRestore();
    }
  });

  test("records a token exchange that returned no claims", async () => {
    mockExchangeCode.mockImplementation(async () => null);
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await oidcCallback(callbackRequest());
      const lines = auditLines(spy);

      expect(lines).toHaveLength(1);
      expect(lines[0].reason).toBe("oidc_no_claims");
    } finally {
      spy.mockRestore();
    }
  });

  test("records a provider failure without leaking the error text", async () => {
    mockDiscoverProvider.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443 while reaching https://idp/.well-known");
    });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await oidcCallback(callbackRequest());
      const lines = auditLines(spy);

      expect(lines).toHaveLength(1);
      expect(lines[0].reason).toBe("oidc_failed");
      // The reason is a closed union, which is exactly why no driver string can reach the record.
      expect(JSON.stringify(lines[0])).not.toContain("ECONNREFUSED");
      expect(JSON.stringify(lines[0])).not.toContain("10.0.0.1");
    } finally {
      spy.mockRestore();
    }
  });

  test("records a configuration failure with its own reason", async () => {
    // A real AuthConfigError, not a plain Error whose message happens to contain "config": the
    // classification in the route is `instanceof AuthConfigError`, not a message substring match,
    // so this message deliberately does NOT contain the word "config" - a regression back to
    // substring matching would make this specific message fail the assertion below while an
    // instanceof check keeps passing it. The reverse case - a plain Error, classified oidc_failed
    // regardless of its text - is already pinned above by "records a provider failure without
    // leaking the error text".
    mockDiscoverProvider.mockImplementation(async () => {
      throw new AuthConfigError("JWT_SECRET is required for OIDC state encryption");
    });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await oidcCallback(callbackRequest());
      const lines = auditLines(spy);

      expect(lines).toHaveLength(1);
      expect(lines[0].reason).toBe("oidc_config");
    } finally {
      spy.mockRestore();
    }
  });

  test("does not leak the authorization code or an access token when the exchange fails", async () => {
    const authorizationCode = "SplxlOBeZQQYbYS6WxSbIA";
    const accessToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    mockExchangeCode.mockImplementation(async () => {
      throw new Error(`token exchange failed for code ${authorizationCode} with access_token ${accessToken}`);
    });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const request = new Request(`http://localhost:3000/api/auth/oidc/callback?code=${authorizationCode}&state=state`);
      await oidcCallback(request);
      const lines = auditLines(spy);
      const emitted = JSON.stringify(lines[0]);

      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe("login_failure");
      expect(lines[0].reason).toBe("oidc_failed");
      expect(emitted).not.toContain(authorizationCode);
      expect(emitted).not.toContain(accessToken);
      expect(emitted).not.toContain("access_token");
    } finally {
      spy.mockRestore();
    }
  });

  test("still redirects to the app when the success audit emit throws", async () => {
    // The emit is isolated in its own try/catch, separate from login() above: a real session
    // already exists by this point, so an audit failure must never turn a successful login into a
    // recorded (or outer-catch-driven) login_failure, nor into an error redirect.
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const response = await oidcCallback(callbackRequest());

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).not.toContain("error=");
    } finally {
      spy.mockRestore();
    }
  });

  test("still redirects with the original failure reason when the audit emit throws", async () => {
    // auditFailure() swallows its own throw. Without that isolation, the outer catch would
    // reclassify this as oidc_failed instead of the true oidc_state_missing.
    cookieStore.get.mockImplementation(() => undefined);
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const response = await oidcCallback(callbackRequest());

      expect(response.headers.get("location")).toContain("error=oidc_state_missing");
    } finally {
      spy.mockRestore();
    }
  });
});
