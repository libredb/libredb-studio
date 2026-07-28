import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import * as jose from "jose";
import { logger } from "@/lib/logger";

// ============================================================================
// Mock State — only mock next/headers (cookies), NOT jose
// jose is used for real JWT sign/verify with JWT_SECRET from setup.ts
// ============================================================================

let mockCookieStore: Record<string, { value: string } | undefined> = {};
let mockSetCalls: Array<{ name: string; value: string; opts: unknown }> = [];
let mockDeleteCalls: string[] = [];

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
    delete: (name: string) => {
      mockDeleteCalls.push(name);
      delete mockCookieStore[name];
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

const { signJWT, verifyJWT, getSession, login, logout, resetCookieSecurityWarning } = await import("@/lib/auth");

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
  // getSession()
  // --------------------------------------------------------------------------

  describe("getSession()", () => {
    test("returns payload when auth-token cookie exists", async () => {
      const token = await signJWT({ role: "user", username: "user" });
      mockCookieStore["auth-token"] = { value: token };

      const session = await getSession();
      expect(session).not.toBeNull();
      expect(session!.role).toBe("user");
      expect(session!.username).toBe("user");
    });

    test("returns null when no cookie", async () => {
      const session = await getSession();
      expect(session).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // login()
  // --------------------------------------------------------------------------

  describe("login()", () => {
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
      expect(mockDeleteCalls).toContain("auth-token");
    });
  });
});
