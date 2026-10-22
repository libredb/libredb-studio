/**
 * src/proxy.ts with the OIDC bearer channel (src/lib/oidc-bearer.ts). On an API path that needs a session a Bearer
 * header decides alone while the channel is on; a page never takes one; and with the channel off the header is ignored,
 * so a reverse proxy that forwards `Authorization: Basic` (CapRover httpAuth) or a bearer of its own changes nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { proxy } from "@/proxy";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetBearerKeys } from "@/lib/oidc-bearer";
import {
  bearerClaims,
  nowSeconds,
  provider,
  restoreBearerEnv,
  signBearer,
  stubIdentityProvider,
  useBearerEnv,
} from "../helpers/oidc-bearer-provider";

const JWT_SECRET = new TextEncoder().encode("test-jwt-secret-for-unit-tests-32ch");

async function cookieToken(username = "cookie@example.test") {
  return await new SignJWT({ role: "user", username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

function request(pathname: string, init: { authorization?: string; cookie?: string; owner?: string } = {}) {
  const headers = new Headers();
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.cookie) headers.set("cookie", `auth-token=${init.cookie}`);
  if (init.owner) headers.set("x-libredb-workspace-owner", encodeURIComponent(init.owner));
  return new NextRequest(`http://localhost:3000${pathname}`, { headers });
}

/** A native client's POST: a bearer, a JSON body and no Origin header, as a phone sends it (src/lib/api/origin-check.ts). */
function postRequest(pathname: string, authorization: string) {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: "{}",
  });
}

const passedThrough = (response: Response) => response.status === 200 && response.headers.get("location") === null;

const fetchSpy = stubIdentityProvider();
afterAll(() => fetchSpy.mockRestore());

beforeEach(() => {
  useBearerEnv();
  resetBearerKeys();
  clearRateLimitState();
});

afterEach(restoreBearerEnv);

