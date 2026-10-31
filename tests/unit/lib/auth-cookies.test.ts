/**
 * src/lib/auth-cookies.ts: the one decision behind the Secure flag, and the name and path every Studio cookie takes
 * from it. Whenever a cookie is Secure its name carries the __Host- prefix, so a browser holds it host-only, at Path=/
 * and without a Domain; with the flag off the name and path are today's.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { NextResponse } from "next/server";
import { withBasePathEnv } from "../../helpers/base-path";
import { logger } from "@/lib/logger";
import {
  HOST_COOKIE_PREFIX,
  SESSION_COOKIE,
  basePathSuffix,
  cookieDeletion,
  cookieScope,
  resetCookieSecurityWarning,
  secureCookieDecision,
} from "@/lib/auth-cookies";

// NODE_ENV is typed read-only by the Next.js env declarations.
function setNodeEnv(value: string | undefined): void {
  if (value === undefined) delete (process.env as Record<string, string>).NODE_ENV;
  else (process.env as Record<string, string>).NODE_ENV = value;
}

const PREVIOUS_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  setNodeEnv(PREVIOUS_NODE_ENV);
  delete process.env.AUTH_COOKIE_SECURE;
  resetCookieSecurityWarning();
});

const view = (host: string | null, forwardedProto: string | null = null) => ({ host, forwardedProto });

describe("secureCookieDecision()", () => {
  test("is off outside production, whatever the request", () => {
    expect(secureCookieDecision(view("studio.example.com"))).toBe(false);
    expect(secureCookieDecision(undefined)).toBe(false);
  });

  test("is on in production for a public host, a missing host and no request scope", () => {
    setNodeEnv("production");
    expect(secureCookieDecision(view("studio.example.com"))).toBe(true);
    expect(secureCookieDecision(view(null))).toBe(true);
    expect(secureCookieDecision(undefined)).toBe(true);
  });

  test("is off in production for loopback over plain http, on when a proxy forwarded https", () => {
    setNodeEnv("production");
    for (const host of ["localhost:3000", "127.0.0.1:41234", "[::1]:3000", "LOCALHOST"]) {
      expect(secureCookieDecision(view(host))).toBe(false);
    }
    expect(secureCookieDecision(view("localhost:3000", "http"))).toBe(false);
    expect(secureCookieDecision(view("localhost:3000", "HTTPS, http"))).toBe(true);
  });

  test("AUTH_COOKIE_SECURE decides whenever it is set", () => {
    process.env.AUTH_COOKIE_SECURE = "true";
    expect(secureCookieDecision(view("localhost:3000"))).toBe(true);
    setNodeEnv("production");
    process.env.AUTH_COOKIE_SECURE = "false";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(secureCookieDecision(view("studio.example.com"))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("an unrecognised AUTH_COOKIE_SECURE keeps the default", () => {
    setNodeEnv("production");
    process.env.AUTH_COOKIE_SECURE = "yes-please";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(secureCookieDecision(view("studio.example.com"))).toBe(true);
      expect(warn.mock.calls[0][0]).toContain("AUTH_COOKIE_SECURE");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("cookieScope()", () => {
  test("plain mode keeps the base name and the plain path, byte for byte", () => {
    expect(cookieScope(SESSION_COOKIE, "/", false)).toEqual({ name: "auth-token", path: "/", secure: false });
    expect(cookieScope("passkey-sign-in", "/api/auth/passkey", false)).toEqual({
      name: "passkey-sign-in",
      path: "/api/auth/passkey",
      secure: false,
    });
  });

  test("Secure mode gives the __Host- name at Path=/", () => {
    expect(HOST_COOKIE_PREFIX).toBe("__Host-");
    expect(cookieScope(SESSION_COOKIE, "/", true)).toEqual({ name: "__Host-auth-token", path: "/", secure: true });
    expect(cookieScope("oidc-logout-hint", "/api/auth/logout", true)).toEqual({
      name: "__Host-oidc-logout-hint",
      path: "/",
      secure: true,
    });
  });

  test("under a base path the Secure name carries its segments and the plain scope keeps its path", async () => {
    await withBasePathEnv("/tools/libredb", () => {
      expect(basePathSuffix()).toBe(".tools.libredb");
      expect(cookieScope(SESSION_COOKIE, "/tools/libredb", true)).toEqual({
        name: "__Host-auth-token.tools.libredb",
        path: "/",
        secure: true,
      });
      expect(cookieScope(SESSION_COOKIE, "/tools/libredb", false)).toEqual({
        name: "auth-token",
        path: "/tools/libredb",
        secure: false,
      });
    });
  });

  test("no base path, or a lone slash, adds no suffix", async () => {
    expect(basePathSuffix()).toBe("");
    await withBasePathEnv("/", () => expect(basePathSuffix()).toBe(""));
  });
});

describe("cookieDeletion()", () => {
  test("plain mode names the cookie and its path, exactly as the deletes always did", () => {
    expect(cookieDeletion(cookieScope(SESSION_COOKIE, "/tools/libredb", false))).toEqual({
      name: "auth-token",
      path: "/tools/libredb",
    });
  });

  test("Secure mode carries Secure, without which a browser ignores the delete of a __Host- cookie", () => {
    expect(cookieDeletion(cookieScope(SESSION_COOKIE, "/", true))).toEqual({
      name: "__Host-auth-token",
      path: "/",
      secure: true,
    });
  });
});

// Every cookie Studio sets, with the plain path it has today. The serializer is Next's own, so these lines are the
// Set-Cookie headers a browser receives.
const STUDIO_COOKIES: ReadonlyArray<readonly [string, string]> = [
  ["auth-token", "/"],
  ["oidc-state", "/"],
  ["oidc-logout-hint", "/api/auth/logout"],
  ["openshift-state", "/api/auth/openshift"],
  ["access-review-retry", "/"],
  ["passkey-sign-in", "/api/auth/passkey"],
  ["passkey-registration", "/api/auth/passkey"],
];

function setCookieLines(scope: ReturnType<typeof cookieScope>): string[] {
  const response = new NextResponse(null);
  response.cookies.set(scope.name, "value", {
    httpOnly: true,
    secure: scope.secure,
    sameSite: "lax",
    path: scope.path,
  });
  const set = response.headers.getSetCookie();
  const removal = new NextResponse(null);
  removal.cookies.delete(cookieDeletion(scope));
  return [...set, ...removal.headers.getSetCookie()];
}

describe("Set-Cookie through Next's serializer", () => {
  for (const [name, plainPath] of STUDIO_COOKIES) {
    test(`${name}: setting and deleting meet the __Host- rules in Secure mode`, async () => {
      const check = (suffix: string) => {
        const lines = setCookieLines(cookieScope(name, plainPath, true));
        expect(lines).toHaveLength(2);
        for (const line of lines) {
          expect(line.startsWith(`__Host-${name}${suffix}=`)).toBe(true);
          expect(line).toContain("; Secure");
          expect(line).toContain("Path=/;");
          expect(line).not.toMatch(/Path=\/[^;]/);
          expect(line.toLowerCase()).not.toContain("domain=");
        }
      };
      check("");
      await withBasePathEnv("/tools/libredb", () => check(".tools.libredb"));
    });
  }

  test("plain mode serializes today's name and path, without Secure", () => {
    const [set, removal] = setCookieLines(cookieScope("oidc-logout-hint", "/api/auth/logout", false));
    expect(set.startsWith("oidc-logout-hint=value")).toBe(true);
    expect(set).toContain("Path=/api/auth/logout");
    expect(set).not.toContain("Secure");
    expect(removal.startsWith("oidc-logout-hint=;")).toBe(true);
    expect(removal).not.toContain("Secure");
  });
});
