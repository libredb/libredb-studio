import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { proxy } from "@/proxy";

/**
 * Threat: a cross-site page performing a state-changing action with the victim's cookie.
 *
 * sameSite=lax already withholds the cookie on a cross-site POST, so for /api/db/query this is a
 * second layer. For POST /api/auth/login it is the ONLY layer: a forced-login or brute-force
 * request through a victim's browser carries no pre-existing cookie for lax to withhold.
 *
 * The comparison is HOST-ONLY, scheme ignored, deliberately: a TLS-terminating proxy that forwards
 * plain HTTP without setting x-forwarded-proto makes the browser send Origin: https://host while
 * the app computes http://host, and comparing schemes there locks the operator out of their own
 * login form. What is given up is an http:// page on the same host posting to the https:// app,
 * which requires an active network attacker who has already broken transport.
 */

const MUTATED = ["ALLOWED_ORIGINS"] as const;
const snapshot: Record<string, string | undefined> = {};

function post(pathname: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    method: "POST",
    headers: new Headers({ host: "localhost:3000", ...headers }),
  });
}

beforeEach(() => {
  for (const key of MUTATED) snapshot[key] = process.env[key];
  delete process.env.ALLOWED_ORIGINS;
  clearRateLimitState();
});

afterEach(() => {
  clearRateLimitState();
  for (const key of MUTATED) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("a cross-site state-changing request", () => {
  test("is refused on the query route, the primary target", async () => {
    const res = await proxy(post("/api/db/query", { origin: "https://evil.example" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        "Request origin is not allowed for this deployment. If Studio sits behind a reverse proxy, set ALLOWED_ORIGINS to its public origin.",
      code: "ORIGIN_MISMATCH",
      statusCode: 403,
      retryable: false,
    });
  });

  test("is refused on the login route, where sameSite provides nothing", async () => {
    const res = await proxy(post("/api/auth/login", { origin: "https://evil.example" }));

    expect(res.status).toBe(403);
  });

  test("is refused on the logout route, so a forced logout is not free", async () => {
    const res = await proxy(post("/api/auth/logout", { origin: "https://evil.example" }));

    expect(res.status).toBe(403);
  });

  test("is refused when it carries neither an Origin nor a Referer", async () => {
    const res = await proxy(post("/api/db/query"));

    expect(res.status).toBe(403);
  });

  test("is refused when the Referer is the only signal and it is foreign", async () => {
    const res = await proxy(post("/api/db/query", { referer: "https://evil.example/page" }));

    expect(res.status).toBe(403);
  });

  test("still carries the security headers, so the 403 is not a hole of its own", async () => {
    const res = await proxy(post("/api/db/query", { origin: "https://evil.example" }));

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("a legitimate same-origin request", () => {
  test("is allowed when the Origin matches the host", async () => {
    const res = await proxy(post("/api/auth/login", { origin: "http://localhost:3000" }));

    expect(res.status).not.toBe(403);
  });

  test("is allowed on a scheme mismatch, the TLS-terminating-proxy case", async () => {
    const res = await proxy(post("/api/auth/login", { origin: "https://localhost:3000" }));

    expect(res.status).not.toBe(403);
  });

  test("is allowed when only the same-origin Referer survives", async () => {
    const res = await proxy(post("/api/auth/login", { referer: "http://localhost:3000/login" }));

    expect(res.status).not.toBe(403);
  });

  test("is allowed behind a proxy that rewrote Host but set x-forwarded-host", async () => {
    const res = await proxy(
      post("/api/auth/login", {
        host: "libredb-studio.default.svc.cluster.local:3000",
        "x-forwarded-host": "db.example.com",
        origin: "https://db.example.com",
      }),
    );

    expect(res.status).not.toBe(403);
  });

  test("is allowed behind a proxy the operator named in ALLOWED_ORIGINS", async () => {
    process.env.ALLOWED_ORIGINS = "https://db.example.com, studio.internal:8443";
    const res = await proxy(
      post("/api/auth/login", {
        host: "libredb-studio.default.svc.cluster.local:3000",
        origin: "https://db.example.com",
      }),
    );

    expect(res.status).not.toBe(403);
  });

  test("accepts a bare host in ALLOWED_ORIGINS, not only a full origin", async () => {
    process.env.ALLOWED_ORIGINS = "studio.internal:8443";
    const res = await proxy(post("/api/auth/login", { host: "internal:3000", origin: "https://studio.internal:8443" }));

    expect(res.status).not.toBe(403);
  });
});

describe("requests the check must not break", () => {
  test("the OIDC callback, a legitimate cross-origin top-level navigation from the IdP", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/oidc/callback?code=abc", {
      headers: new Headers({ host: "localhost:3000", origin: "https://idp.example.com" }),
    });

    expect((await proxy(req)).status).not.toBe(403);
  });

  test("an ordinary document GET carrying no Origin at all", async () => {
    const req = new NextRequest("http://localhost:3000/login", {
      headers: new Headers({ host: "localhost:3000" }),
    });

    expect((await proxy(req)).status).not.toBe(403);
  });

  test("the desktop shell handoff, a same-origin fetch from the loopback webview", async () => {
    const req = new NextRequest("http://127.0.0.1:4173/api/auth/login", {
      method: "POST",
      headers: new Headers({ host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173" }),
    });

    expect((await proxy(req)).status).not.toBe(403);
  });

  test("a malformed Origin that names no host is refused rather than matching by accident", async () => {
    const res = await proxy(post("/api/db/query", { origin: "/" }));

    expect(res.status).toBe(403);
  });
});