describe("proxy with the bearer channel on", () => {
  test("a valid access token reaches an API route without a cookie", async () => {
    const response = await proxy(request("/api/db/query", { authorization: `Bearer ${await signBearer()}` }));

    expect(passedThrough(response)).toBe(true);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a refused token answers 401 with the bearer challenge, even next to a valid cookie, and is audited", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const expired = await signBearer(bearerClaims({ exp: nowSeconds() - 120 }));
      const response = await proxy(
        request("/api/db/query", { authorization: `Bearer ${expired}`, cookie: await cookieToken() }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({ error: "Invalid access token", code: "AUTH_REQUIRED" });
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('"reason":"bearer_token_invalid"'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a broken audit sink still answers the 401 rather than failing the request", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await proxy(request("/api/db/query", { authorization: "Bearer not-a-jwt" }));

      expect(response.status).toBe(401);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain("Failed to record a bearer refusal audit event");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("an account without a role answers 403 BEARER_NO_ROLE, so a client does not refresh, and is audited", async () => {
    process.env.OIDC_USER_ROLES = "user";
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const guest = await signBearer(bearerClaims({ realm_access: { roles: ["guest"] } }));
      const response = await proxy(request("/api/db/query", { authorization: `Bearer ${guest}` }));

      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(await response.json()).toEqual({
        error: "This account has no role in Studio. Ask an administrator for access.",
        code: "BEARER_NO_ROLE",
      });
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('"reason":"bearer_no_role"'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a token that names no usable user answers 403 BEARER_NO_IDENTITY and is audited", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const nameless = await signBearer(bearerClaims({ email: undefined, preferred_username: "ada@example.test" }));
      const response = await proxy(request("/api/db/query", { authorization: `Bearer ${nameless}` }));

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error:
          "The access token carries no user name Studio can use. Ask an administrator to check the account's email and username.",
        code: "BEARER_NO_IDENTITY",
      });
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('"reason":"bearer_no_identity"'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a provider that cannot be reached answers 503, not 401, and writes no permission_denied line", async () => {
    provider.down = true;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await proxy(request("/api/db/query", { authorization: `Bearer ${await signBearer()}` }));

      expect(response.status).toBe(503);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(await response.json()).toEqual({
        error: "The identity provider could not be reached to verify the access token. Try again.",
        code: "IDENTITY_PROVIDER_UNAVAILABLE",
      });
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes("permission_denied"))).toBe(false);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("a page never takes a bearer: without a cookie it goes to sign in", async () => {
    const response = await proxy(request("/", { authorization: `Bearer ${await signBearer()}` }));

    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });

  test("a page with a valid cookie loads whatever the bearer says", async () => {
    const response = await proxy(request("/", { authorization: "Bearer not-a-jwt", cookie: await cookieToken() }));

    expect(passedThrough(response)).toBe(true);
  });

  test("a Basic header is ignored, so the cookie decides", async () => {
    const response = await proxy(
      request("/api/db/query", { authorization: "Basic dXNlcjpwYXNz", cookie: await cookieToken() }),
    );

    expect(passedThrough(response)).toBe(true);
  });

  test("the public sign-in routes never read the header, so an expired bearer can sign in again", async () => {
    const expired = await signBearer(bearerClaims({ exp: nowSeconds() - 120 }));
    const responses = await Promise.all(
      ["/api/auth/login", "/api/auth/oidc/login", "/api/auth/launch", "/api/health", "/api/ready"].map((pathname) =>
        proxy(request(pathname, { authorization: `Bearer ${expired}` })),
      ),
    );

    expect(responses.map(passedThrough)).toEqual([true, true, true, true, true]);
  });

  test("the public routes that read a session decide a refused token here: 401 with the challenge", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const expired = await signBearer(bearerClaims({ exp: nowSeconds() - 120 }));
      const responses = await Promise.all(
        [
          request("/api/auth/me", { authorization: `Bearer ${expired}` }),
          postRequest("/api/auth/logout", `Bearer ${expired}`),
          postRequest("/api/db/health", `Bearer ${expired}`),
        ].map((req) => proxy(req)),
      );

      expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
      expect(responses.map((response) => response.headers.get("www-authenticate"))).toEqual(
        Array(3).fill('Bearer error="invalid_token"'),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("the public routes that read a session answer 503 when the provider cannot be reached", async () => {
    provider.down = true;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const token = await signBearer();
      const me = await proxy(request("/api/auth/me", { authorization: `Bearer ${token}` }));
      const health = await proxy(postRequest("/api/db/health", `Bearer ${token}`));

      expect([me.status, health.status]).toEqual([503, 503]);
      expect((await me.json()).code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("the public routes that read a session let a valid token through to the route", async () => {
    const token = await signBearer();
    const me = await proxy(request("/api/auth/me", { authorization: `Bearer ${token}` }));
    const logout = await proxy(postRequest("/api/auth/logout", `Bearer ${token}`));

    expect([passedThrough(me), passedThrough(logout)]).toEqual([true, true]);
  });

  test("the liveness GET of /api/db/health never reads the header", async () => {
    provider.down = true;
    const response = await proxy(request("/api/db/health", { authorization: `Bearer ${await signBearer()}` }));

    expect(passedThrough(response)).toBe(true);
    expect(provider.discoveryCalls).toBe(0);
  });

  test("the workspace owner header is checked against the access token's user", async () => {
    const token = await signBearer();
    const mine = await proxy(request("/api/db/query", { authorization: `Bearer ${token}`, owner: "ada@example.test" }));
    const theirs = await proxy(
      request("/api/db/query", { authorization: `Bearer ${token}`, owner: "bob@example.test" }),
    );

    expect(passedThrough(mine)).toBe(true);
    expect(theirs.status).toBe(409);
  });
});

describe("proxy with the bearer channel off", () => {
  beforeEach(() => {
    delete process.env.OIDC_BEARER_AUDIENCE;
  });

  test("a bearer alone is no session, answered as before", async () => {
    const response = await proxy(request("/api/db/query", { authorization: `Bearer ${await signBearer()}` }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
    expect(provider.discoveryCalls).toBe(0);
  });

  test("a cookie request carrying any Authorization header works as before", async () => {
    const cookie = await cookieToken();
    const responses = await Promise.all(
      ["Basic dXNlcjpwYXNz", "Bearer a-token-some-proxy-forwarded"].map((authorization) =>
        proxy(request("/api/db/query", { authorization, cookie })),
      ),
    );
    expect(responses.map(passedThrough)).toEqual([true, true]);
  });
});
