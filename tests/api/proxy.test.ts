import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { config, proxy } from "@/proxy";
import { AGENT_DRIVE_HEADER, AGENT_DRIVE_PATH, mintAgentDriveToken } from "@/lib/agent/drive-token";

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

    test("/api/db/query without token redirects to /login", async () => {
      const req = createNextRequest("/api/db/query");
      const res = await proxy(req);

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain("/login");
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
    test("the public-path list is exactly the five it has always been", () => {
      const source = readFileSync(new URL("../../src/proxy.ts", import.meta.url), "utf8");
      const block = source.slice(source.indexOf("// Allow public routes"), source.indexOf("if (!token)"));
      const literals = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

      expect(literals).toEqual(["/api/auth", "/_next", "/favicon.ico", "/api/db/health", "/api/storage/config"]);
    });

    test("no unlisted path reaches the app without a credential", () => {
      // The literal pin above cannot see an exemption written as an identifier
      // (`isStaticAsset` already is one), so this is the behavioural half. Every
      // path here is one the matcher genuinely routes through proxy() - see the
      // test below for the ones it does not.
      const unlisted = ["/api/agent/runs", "/api/agent/drive", "/api/db/query", "/admin", "/"];

      return Promise.all(
        unlisted.map(async (pathname) => {
          expect(isRedirect(await proxy(createNextRequest(pathname)))).toBe(true);
        }),
      );
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

    test("the drive path is not public: no credential redirects to /login", async () => {
      const res = await proxy(createNextRequest(AGENT_DRIVE_PATH));

      expect(isRedirect(res)).toBe(true);
      expect(getRedirectLocation(res)).toContain("/login");
    });

    test("a valid drive token passes the drive path through", async () => {
      const req = createNextRequest(AGENT_DRIVE_PATH);
      req.headers.set(AGENT_DRIVE_HEADER, await mintAgentDriveToken("arun_0123456789abcdef"));

      expect(isRedirect(await proxy(req))).toBe(false);
    });

    test("a forged drive token does not pass", async () => {
      const req = createNextRequest(AGENT_DRIVE_PATH);
      req.headers.set(AGENT_DRIVE_HEADER, await createToken("admin"));

      expect(isRedirect(await proxy(req))).toBe(true);
    });

    test("a drive token opens the drive path and nothing else", async () => {
      const token = await mintAgentDriveToken("arun_0123456789abcdef");
      for (const pathname of ["/api/db/query", "/admin", "/api/agent/runs"]) {
        const req = createNextRequest(pathname);
        req.headers.set(AGENT_DRIVE_HEADER, token);

        expect(isRedirect(await proxy(req))).toBe(true);
      }
    });
  });
});
