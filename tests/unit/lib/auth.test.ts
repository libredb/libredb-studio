import { withBasePathEnv } from "../../helpers/base-path";
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import * as jose from "jose";
import { logger } from "@/lib/logger";
import * as localAccounts from "@/lib/local-accounts";
import * as oidcBearer from "@/lib/oidc-bearer";

// ============================================================================
// Mock State — only mock next/headers (cookies), NOT jose
// jose is used for real JWT sign/verify with JWT_SECRET from setup.ts
// ============================================================================

let mockCookieStore: Record<string, { value: string } | undefined> = {};
let mockSetCalls: Array<{ name: string; value: string; opts: unknown }> = [];
let mockDeleteCalls: Array<string | { name: string; path: string }> = [];

// ============================================================================
// Module Mocks — only next/headers
// ============================================================================

let mockRequestHeaders: Record<string, string> = {};
let mockHeadersThrow: Error | null = null;

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => mockCookieStore[name],
    set: (name: string, value: string, opts: unknown) => {
      mockSetCalls.push({ name, value, opts });
      mockCookieStore[name] = { value };
    },
    delete: (cookie: string | { name: string; path: string }) => {
      mockDeleteCalls.push(cookie);
      delete mockCookieStore[typeof cookie === "string" ? cookie : cookie.name];
    },
  }),
  headers: async () => {
    if (mockHeadersThrow) throw mockHeadersThrow;
    return { get: (name: string) => mockRequestHeaders[name.toLowerCase()] ?? null };
  },
}));

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

const {
  signJWT,
  verifyJWT,
  getSession,
  readSession,
  login,
  logout,
  resetCookieSecurityWarning,
  readCookieSecureOverride,
  isLoopbackHost,
} = await import("@/lib/auth");

// ============================================================================
// Tests — use real jose sign/verify with JWT_SECRET from tests/setup.ts
// ============================================================================

