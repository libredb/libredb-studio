import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { resetOriginCheckWarnings } from "@/lib/api/origin-check";
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

const MUTATED = ["ALLOWED_ORIGINS", "TRUST_PROXY_HEADERS"] as const;
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
  delete process.env.TRUST_PROXY_HEADERS;
  clearRateLimitState();
  resetOriginCheckWarnings();
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

  test("is refused on POST /api/db/health, which the middleware matcher used to exclude entirely", async () => {
    // src/app/api/db/health/route.ts's POST handler is session-gated and provider-reaching
    // ("detailed health check" for a specific connection) - Phase 1's first cut excluded the whole
    // /api/db/health path from proxy()'s matcher for GET's sake (a load-balancer probe with no
    // upside to added latency) and, as a side effect, took this state-changing POST out of the
    // Origin check along with every other proxy() protection. GET's own exemption from checkOrigin
    // (by method, see origin-check.ts) means closing that gap costs the probe nothing.
    const res = await proxy(post("/api/db/health", { origin: "https://evil.example" }));

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

    expect(res.status).toBe(403);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("bounds an oversized Origin header in the rejection warn log", async () => {
    // observedOrigin comes straight from the request's own Origin/Referer header and is
    // attacker-controlled on every rejected request; it must be bounded the same as the audit
    // target beside it (MAX_AUDIT_FIELD_LENGTH), not written to stdout unbounded.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hugeOrigin = `https://${"x".repeat(50_000)}.example`;
      const res = await proxy(post("/api/db/query", { origin: hugeOrigin }));

      expect(res.status).toBe(403);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = warnSpy.mock.calls[0][0] as string;
      expect(line.length).toBeLessThan(400);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("still returns 403 when the origin_mismatch audit emit throws", async () => {
    // Isolated in its own try/catch: the 403 is unconditional and already decided regardless of
    // whether the audit line can be written.
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const res = await proxy(post("/api/db/query", { origin: "https://evil.example" }));

      expect(res.status).toBe(403);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("is still refused when it declares a form content type instead of JSON", async () => {
    // Proves the JSON carve-out is narrow: an HTML <form> can send this content type (unlike
    // application/json), and it must still be refused when it carries no Origin or Referer.
    const res = await proxy(post("/api/db/query", { "content-type": "application/x-www-form-urlencoded" }));

    expect(res.status).toBe(403);
  });

  test("is refused when a spoofed x-forwarded-host is not trusted because TRUST_PROXY_HEADERS=false", async () => {
    process.env.TRUST_PROXY_HEADERS = "false";
    const res = await proxy(
      post("/api/auth/login", {
        host: "libredb-studio.default.svc.cluster.local:3000",
        "x-forwarded-host": "db.example.com",
        origin: "https://db.example.com",
      }),
    );

    expect(res.status).toBe(403);
  });

  test("is refused despite a literal wildcard in ALLOWED_ORIGINS, which is ignored rather than trusted", async () => {
    process.env.ALLOWED_ORIGINS = "*";
    const res = await proxy(post("/api/auth/login", { origin: "https://evil.example" }));

    expect(res.status).toBe(403);
  });

  test("keeps returning 403 after the anon rate-limit logging budget is exhausted", async () => {
    // The default anon bucket allows 5 before it trips. Firing well past that proves the 403 does
    // not depend on the limiter's notice at all - the `return` in proxy() sits outside the
    // `if (notice.allowed || notice.tripped)` block, and this is the state (budget exhausted,
    // notice.allowed=false, notice.tripped=false, so that whole condition is false) where a
    // regression that moved the return inside that block would silently start letting requests
    // through instead of rejecting them.
    for (let i = 0; i < 8; i++) {
      const res = await proxy(post("/api/db/query", { origin: "https://evil.example" }));
      expect(res.status).toBe(403);
    }
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

  test("the project's own documented API examples: JSON with neither Origin nor Referer", async () => {
    // Matches scripts/engine-smoke.sh, docs/RANCHER.md and docs/API_DOCS.md verbatim: every
    // published curl example sends Content-Type: application/json and neither Origin nor Referer.
    const res = await proxy(post("/api/auth/login", { "content-type": "application/json" }));

    expect(res.status).not.toBe(403);
  });

  test("a JSON content type with a charset parameter, parsed rather than compared verbatim", async () => {
    const res = await proxy(post("/api/db/query", { "content-type": "APPLICATION/JSON; charset=UTF-8" }));

    expect(res.status).not.toBe(403);
  });
});
