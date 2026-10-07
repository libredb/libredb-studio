import { withBasePathEnv } from "../helpers/base-path";
import { describe, test, expect, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { config, proxy } from "@/proxy";
import { AGENT_DRIVE_HEADER, AGENT_DRIVE_PATH, mintAgentDriveToken } from "@/lib/agent/drive-token";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetLaunchConfigWarning } from "@/lib/launch/config";

// ─── JWT helpers ────────────────────────────────────────────────────────────

const JWT_SECRET = new TextEncoder().encode("test-jwt-secret-for-unit-tests-32ch");

async function createToken(role: string, expiresIn = "1h") {
  return await new SignJWT({ role, username: role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(JWT_SECRET);
}

function createNextRequest(pathname: string, token?: string): NextRequest {
  const url = `http://localhost:3000${pathname}`;
  const headers = new Headers();
  if (token) {
    headers.set("cookie", `auth-token=${token}`);
  }
  return new NextRequest(url, { headers });
}

function isRedirect(response: Response): boolean {
  return response.status === 307 || response.status === 308 || response.status === 302 || response.status === 301;
}

function getRedirectLocation(response: Response): string | null {
  return response.headers.get("location");
}

/** The session-required answer an API path gets instead of a redirect to the sign-in page (#1420). */
async function expectSessionRequired(response: Response, error: string) {
  expect(response.status).toBe(401);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error, code: "AUTH_REQUIRED" });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("proxy", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Public routes
  // ───────────────────────────────────────────────────────────────────────────

  describe("public routes", () => {
    test("/api/auth/login passes through without redirect", async () => {
      const req = createNextRequest("/api/auth/login");
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(false);
    });

    test("/api/db/health passes through without redirect", async () => {
      const req = createNextRequest("/api/db/health");
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(false);
    });

    // A health path that answers with a redirect to the login screen reads as HEALTHY to
    // any check that follows redirects, which is worse than a 404 (#909). All three have to
    // be reachable without a credential or the check is measuring the login page.
    test("/health passes through without redirect", async () => {
      expect(isRedirect(await proxy(createNextRequest("/health")))).toBe(false);
    });

    test("/api/health passes through without redirect", async () => {
      expect(isRedirect(await proxy(createNextRequest("/api/health")))).toBe(false);
    });

    test("/_next/static/chunk.js passes through without redirect", async () => {
      const req = createNextRequest("/_next/static/chunk.js");
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(false);
    });

    test("/favicon.ico passes through without redirect", async () => {
      const req = createNextRequest("/favicon.ico");
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(false);
    });

    // The launch page creates the session, so a visitor without one must reach it, and a visitor who
    // already has one must reach it too, so the launch route can refresh the same account or answer 409
    // for another one.
    test("/launch passes through without redirect, with or without a session", async () => {
      expect(isRedirect(await proxy(createNextRequest("/launch")))).toBe(false);
      expect(isRedirect(await proxy(createNextRequest("/launch", await createToken("user"))))).toBe(false);
    });

    test("/launch carries the document security headers", async () => {
      const res = await proxy(createNextRequest("/launch"));

      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    });

    // Under OIDC no launch can sign anyone in, so the page answers what POST /api/auth/launch answers
    // instead of loading a form that can only fail.
    test("/launch answers 503 with the problem while launch sign-in is unavailable, as under OIDC", async () => {
      const saved = process.env.NEXT_PUBLIC_AUTH_PROVIDER;
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await proxy(createNextRequest("/launch"));

        expect(res.status).toBe(503);
        expect(await res.text()).toBe("Launch sign-in is not available when NEXT_PUBLIC_AUTH_PROVIDER=oidc.");
        expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("x-frame-options")).toBe("DENY");
      } finally {
        if (saved === undefined) delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
        else process.env.NEXT_PUBLIC_AUTH_PROVIDER = saved;
        errorSpy.mockRestore();
        resetLaunchConfigWarning();
      }
    });

    test("/launch answers 503 with the problem while the launch configuration is broken", async () => {
      const names = ["LAUNCH_TOKEN_SECRET", "LAUNCH_TOKEN_AUDIENCE", "LAUNCH_TOKEN_ISSUER"] as const;
      const saved = names.map((name) => process.env[name]);
      process.env.LAUNCH_TOKEN_SECRET = "too-short";
      process.env.LAUNCH_TOKEN_AUDIENCE = "studio-1";
      process.env.LAUNCH_TOKEN_ISSUER = "platform";
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await proxy(createNextRequest("/launch"));

        expect(res.status).toBe(503);
        expect(await res.text()).toBe(
          "LAUNCH_TOKEN_SECRET must be at least 32 characters: launch sign-in is unavailable until it is fixed.",
        );
        expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("x-frame-options")).toBe("DENY");
      } finally {
        names.forEach((name, index) => {
          const value = saved[index];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        });
        errorSpy.mockRestore();
        resetLaunchConfigWarning();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Login page
  // ───────────────────────────────────────────────────────────────────────────

  describe("/login page", () => {
    test("allows access without token", async () => {
      const req = createNextRequest("/login");
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(false);
    });

    test("redirects to /admin with valid admin token", async () => {
      const token = await createToken("admin");
      const req = createNextRequest("/login", token);
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain("/admin");
    });

    test("redirects to / with valid user token", async () => {
      const token = await createToken("user");
      const req = createNextRequest("/login", token);
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(true);
      const location = getRedirectLocation(res)!;
      // Should redirect to root, not /admin
      expect(location).toContain("http://localhost:3000");
      expect(location).not.toContain("/admin");
      expect(location).not.toContain("/login");
    });

    test("allows access with invalid token", async () => {
      const req = createNextRequest("/login", "invalid-token-garbage");
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(false);
    });

    test("a signed-in visitor goes to the page next names, as the sign-in form would", async () => {
      const token = await createToken("user");
      const res = await proxy(createNextRequest("/login?next=%2F%3Fconnection%3Dseed%253Aorders", token));

      expect(getRedirectLocation(res)).toBe("http://localhost:3000/?connection=seed%3Aorders");
    });

    test("a next that would leave this application is ignored for the role's landing page", async () => {
      const token = await createToken("admin");
      const res = await proxy(createNextRequest("/login?next=%2F%2Fevil.example", token));

      expect(getRedirectLocation(res)).toBe("http://localhost:3000/admin");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Protected routes
  // ───────────────────────────────────────────────────────────────────────────

  describe("protected routes", () => {
    test("redirects to /login without token", async () => {
      const req = createNextRequest("/");
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain("/login");
    });

    test("allows access with valid token", async () => {
      const token = await createToken("user");
      const req = createNextRequest("/", token);
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(false);
    });

    test("redirects to /login with expired/invalid token", async () => {
      const req = createNextRequest("/", "expired-or-invalid-token");
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain("/login");
    });

    test("a signed-out deep link goes to sign in with its address in next", async () => {
      const res = await proxy(createNextRequest("/?connection=seed%3Aorders"));

      expect(getRedirectLocation(res)).toBe("http://localhost:3000/login?next=%2F%3Fconnection%3Dseed%253Aorders");
    });

    test("next carries the page's whole query, also when the session has expired", async () => {
      const res = await proxy(createNextRequest("/admin?tab=audit&page=2", "expired-or-invalid-token"));

      expect(getRedirectLocation(res)).toBe("http://localhost:3000/login?next=%2Fadmin%3Ftab%3Daudit%26page%3D2");
    });

    test("the bare root goes to sign in without next", async () => {
      const res = await proxy(createNextRequest("/"));

      expect(getRedirectLocation(res)).toBe("http://localhost:3000/login");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // RBAC: /admin routes
  // ───────────────────────────────────────────────────────────────────────────

  describe("/admin RBAC", () => {
    test("allows admin role to access /admin", async () => {
      const token = await createToken("admin");
      const req = createNextRequest("/admin", token);
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(false);
    });

    test("redirects user role from /admin to /", async () => {
      const token = await createToken("user");
      const req = createNextRequest("/admin", token);
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(true);
      const location = getRedirectLocation(res)!;
      expect(location).toContain("http://localhost:3000");
      expect(location).not.toContain("/admin");
      expect(location).not.toContain("/login");
    });

    // Threat: the redirect above used to be silent. A non-admin token probing /admin left no trace
    // in the one channel this project treats as authoritative, so the only role denial the proxy
    // makes was invisible next to the origin_mismatch line it already records.
    test("the redirect emits permission_denied with reason insufficient_role", async () => {
      const token = await createToken("user");
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        await proxy(createNextRequest("/admin", token));

        const lines = spy.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
        expect(lines).toHaveLength(1);
        expect(lines[0].event).toBe("permission_denied");
        expect(lines[0].reason).toBe("insufficient_role");
        expect(lines[0].actor).toBe("user");
        expect(lines[0].route).toBe("GET /admin");
      } finally {
        spy.mockRestore();
      }
    });

    // Threat the metering answers: holding a signed non-admin token bounds how many IDENTITIES
    // reach the branch, not how many requests each makes. Unmetered, one session polling /admin
    // fills a log volume and evicts real events from the 1000-entry ring the admin UI reads.
    test("the audit line is bounded per identity while the redirect stays unconditional", async () => {
      // A distinct non-admin role, so this burst gets its own bucket key rather than sharing "user".
      const token = await createToken("flooder");
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        const responses = [];
        for (let i = 0; i < 8; i++) responses.push(await proxy(createNextRequest("/admin", token)));

        // Every request is still refused - the denial is never the thing being rationed.
        expect(responses.every((res) => isRedirect(res))).toBe(true);
        // The anon bucket's default is 5 per 300s and the trip itself is recorded, so a burst of
        // eight leaves exactly six lines. Pinned rather than bounded: an unmetered emit writes
        // eight, and this number is what fails if the metering is ever removed.
        expect(spy.mock.calls.length).toBe(6);
      } finally {
        spy.mockRestore();
        clearRateLimitState();
      }
    });

    test("a broken audit sink still redirects rather than failing the request", async () => {
      const token = await createToken("user");
      const logSpy = spyOn(console, "log").mockImplementation(() => {
        throw new Error("audit sink unavailable");
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await proxy(createNextRequest("/admin", token));

        expect(isRedirect(res)).toBe(true);
        expect(getRedirectLocation(res)).not.toContain("/admin");
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // API routes with auth
  // ───────────────────────────────────────────────────────────────────────────

  describe("API routes", () => {
    test("/api/db/query with valid token passes through", async () => {
      const token = await createToken("user");
      const req = createNextRequest("/api/db/query", token);
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(false);
    });

    // A fetch follows a redirect to /login and gets the sign-in page's HTML, which every client
    // caller failed to parse ("Unexpected token '<'") with nothing sending the user to sign in.
    test("/api/db/query without token answers 401 JSON, not a redirect", async () => {
      const res = await proxy(createNextRequest("/api/db/query"));

      await expectSessionRequired(res, "Authentication required");
    });

    test("/api/db/query with an expired token answers 401 JSON, not a redirect", async () => {
      const res = await proxy(createNextRequest("/api/db/query", await createToken("user", "-1h")));

      await expectSessionRequired(res, "Session expired. Sign in again.");
    });

    test("/api/db/query with a token that does not verify answers 401 JSON", async () => {
      const res = await proxy(createNextRequest("/api/db/query", "forged-token"));

      await expectSessionRequired(res, "Session expired. Sign in again.");
    });

    test("the 401 carries the security headers a redirect did", async () => {
      const res = await proxy(createNextRequest("/api/admin/audit"));

      expect(res.status).toBe(401);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("a page path that merely starts with api still redirects", async () => {
      const res = await proxy(createNextRequest("/apidocs"));

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain("/login");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The account a tab claimed the browser copy for (X-LibreDB-Workspace-Owner)
  // ───────────────────────────────────────────────────────────────────────────

  describe("workspace owner header", () => {
    async function tokenFor(username: string) {
      return await new SignJWT({ role: "user", username })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(JWT_SECRET);
    }

    function request(pathname: string, token: string, owner: string | null, method = "GET"): NextRequest {
      const headers = new Headers({
        cookie: `auth-token=${token}`,
        host: "localhost:3000",
        origin: "http://localhost:3000",
      });
      if (owner !== null) headers.set("X-LibreDB-Workspace-Owner", owner);
      return new NextRequest(`http://localhost:3000${pathname}`, { method, headers });
    }

    /** NextResponse.next() marks the response so the route runs; a refusal never carries it. */
    const reachesRoute = (response: Response) => response.headers.get("x-middleware-next") === "1";

    async function expectOwnerMismatch(response: Response) {
      expect(response.status).toBe(409);
      expect(reachesRoute(response)).toBe(false);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("WORKSPACE_OWNER_MISMATCH");
    }

    test("a request whose owner is the signed-in account reaches the route", async () => {
      const token = await tokenFor("ana@libredb.org");
      const res = await proxy(request("/api/storage", token, encodeURIComponent("ana@libredb.org")));

      expect(reachesRoute(res)).toBe(true);
    });

    test("a request whose owner is a different account answers 409 with the code", async () => {
      const token = await tokenFor("bob@libredb.org");

      await expectOwnerMismatch(await proxy(request("/api/storage", token, encodeURIComponent("ana@libredb.org"))));
    });

    test("an owner that does not decode is not the signed-in account", async () => {
      const token = await tokenFor("ana@libredb.org");

      await expectOwnerMismatch(await proxy(request("/api/storage", token, "%E0%A4%A")));
    });

    test("a request without the header behaves as before", async () => {
      const token = await tokenFor("ana@libredb.org");

      expect(reachesRoute(await proxy(request("/api/storage", token, null)))).toBe(true);
      expect(reachesRoute(await proxy(request("/", token, null)))).toBe(true);
    });

    test("a storage write carrying another account's owner is refused before the route runs", async () => {
      const token = await tokenFor("bob@libredb.org");
      const put = request("/api/storage/connections", token, encodeURIComponent("ana@libredb.org"), "PUT");

      await expectOwnerMismatch(await proxy(put));
      const own = request("/api/storage/connections", token, encodeURIComponent("bob@libredb.org"), "PUT");
      expect(reachesRoute(await proxy(own))).toBe(true);
    });

    test("public routes are not checked, so a tab can still ask which account is signed in", async () => {
      const token = await tokenFor("bob@libredb.org");
      const stale = encodeURIComponent("ana@libredb.org");

      expect(reachesRoute(await proxy(request("/api/auth/me", token, stale)))).toBe(true);
      expect(reachesRoute(await proxy(request("/api/auth/logout", token, stale, "POST")))).toBe(true);
      expect(reachesRoute(await proxy(request("/api/db/health", token, stale)))).toBe(true);
    });

    test("without a session the answer is still the session-required 401", async () => {
      const req = new NextRequest("http://localhost:3000/api/storage", {
        headers: { "X-LibreDB-Workspace-Owner": "ana%40libredb.org" },
      });

      await expectSessionRequired(await proxy(req), "Authentication required");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The agent drive path (#329 T9)
  //
  // The milestone's constraint is that wiring the durable transport must not open
  // an unauthenticated path past this middleware. The path is therefore guarded by
  // a credential, and the exemption list is pinned so a later edit cannot quietly
  // turn the credential into an exemption.
  // ───────────────────────────────────────────────────────────────────────────

  describe("agent drive path", () => {
    test("the public-path list is exactly the eight it names", () => {
      const source = readFileSync(new URL("../../src/proxy.ts", import.meta.url), "utf8");
      const block = source.slice(source.indexOf("// Allow public routes"), source.indexOf("if (!token)"));
      const literals = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

      expect(literals).toEqual([
        "/api/auth",
        "/_next",
        "/favicon.ico",
        "/health",
        "/api/health",
        "/api/db/health",
        "/api/storage/config",
        "/launch",
      ]);
    });

    test("no unlisted path reaches the app without a credential", () => {
      // The literal pin above cannot see an exemption written as an identifier
      // (`isStaticAsset` already is one), so this is the behavioural half. Every
      // path here is one the matcher genuinely routes through proxy() - see the
      // test below for the ones it does not.
      const unlistedApis = ["/api/agent/runs", "/api/agent/drive", "/api/db/query", "/api"];
      const unlistedPages = ["/admin", "/"];

      return Promise.all([
        ...unlistedApis.map(async (pathname) => {
          expect((await proxy(createNextRequest(pathname))).status).toBe(401);
        }),
        ...unlistedPages.map(async (pathname) => {
          expect(isRedirect(await proxy(createNextRequest(pathname)))).toBe(true);
        }),
      ]);
    });

    test("the workflow runtime's own callback path would sit OUTSIDE this middleware entirely", () => {
      // Recorded as a fact about the matcher, not as a control. The dot rule
      // (`.*\..*`) already excludes every path containing a dot, and
      // `.well-known` contains one - so the exclusion the runtime's setup guide
      // asks for is already in force, and adopting that integration would put an
      // unauthenticated route past this middleware with NO matcher edit at all.
      // That is why the drive path this task added is one the matcher DOES route
      // (asserted above), guarded by a credential rather than by a path rule.
      // The repo records the same dot-rule consequence in docs/BACKLOG.md A2.
      const matcher = new RegExp(`^${config.matcher[0]}$`);

      expect(matcher.test("/.well-known/workflow/v1/flow")).toBe(false);
      expect(matcher.test(AGENT_DRIVE_PATH)).toBe(true);
    });

    test("the matcher routes both MCP paths through proxy(), so an edit that drops them fails here", () => {
      const matcher = new RegExp(`^${config.matcher[0]}$`);
      expect(matcher.test("/api/mcp")).toBe(true);
      expect(matcher.test("/api/mcp/token")).toBe(true);
      // The control: the same compiled matcher skips a dotted path.
      expect(matcher.test("/.well-known/oauth-protected-resource")).toBe(false);
    });

    test("the drive path is not public: no credential answers 401", async () => {
      const res = await proxy(createNextRequest(AGENT_DRIVE_PATH));

      await expectSessionRequired(res, "Authentication required");
    });

    test("a valid drive token passes the drive path through", async () => {
      const req = createNextRequest(AGENT_DRIVE_PATH);
      req.headers.set(AGENT_DRIVE_HEADER, await mintAgentDriveToken("arun_0123456789abcdef"));

      expect(isRedirect(await proxy(req))).toBe(false);
    });

    test("a forged drive token does not pass", async () => {
      const req = createNextRequest(AGENT_DRIVE_PATH);
      req.headers.set(AGENT_DRIVE_HEADER, await createToken("admin"));

      expect((await proxy(req)).status).toBe(401);
    });

    test("a drive token opens the drive path and nothing else", async () => {
      const token = await mintAgentDriveToken("arun_0123456789abcdef");
      for (const pathname of ["/api/db/query", "/admin", "/api/agent/runs"]) {
        const req = createNextRequest(pathname);
        req.headers.set(AGENT_DRIVE_HEADER, token);

        const res = await proxy(req);
        expect(pathname === "/admin" ? isRedirect(res) : res.status === 401).toBe(true);
      }
    });
  });
});

describe("proxy under a nested basePath", () => {
  for (const [path, role, destination] of [
    ["/admin", undefined, "/login?next=%2Fadmin"],
    ["/login", "admin", "/admin"],
    ["/login", "user", "/"],
    ["/admin", "user", "/"],
    ["/", "expired", "/login"],
  ] as const) {
    test(`${path} (${role ?? "anonymous"}) redirects inside the mount`, async () => {
      await withBasePathEnv("/~/libredb", async () => {
        const token = role ? await createToken(role, role === "expired" ? "-1h" : "1h") : undefined;
        const request = new NextRequest(`http://localhost:3000/~/libredb${path}`, {
          headers: token ? { cookie: `auth-token=${token}` } : {},
          nextConfig: { basePath: "/~/libredb" },
        });
        expect(request.nextUrl.pathname).toBe(path);
        expect((await proxy(request)).headers.get("location")).toBe(`http://localhost:3000/~/libredb${destination}`);
      });
    });
  }
  test("a deep link opened signed out comes back to the same address inside the mount", async () => {
    await withBasePathEnv("/~/libredb", async () => {
      const options = { nextConfig: { basePath: "/~/libredb" } };
      const signedOut = await proxy(
        new NextRequest("http://localhost:3000/~/libredb/?connection=seed%3Aorders", options),
      );
      expect(signedOut.headers.get("location")).toBe(
        "http://localhost:3000/~/libredb/login?next=%2F%3Fconnection%3Dseed%253Aorders",
      );

      const token = await createToken("user");
      const signedIn = await proxy(
        new NextRequest("http://localhost:3000/~/libredb/login?next=%2F%3Fconnection%3Dseed%253Aorders", {
          ...options,
          headers: { cookie: `auth-token=${token}` },
        }),
      );
      expect(signedIn.headers.get("location")).toBe("http://localhost:3000/~/libredb/?connection=seed%3Aorders");
    });
  });
  test("a prefixed API path answers 401 JSON inside the mount, not a redirect", async () => {
    await withBasePathEnv("/~/libredb", async () => {
      const request = new NextRequest("http://localhost:3000/~/libredb/api/db/query", {
        nextConfig: { basePath: "/~/libredb" },
      });
      await expectSessionRequired(await proxy(request), "Authentication required");
    });
  });
  test("prefixed health is public and prefixed API writes still reject hostile origins", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      const url = "http://localhost:3000/tools/libredb/api/db/health";
      const options = { nextConfig: { basePath: "/tools/libredb" } };
      expect((await proxy(new NextRequest(url, options))).status).toBe(200);
      const request = new NextRequest(url, {
        ...options,
        method: "POST",
        headers: { host: "localhost:3000", origin: "https://evil.example" },
      });
      expect((await proxy(request)).status).toBe(403);
    });
  });
});
