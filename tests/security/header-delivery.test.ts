import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { proxy } from "@/proxy";

/**
 * Threat: a response path that escapes the headers. proxy() has nine return statements; a new
 * branch that forgets withSecurityHeaders() ships a document with no CSP and no clickjacking
 * defence, and nothing else in the suite would notice. Eight of the nine are driven here; the
 * ninth - the Origin-mismatch 403 - is driven in csrf-origin.test.ts:86 ("still carries the
 * security headers, so the 403 is not a hole of its own"), since that branch's own threat model
 * belongs with the rest of the Origin-check suite.
 */

const JWT_SECRET = new TextEncoder().encode("test-jwt-secret-for-unit-tests-32ch");

async function createToken(role: string): Promise<string> {
  return await new SignJWT({ role, username: role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

function request(pathname: string, token?: string): NextRequest {
  const headers = new Headers();
  if (token) headers.set("cookie", `auth-token=${token}`);
  return new NextRequest(`http://localhost:3000${pathname}`, { headers });
}

function expectHardened(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("same-origin");
  expect(response.headers.get("strict-transport-security")).toBe("max-age=15552000");
  expect(response.headers.get("permissions-policy")).toContain("camera=()");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("content-security-policy-report-only")).toBeNull();
}

describe("every response the proxy returns carries the security headers", () => {
  test("the login page for an anonymous visitor", async () => {
    expectHardened(await proxy(request("/login")));
  });

  test("the login page for a visitor whose token does not verify", async () => {
    expectHardened(await proxy(request("/login", "invalid-token-garbage")));
  });

  test("the redirect that sends an authenticated admin away from the login page", async () => {
    expectHardened(await proxy(request("/login", await createToken("admin"))));
  });

  test("a public API path", async () => {
    expectHardened(await proxy(request("/api/auth/login")));
  });

  test("the redirect that sends an anonymous visitor to the login page", async () => {
    expectHardened(await proxy(request("/")));
  });

  test("an authenticated document request", async () => {
    expectHardened(await proxy(request("/", await createToken("user"))));
  });

  test("the RBAC redirect that keeps a user out of /admin", async () => {
    expectHardened(await proxy(request("/admin", await createToken("user"))));
  });

  test("the redirect that follows a failed JWT verification", async () => {
    expectHardened(await proxy(request("/", "expired-or-invalid-token")));
  });
});

describe("the matcher", () => {
  test("no longer excludes /api/auth, so login and logout responses are hardened too", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { config } = require("@/proxy") as { config: { matcher: string[] } };

    expect(config.matcher[0]).not.toContain("api/auth");
    expect(config.matcher[0]).toContain("api/storage/config");
  });

  test("no longer excludes /api/db/health, so its state-changing POST is Origin-checked too", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { config } = require("@/proxy") as { config: { matcher: string[] } };

    // Pinned by csrf-origin.test.ts's "is refused on POST /api/db/health" - excluding the path
    // here would silently take that test's protection away again, the same class of gap this
    // assertion exists to catch.
    expect(config.matcher[0]).not.toContain("api/db/health");
  });
});