describe("auth", () => {
  beforeEach(() => {
    mockCookieStore = {};
    mockSetCalls = [];
    mockDeleteCalls = [];
    mockRequestHeaders = {};
    mockHeadersThrow = null;
  });

  // --------------------------------------------------------------------------
  // signJWT()
  // --------------------------------------------------------------------------

  describe("signJWT()", () => {
    test("returns a token string", async () => {
      const token = await signJWT({ role: "admin", username: "admin" });
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
      // Real JWT has 3 dot-separated parts
      expect(token.split(".").length).toBe(3);
    });

    test("accepts admin role", async () => {
      const token = await signJWT({ role: "admin", username: "admin" });
      expect(typeof token).toBe("string");
    });

    test("accepts user role", async () => {
      const token = await signJWT({ role: "user", username: "user" });
      expect(typeof token).toBe("string");
    });

    test("holds token under 4096 bytes with 20 roles of 64 UTF-8 bytes containing multi-byte characters", async () => {
      const roles: string[] = [];
      for (let i = 0; i < 20; i++) {
        const prefix = `team:${i.toString().padStart(2, "0")}:`; // 8 ASCII bytes
        // 56 bytes of 2-byte characters = 28 characters
        const role = prefix + "ö".repeat(28); // 8 + 56 = 64 bytes
        expect(Buffer.byteLength(role, "utf8")).toBe(64);
        roles.push(role);
      }
      const token = await signJWT({
        role: "user",
        username: "testuser",
        idpSubject: "sub-1234567890",
        idpIssuer: "https://idp.example.com/auth/realms/master",
        claimRoles: roles,
      });
      // The auth-token cookie must remain well under 4096 bytes so browsers do not drop it
      expect(Buffer.byteLength(token, "utf8")).toBeLessThan(4096);
      const verified = await verifyJWT(token);
      expect(verified).not.toBeNull();
      expect(verified?.claimRoles).toEqual(roles);
    });
  });

  // --------------------------------------------------------------------------
  // verifyJWT()
  // --------------------------------------------------------------------------

  describe("verifyJWT()", () => {
    test("valid token returns UserPayload", async () => {
      const token = await signJWT({ role: "admin", username: "admin" });
      const payload = await verifyJWT(token);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe("admin");
      expect(payload!.username).toBe("admin");
    });

    test("invalid token returns null", async () => {
      const payload = await verifyJWT("invalid-token-string");
      expect(payload).toBeNull();
    });

    test("expired token returns null (debug log branch)", async () => {
      // jose reports expiry as '"exp" claim timestamp check failed', which does
      // not contain "expired" — spy jwtVerify to exercise the expired branch.
      const spy = spyOn(jose, "jwtVerify").mockImplementation(() => {
        throw new Error("JWT token expired");
      });
      try {
        const payload = await verifyJWT("expired-token");
        expect(payload).toBeNull();
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  // --------------------------------------------------------------------------
  // readSession() and getSession() (#1942)
  // --------------------------------------------------------------------------

  describe("readSession() and getSession()", () => {
    test("returns authenticated when auth-token cookie exists and account is allowed", async () => {
      const token = await signJWT({ role: "user", username: "user" });
      mockCookieStore["auth-token"] = { value: token };

      const reading = await readSession();
      expect(reading.kind).toBe("authenticated");
      if (reading.kind === "authenticated") {
        expect(reading.session.role).toBe("user");
        expect(reading.session.username).toBe("user");
      }

      const session = await getSession();
      expect(session).not.toBeNull();
      expect(session!.role).toBe("user");
      expect(session!.username).toBe("user");
    });

    test("returns anonymous when no cookie", async () => {
      const reading = await readSession();
      expect(reading.kind).toBe("anonymous");

      const session = await getSession();
      expect(session).toBeNull();
    });

    test("returns anonymous when cookie does not verify", async () => {
      mockCookieStore["auth-token"] = { value: "invalid-token" };

      const reading = await readSession();
      expect(reading.kind).toBe("anonymous");

      const session = await getSession();
      expect(session).toBeNull();
    });

    test("returns anonymous and logs out when account is refused", async () => {
      const token = await signJWT({ role: "user", username: "user" });
      mockCookieStore["auth-token"] = { value: token };
      const allowsSpy = spyOn(localAccounts, "storedAccountAllows").mockResolvedValue(false);

      try {
        const reading = await readSession();
        expect(reading.kind).toBe("anonymous");
        expect(mockDeleteCalls).toContainEqual({ name: "auth-token", path: "/" });

        const session = await getSession();
        expect(session).toBeNull();
      } finally {
        allowsSpy.mockRestore();
      }
    });

    test("returns store_unavailable when storedAccountAllows throws, and keeps cookie (#1942)", async () => {
      const token = await signJWT({ role: "user", username: "user" });
      mockCookieStore["auth-token"] = { value: token };
      mockDeleteCalls = [];
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const allowsSpy = spyOn(localAccounts, "storedAccountAllows").mockRejectedValue(
        new Error("sqlite database is locked"),
      );

      try {
        const reading = await readSession();
        expect(reading.kind).toBe("store_unavailable");
        if (reading.kind === "store_unavailable") {
          expect((reading.error as Error).message).toBe("sqlite database is locked");
        }
        // Crucial: cookie is kept, logout is NOT called!
        expect(mockDeleteCalls).toHaveLength(0);
        expect(mockCookieStore["auth-token"]?.value).toBe(token);

        // getSession contract: returns null without throwing
        const session = await getSession();
        expect(session).toBeNull();
      } finally {
        allowsSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    describe("bearer authentication", () => {
      test("returns anonymous on bearer fault", async () => {
        const errorSpy = spyOn(console, "error").mockImplementation(() => {});
        const bearerSpy = spyOn(oidcBearer, "authenticateBearer").mockResolvedValue({
          kind: "fault",
          error: new Error("JWKS fetch timeout"),
        });

        try {
          const reading = await readSession();
          expect(reading.kind).toBe("anonymous");

          const session = await getSession();
          expect(session).toBeNull();
        } finally {
          bearerSpy.mockRestore();
          errorSpy.mockRestore();
        }
      });

      test("returns anonymous on bearer denial", async () => {
        const bearerSpy = spyOn(oidcBearer, "authenticateBearer").mockResolvedValue({
          kind: "denied",
          reason: "bearer_token_invalid",
        });

        try {
          const reading = await readSession();
          expect(reading.kind).toBe("anonymous");

          const session = await getSession();
          expect(session).toBeNull();
        } finally {
          bearerSpy.mockRestore();
        }
      });

      test("returns authenticated when bearer is authenticated and storedAccountAllows passes", async () => {
        const bearerSession = {
          role: "admin" as const,
          username: "admin@example.com",
          idpSubject: "sub-123",
          idpIssuer: "https://idp.example.com",
          iat: 1000,
          exp: 2000,
          channel: "bearer" as const,
        };
        const bearerSpy = spyOn(oidcBearer, "authenticateBearer").mockResolvedValue({
          kind: "authenticated",
          session: bearerSession,
        });
        const allowsSpy = spyOn(localAccounts, "storedAccountAllows").mockResolvedValue(true);

        try {
          const reading = await readSession();
          expect(reading.kind).toBe("authenticated");
          if (reading.kind === "authenticated") {
            expect(reading.session).toEqual(bearerSession);
          }

          const session = await getSession();
          expect(session).toEqual(bearerSession);
        } finally {
          bearerSpy.mockRestore();
          allowsSpy.mockRestore();
        }
      });

      test("returns anonymous when bearer is authenticated but storedAccountAllows refuses", async () => {
        const bearerSession = {
          role: "user" as const,
          username: "user@example.com",
          idpSubject: "sub-456",
          idpIssuer: "https://idp.example.com",
          iat: 1000,
          exp: 2000,
          channel: "bearer" as const,
        };
        const bearerSpy = spyOn(oidcBearer, "authenticateBearer").mockResolvedValue({
          kind: "authenticated",
          session: bearerSession,
        });
        const allowsSpy = spyOn(localAccounts, "storedAccountAllows").mockResolvedValue(false);

        try {
          const reading = await readSession();
          expect(reading.kind).toBe("anonymous");

          const session = await getSession();
          expect(session).toBeNull();
        } finally {
          bearerSpy.mockRestore();
          allowsSpy.mockRestore();
        }
      });

      test("returns store_unavailable when bearer is authenticated and storedAccountAllows throws (#1942)", async () => {
        const bearerSession = {
          role: "admin" as const,
          username: "admin@example.com",
          idpSubject: "sub-123",
          idpIssuer: "https://idp.example.com",
          iat: 1000,
          exp: 2000,
          channel: "bearer" as const,
        };
        const bearerSpy = spyOn(oidcBearer, "authenticateBearer").mockResolvedValue({
          kind: "authenticated",
          session: bearerSession,
        });
        const errorSpy = spyOn(console, "error").mockImplementation(() => {});
        const allowsSpy = spyOn(localAccounts, "storedAccountAllows").mockRejectedValue(
          new Error("account postgres unreachable"),
        );

        try {
          const reading = await readSession();
          expect(reading.kind).toBe("store_unavailable");

          const session = await getSession();
          expect(session).toBeNull();
        } finally {
          bearerSpy.mockRestore();
          allowsSpy.mockRestore();
          errorSpy.mockRestore();
        }
      });
    });

    test("propagates headers() errors — readSession() is only called from route handlers", async () => {
      // The defensive try/catch around headers() was removed (reviewer item 2): every caller is
      // a route handler, and swallowing an out-of-scope failure silently as anonymous is wrong.
      // Route handlers can rely on Next.js's own error boundary instead.
      mockHeadersThrow = new Error("headers was called outside a request scope");
      try {
        await expect(readSession()).rejects.toThrow("headers was called outside a request scope");
      } finally {
        mockHeadersThrow = null;
      }
    });
  });

  // --------------------------------------------------------------------------
  // login()
  // --------------------------------------------------------------------------

  describe("login()", () => {
    describe("session lifetime", () => {
      const origTtl = process.env.AUTH_SESSION_TTL_SECONDS;

      afterEach(() => {
        if (origTtl === undefined) delete process.env.AUTH_SESSION_TTL_SECONDS;
        else process.env.AUTH_SESSION_TTL_SECONDS = origTtl;
      });

      async function issuedLifetime(): Promise<{ tokenSeconds: number; cookieMaxAge: unknown }> {
        await login("user", "user");
        const claims = jose.decodeJwt(mockSetCalls[0].value);
        return {
          tokenSeconds: (claims.exp as number) - (claims.iat as number),
          cookieMaxAge: (mockSetCalls[0].opts as { maxAge?: number }).maxAge,
        };
      }

      test("with AUTH_SESSION_TTL_SECONDS unset the token and the cookie still last 24 hours", async () => {
        delete process.env.AUTH_SESSION_TTL_SECONDS;
        expect(await issuedLifetime()).toEqual({ tokenSeconds: 86400, cookieMaxAge: 86400 });
      });

      test("AUTH_SESSION_TTL_SECONDS=28800 gives exp minus iat of 28800 and a cookie Max-Age of 28800", async () => {
        process.env.AUTH_SESSION_TTL_SECONDS = "28800";
        expect(await issuedLifetime()).toEqual({ tokenSeconds: 28800, cookieMaxAge: 28800 });
      });
    });

    test("sets auth-token cookie with admin role", async () => {
      await login("admin", "admin");
      expect(mockSetCalls.length).toBeGreaterThan(0);
      expect(mockSetCalls[0].name).toBe("auth-token");
      // Verify the token is valid
      const token = mockSetCalls[0].value;
      const payload = await verifyJWT(token);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe("admin");
    });

    test("sets auth-token cookie with user role", async () => {
      await login("user", "user");
      expect(mockSetCalls.length).toBeGreaterThan(0);
      const token = mockSetCalls[0].value;
      const payload = await verifyJWT(token);
      expect(payload!.role).toBe("user");
    });

    // Only the OIDC callback passes an identity (docs/GOVERNANCE.md#sign-in), so password, passkey and launch
    // sessions keep signing exactly the claims they signed before.
    test("login without an identity signs exactly role, username and sessionVersion", async () => {
      await login("user", "member@example.com", 4);
      const claims = jose.decodeJwt(mockSetCalls[0].value);
      expect(claims).toEqual({
        role: "user",
        username: "member@example.com",
        sessionVersion: 4,
        iat: expect.any(Number),
        exp: expect.any(Number),
      });
    });

    test("login with an identity signs its subject and issuer as idpSubject and idpIssuer", async () => {
      await login("admin", "ada@example.com", undefined, {
        subject: "4f6a2c1e-8b7d-4e3a-9c5f-1a2b3c4d5e6f",
        issuer: "https://sso.example.com/realms/libredb",
      });
      const claims = jose.decodeJwt(mockSetCalls[0].value);
      expect(claims).toEqual({
        role: "admin",
        username: "ada@example.com",
        idpSubject: "4f6a2c1e-8b7d-4e3a-9c5f-1a2b3c4d5e6f",
        idpIssuer: "https://sso.example.com/realms/libredb",
        iat: expect.any(Number),
        exp: expect.any(Number),
      });
    });

    test("login with non-empty claimRoles signs claimRoles into the session", async () => {
      await login(
        "user",
        "ada@example.com",
        undefined,
        {
          subject: "4f6a2c1e-8b7d-4e3a-9c5f-1a2b3c4d5e6f",
          issuer: "https://sso.example.com/realms/libredb",
        },
        ["team-billing", "team-dev"],
      );
      const claims = jose.decodeJwt(mockSetCalls[0].value) as { claimRoles?: string[] };
      expect(claims.claimRoles).toEqual(["team-billing", "team-dev"]);
    });

    test("login with empty claimRoles omits claimRoles from the session", async () => {
      await login(
        "user",
        "ada@example.com",
        undefined,
        {
          subject: "4f6a2c1e-8b7d-4e3a-9c5f-1a2b3c4d5e6f",
          issuer: "https://sso.example.com/realms/libredb",
        },
        [],
      );
      const claims = jose.decodeJwt(mockSetCalls[0].value) as { claimRoles?: string[] };
      expect(claims.claimRoles).toBeUndefined();
    });

    test("a session carrying the maximum 20 claim roles of 64 characters fits under 4096 bytes", async () => {
      const maxClaimRoles = Array.from(
        { length: 20 },
        (_, i) => "team-" + String(i).padStart(2, "0") + "-role-" + "x".repeat(51),
      );
      expect(maxClaimRoles).toHaveLength(20);
      expect(maxClaimRoles.every((r) => r.length === 64)).toBe(true);

      const token = await signJWT({
        role: "user",
        username: "user@example.com",
        idpSubject: "4f6a2c1e-8b7d-4e3a-9c5f-1a2b3c4d5e6f",
        idpIssuer: "https://sso.example.com/realms/libredb",
        claimRoles: maxClaimRoles,
      });

      // Browser cookies are limited to 4096 bytes total
      expect(token.length).toBeLessThan(4096);

      const verified = await verifyJWT(token);
      expect(verified?.claimRoles).toEqual(maxClaimRoles);
    });

    // The Secure flag is what makes a session survive - or not - in the desktop
    // shell (issue #232): libsoup, the cookie store behind WebKitGTK, drops a
    // Secure cookie delivered over http outright, so the loopback session the
    // desktop app hands off would be discarded on arrival.
    describe("Secure flag", () => {
      // NODE_ENV is typed read-only by the Next.js env declarations.
      const setNodeEnv = (value: string | undefined) => {
        if (value === undefined) delete (process.env as Record<string, string>).NODE_ENV;
        else (process.env as Record<string, string>).NODE_ENV = value;
      };

      const asProduction = async (host: string | undefined, extra: Record<string, string> = {}) => {
        const previous = process.env.NODE_ENV;
        setNodeEnv("production");
        if (host !== undefined) mockRequestHeaders.host = host;
        Object.assign(mockRequestHeaders, extra);
        try {
          await login("admin", "admin");
        } finally {
          setNodeEnv(previous);
        }
        return (mockSetCalls[0].opts as { secure: boolean }).secure;
      };

      test("is not set outside production", async () => {
        mockRequestHeaders.host = "studio.example.com";
        await login("admin", "admin");
        expect((mockSetCalls[0].opts as { secure: boolean }).secure).toBe(false);
      });

      test("is set for a public host in production", async () => {
        expect(await asProduction("studio.example.com")).toBe(true);
      });

      test("is set when the host header is missing", async () => {
        expect(await asProduction(undefined)).toBe(true);
      });

      test("is not set for a loopback host", async () => {
        expect(await asProduction("127.0.0.1:41234")).toBe(false);
        mockSetCalls = [];
        expect(await asProduction("localhost:3000")).toBe(false);
        mockSetCalls = [];
        expect(await asProduction("[::1]:3000")).toBe(false);
        mockSetCalls = [];
        expect(await asProduction("LOCALHOST")).toBe(false);
      });

      test("stays set when a proxy forwarded an https request to loopback", async () => {
        expect(await asProduction("localhost:3000", { "x-forwarded-proto": "https, http" })).toBe(true);
      });

      test("is not set when a proxy forwarded plain http to loopback", async () => {
        expect(await asProduction("localhost:3000", { "x-forwarded-proto": "http" })).toBe(false);
      });

      test("falls back to production defaults when headers are unavailable", async () => {
        const previous = process.env.NODE_ENV;
        setNodeEnv("production");
        mockHeadersThrow = new Error("headers() called outside a request scope");
        try {
          await login("admin", "admin");
        } finally {
          setNodeEnv(previous);
        }
        expect((mockSetCalls[0].opts as { secure: boolean }).secure).toBe(true);
      });

      // AUTH_COOKIE_SECURE is the escape hatch for a deployment that terminates
      // TLS upstream and forwards plain http to the app on a host that is not
      // loopback (umbrelOS: getumbrel/umbrel-apps#5847). The loopback exception
      // above cannot cover that - the browser reaches the app on umbrel.local -
      // so the operator has to declare it.
      describe("AUTH_COOKIE_SECURE override", () => {
        const setOverride = (value: string | undefined) => {
          if (value === undefined) delete process.env.AUTH_COOKIE_SECURE;
          else process.env.AUTH_COOKIE_SECURE = value;
        };

        afterEach(() => {
          setOverride(undefined);
          resetCookieSecurityWarning();
        });

        test("turns the flag off for a public host in production", async () => {
          setOverride("false");
          expect(await asProduction("studio.example.com")).toBe(false);
        });

        test("forces the flag on outside production", async () => {
          setOverride("true");
          mockRequestHeaders.host = "studio.example.com";
          await login("admin", "admin");
          expect((mockSetCalls[0].opts as { secure: boolean }).secure).toBe(true);
        });

        test("forces the flag on for loopback, overruling the desktop-shell exception", async () => {
          setOverride("true");
          expect(await asProduction("localhost:3000")).toBe(true);
        });

        // Same spellings AUTH_BOOTSTRAP accepts: a typo must never be the reason
        // an operator thinks they turned the flag off while it is still on.
        test("accepts the AUTH_BOOTSTRAP spellings, trimmed and case-insensitive", async () => {
          for (const off of ["false", "0", "off", " FALSE "]) {
            setOverride(off);
            mockSetCalls = [];
            expect(await asProduction("studio.example.com")).toBe(false);
          }
          for (const on of ["true", "1", "on", " TRUE "]) {
            setOverride(on);
            mockSetCalls = [];
            expect(await asProduction("127.0.0.1:41234")).toBe(true);
          }
        });

        test("warns and keeps the default when the value is unrecognized", async () => {
          const warn = spyOn(logger, "warn").mockImplementation(() => {});
          setOverride("yes-please");
          try {
            expect(await asProduction("studio.example.com")).toBe(true);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain("AUTH_COOKIE_SECURE");
          } finally {
            warn.mockRestore();
          }
        });

        test("treats a blank value as unset, without warning", async () => {
          const warn = spyOn(logger, "warn").mockImplementation(() => {});
          setOverride("   ");
          try {
            expect(await asProduction("studio.example.com")).toBe(true);
            expect(warn).not.toHaveBeenCalled();
          } finally {
            warn.mockRestore();
          }
        });

        // Relaxing the flag in production is a deliberate weakening of the
        // session cookie: it belongs in the log, once, not on every login.
        test("warns once when it disables the flag in production", async () => {
          const warn = spyOn(logger, "warn").mockImplementation(() => {});
          setOverride("false");
          try {
            await asProduction("studio.example.com");
            mockSetCalls = [];
            await asProduction("studio.example.com");
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain("AUTH_COOKIE_SECURE");
          } finally {
            warn.mockRestore();
          }
        });

        test("stays quiet when it disables the flag outside production", async () => {
          const warn = spyOn(logger, "warn").mockImplementation(() => {});
          setOverride("false");
          try {
            await login("admin", "admin");
            expect((mockSetCalls[0].opts as { secure: boolean }).secure).toBe(false);
            expect(warn).not.toHaveBeenCalled();
          } finally {
            warn.mockRestore();
          }
        });
      });
    });
  });

  // --------------------------------------------------------------------------
  // logout()
  // --------------------------------------------------------------------------

  describe("logout()", () => {
    test("deletes auth-token cookie", async () => {
      await logout();
      expect(mockDeleteCalls).toContainEqual({ name: "auth-token", path: "/" });
    });
  });
  test("session creation and deletion use the same nested cookie path", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      mockSetCalls = [];
      mockDeleteCalls = [];
      await login("user", "prefix-user");
      expect(mockSetCalls[0].opts).toMatchObject({ path: "/tools/libredb", httpOnly: true, sameSite: "lax" });
      await logout();
      expect(mockDeleteCalls).toContainEqual({ name: "auth-token", path: "/tools/libredb" });
    });
  });
});

// Exported for GET /api/admin/discovery, which reports an operator's AUTH_COOKIE_SECURE=false as a
// display warning, and for src/lib/api/request-scheme.ts. These cases call each one directly.
describe("readCookieSecureOverride()", () => {
  beforeEach(() => {
    delete process.env.AUTH_COOKIE_SECURE;
    resetCookieSecurityWarning();
  });

  afterEach(() => {
    delete process.env.AUTH_COOKIE_SECURE;
    resetCookieSecurityWarning();
  });

  test("answers false for every off spelling, trimmed and case-insensitive", () => {
    for (const off of ["false", "0", "off", " FALSE "]) {
      process.env.AUTH_COOKIE_SECURE = off;
      expect(readCookieSecureOverride()).toBe(false);
    }
  });

  test("answers true for every on spelling, trimmed and case-insensitive", () => {
    for (const on of ["true", "1", "on", " TRUE "]) {
      process.env.AUTH_COOKIE_SECURE = on;
      expect(readCookieSecureOverride()).toBe(true);
    }
  });

  test("answers undefined when the variable is unset or blank", () => {
    expect(readCookieSecureOverride()).toBeUndefined();
    process.env.AUTH_COOKIE_SECURE = "   ";
    expect(readCookieSecureOverride()).toBeUndefined();
  });

  test("answers undefined and warns once for an unrecognized value", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    process.env.AUTH_COOKIE_SECURE = "yes-please";
    try {
      expect(readCookieSecureOverride()).toBeUndefined();
      expect(readCookieSecureOverride()).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("AUTH_COOKIE_SECURE");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("isLoopbackHost()", () => {
  test("accepts the loopback names with or without a port, in any letter case", () => {
    for (const host of [
      "localhost",
      "localhost:3000",
      "LOCALHOST:3000",
      "127.0.0.1",
      "127.0.0.1:41234",
      "[::1]",
      "[::1]:3000",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("refuses a missing host, an empty host and every other name", () => {
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
    for (const host of [
      "studio.example.com",
      "studio.example.com:443",
      "localhost.example.com",
      "127.0.0.2",
      "10.0.0.5:3000",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
