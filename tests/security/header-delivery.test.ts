import { describe, expect, test } from "bun:test";
import type { NextConfig } from "next";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import nextConfig from "../../next.config";
import { securityHeaders } from "@/lib/security/headers";
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
  expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
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

/**
 * AU2: the matcher above skips every path containing a dot, plus `_next/static` and `_next/image`.
 * That is correct for AUTH - nothing under `public/` needs a login redirect - but header delivery
 * and auth redirection are two concerns sharing one matcher, so the assets need a SECOND delivery
 * path. next.config.ts's `headers()` is it.
 *
 * Threat: a `.js` or `.css` served from this origin with no `X-Content-Type-Options`, so a
 * response whose declared type is wrong or generic can be sniffed into a script; and the `.svg`
 * files under `public/`, which are document contexts (not images) when reached by top-level
 * navigation or `<object>`, with no framing defence.
 */

/** A path the proxy matcher skips, one per exclusion class named in AU2. */
const SKIPPED_PATHS = ["/logo.svg", "/monaco/vs/loader.js", "/_next/static/chunks/main-abc123.js"];

/**
 * The `:param*` wildcard form is the only path-to-regexp construct these rules use (it is the
 * documented "every route" pattern). Anything else in a `source` escapes wrong here and fails the
 * assertions loudly rather than passing vacuously, which is the intent.
 */
function sourceMatcher(source: string): RegExp {
  return new RegExp(`^${source.replace(/:[A-Za-z]+\*/g, ".*")}$`);
}

type HeaderRule = Awaited<ReturnType<NonNullable<NextConfig["headers"]>>>[number];

async function configHeaderRules(): Promise<HeaderRule[]> {
  return await (nextConfig.headers as NonNullable<NextConfig["headers"]>)();
}

/** Every header name/value pair next.config delivers to `pathname`, last rule winning. */
function headersFor(rules: HeaderRule[], pathname: string): Record<string, string> {
  const delivered: Record<string, string> = {};
  for (const rule of rules) {
    if (!sourceMatcher(rule.source).test(pathname)) continue;
    for (const { key, value } of rule.headers) delivered[key] = value;
  }
  return delivered;
}

describe("the paths the proxy matcher skips are covered by a second delivery path", () => {
  test("the matcher really does skip them, so a second path is necessary and not redundant", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { config } = require("@/proxy") as { config: { matcher: string[] } };
    const matched = new RegExp(`^${config.matcher[0]}$`);

    for (const pathname of SKIPPED_PATHS) {
      expect({ pathname, matched: matched.test(pathname) }).toEqual({ pathname, matched: false });
    }
  });

  test("next.config delivers nosniff and the framing denial to each of them", async () => {
    const rules = await configHeaderRules();

    for (const pathname of SKIPPED_PATHS) {
      const delivered = headersFor(rules, pathname);

      expect({ pathname, delivered }).toEqual({
        pathname,
        delivered: { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" },
      });
    }
  });

  test("the values are read from securityHeaders(), not spelled a second time", async () => {
    // The whole value of one source of truth: this goes red the moment next.config carries its own
    // literal for a header whose value src/lib/security/headers.ts has changed.
    const authority = securityHeaders();
    const delivered = headersFor(await configHeaderRules(), "/logo.svg");

    for (const [name, value] of Object.entries(delivered)) {
      expect({ name, value }).toEqual({ name, value: authority[name] });
    }
    expect(Object.keys(delivered).length).toBeGreaterThan(0);
  });

  test("both chosen headers are option-independent, which is why the baked copy cannot drift", () => {
    // next.config's headers() is evaluated at BUILD time, so anything an operator can change per
    // process (CSP_REPORT_ONLY, HSTS_INCLUDE_SUBDOMAINS, NEXT_PUBLIC_MONACO_VS_PATH) must NOT be
    // delivered from there. These two are constants under every option combination; that is the
    // property that makes calling securityHeaders() with no options here correct.
    const relaxed = securityHeaders({
      reportOnly: true,
      allowEval: true,
      hsts: false,
      monacoVsPath: "https://assets.example.com/monaco/vs",
    });
    const shipped = securityHeaders();

    expect(relaxed["X-Content-Type-Options"]).toBe(shipped["X-Content-Type-Options"]);
    expect(relaxed["X-Frame-Options"]).toBe(shipped["X-Frame-Options"]);
  });
});

describe("control: the document surface is unchanged by the static-asset path", () => {
  test("a document still carries the full seven-header set from the proxy", async () => {
    const response = await proxy(request("/", await createToken("user")));

    expect(Object.keys(securityHeaders()).sort()).toEqual([
      "Content-Security-Policy",
      "Cross-Origin-Opener-Policy",
      "Permissions-Policy",
      "Referrer-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
    ]);
    for (const name of Object.keys(securityHeaders())) {
      expect({ name, present: response.headers.get(name) !== null }).toEqual({ name, present: true });
    }
  });

  test("the two headers next.config also delivers are byte-identical, so the overlap is inert", async () => {
    // The rules match documents too (narrowing the source would mean a second copy of the
    // matcher's exclusion list, which is exactly the drift this shares a source of truth to
    // avoid). That is only safe while both deliveries agree byte for byte.
    const response = await proxy(request("/", await createToken("user")));
    const delivered = headersFor(await configHeaderRules(), "/");

    for (const [name, value] of Object.entries(delivered)) {
      expect({ name, value: response.headers.get(name) }).toEqual({ name, value });
    }
  });
});
