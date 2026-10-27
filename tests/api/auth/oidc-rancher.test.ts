/**
 * Rancher Manager's OIDC provider as Studio's identity provider (docs/OIDC.md#rancher).
 *
 * The other OIDC route tests replace `@/lib/oidc` wholesale, so they never run the role mapping, openid-client's ID
 * token claim checks or the logout URL builder. Here those run for real: the login, callback and logout routes,
 * `@/lib/oidc` and openid-client talk to a Rancher-shaped provider served by a stubbed `fetch`. Only the cookie store and
 * the server storage provider are replaced, so every cookie and every storage call the flow makes can be inspected.
 *
 * openid-client checks the ID token's claims (issuer, audience, expiry, nonce) but not its signature: an ID token taken
 * straight from the token endpoint is vouched for by the TLS connection to it, which OIDC Core 3.1.3.7 allows. So no
 * JWKS is served here, and docs/OIDC.md#rancher forbids turning TLS verification off to reach a self-signed Rancher.
 *
 * Like Rancher's token handler, the stub refuses a code verifier that does not match the authorization request's S256
 * challenge, and a client secret that is wrong, whether it comes in a Basic header or in the form.
 *
 * The provider's shape follows Rancher's `pkg/oidc/provider` at v2.15.2 and v2.14.6: the issuer is `<server-url>/oidc`,
 * discovery lists `openid profile offline_access` and no `end_session_endpoint`, and the ID token carries `sub` (the
 * Rancher user id), `name` with the `profile` scope, `groups`, `auth_provider` and `nonce`, but no `email` and no
 * `preferred_username`. 2.15 sends `groups` only for the `groups` scope, 2.14 sends it unasked, and on every line
 * a user with no group principals, such as every local user, gets no `groups` claim at all.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import { NextRequest } from "next/server";

const SERVER_URL = "https://rancher.example.com";
const ISSUER = `${SERVER_URL}/oidc`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const TOKEN_URL = `${ISSUER}/token`;
const CLIENT_ID = "client-libredb-studio";
const CLIENT_SECRET = "not-a-real-client-secret";
const STUDIO = "https://studio.example.com";
const RANCHER_USER = "u-abc12";

/** Unique markers, so a leak is found wherever it lands. */
const ACCESS_TOKEN = "not-a-real-access-token-rancher-7f3a";
const REFRESH_TOKEN = "not-a-real-refresh-token-rancher-9c1e";
const RANCHER_SESSION = "not-a-real-rancher-session";

// ─── The cookie store: an in-memory jar the routes read and write ──────────

const jar = new Map<string, string>();
/** Every value any route ever set, by cookie name, in order. */
const cookieWrites: { name: string; value: string }[] = [];
const cookieDeletes: string[] = [];

const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
  set: (name: string, value: string) => {
    jar.set(name, value);
    cookieWrites.push({ name, value });
  },
  delete: (arg: string | { name: string }) => {
    const name = typeof arg === "string" ? arg : arg.name;
    jar.delete(name);
    cookieDeletes.push(name);
  },
};

mock.module("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => ({ get: () => null }),
}));

// ─── The server storage provider: records every call the flow makes ────────

const storageCalls: { method: string; args: unknown[] }[] = [];
const recordingProvider = new Proxy(
  {},
  {
    get: (_target, method) => {
      if (method === "then") return undefined;
      return async (...args: unknown[]) => {
        storageCalls.push({ method: String(method), args });
        return null;
      };
    },
  },
);

mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => true,
  getStorageConfig: () => ({ provider: "sqlite", serverMode: true }),
  getStorageProvider: async () => recordingProvider,
  closeStorageProvider: async () => {},
}));

// ─── The Rancher-shaped provider ────────────────────────────────────────────

const signingKey = await generateKeyPair("RS256");

/**
 * Rancher v2.15.2's discovery document, field for field (`openIDConfigurationEndpoint` in configuration.go): no
 * end_session_endpoint and no token_endpoint_auth_methods_supported, S256 only, RS256 only.
 */
const discoveryDocument = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: TOKEN_URL,
  jwks_uri: JWKS_URL,
  userinfo_endpoint: `${ISSUER}/userinfo`,
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["openid", "profile", "offline_access"],
  grant_types_supported: ["authorization_code", "refresh_token"],
};

type Line = "2.15" | "2.14";

/** What the next token request answers with, and the challenge it must match; set by each sign-in. */
const next = { idToken: "", codeChallenge: "", tokenRequests: [] as URLSearchParams[] };

/**
 * Rancher's token handler (`pkg/oidc/provider/token.go`): the client secret comes from a Basic header first and the form
 * otherwise, and the code verifier must hash to the challenge of the authorization request.
 */
function tokenRequestRefusal(form: URLSearchParams, headers: Headers): string | null {
  const basic = headers.get("authorization");
  const secret = basic?.startsWith("Basic ")
    ? decodeURIComponent(Buffer.from(basic.slice(6), "base64").toString().split(":")[1] ?? "")
    : form.get("client_secret");
  if (secret !== CLIENT_SECRET) return "invalid client_secret";
  const verifier = form.get("code_verifier") ?? "";
  if (createHash("sha256").update(verifier).digest("base64url") !== next.codeChallenge) return "invalid code_verifier";
  return null;
}

/**
 * The ID token Rancher's `createIDToken` writes. On 2.15 `groups` is present only when the scope asked for it; on 2.14
 * it is present unasked; on both it is absent when the user has no group principals (`groups` null here).
 */
async function rancherIdToken(line: Line, scope: string, nonce: string, groups: string[] | null): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const scopes = scope.split(" ");
  const claims: Record<string, unknown> = { auth_provider: groups === null ? "local" : "github", nonce };
  if (scopes.includes("profile")) claims.name = "Dev A";
  const sendsGroups = line === "2.14" || scopes.includes("groups");
  if (groups !== null && sendsGroups) claims.groups = groups;
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "rancher-oidc-key", typ: "JWT" })
    .setIssuer(ISSUER)
    .setSubject(RANCHER_USER)
    .setAudience([CLIENT_ID])
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signingKey.privateKey);
}

let fetchSpy: ReturnType<typeof spyOn>;

// ─── Everything the process prints ─────────────────────────────────────────

const printed: string[] = [];
const consoleSpies: ReturnType<typeof spyOn>[] = [];

const ENV_KEYS = [
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_SCOPE",
  "OIDC_ROLE_CLAIM",
  "OIDC_ADMIN_ROLES",
  "OIDC_USER_ROLES",
  "OIDC_ROLE_PREFIX",
  "OIDC_PROMPT",
  "OIDC_LOGOUT_HINT",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const oidc = await import("@/lib/oidc");
const { GET: login } = await import("@/app/api/auth/oidc/login/route");
const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");
const { POST: logout } = await import("@/app/api/auth/logout/route");
const { verifyJWT } = await import("@/lib/auth");

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === DISCOVERY_URL) return Response.json(discoveryDocument);
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      next.tokenRequests.push(form);
      const refusal = tokenRequestRefusal(form, new Headers(init?.headers));
      if (refusal !== null)
        return Response.json({ error: "invalid_request", error_description: refusal }, { status: 400 });
      return Response.json({
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 300,
        id_token: next.idToken,
        refresh_token: REFRESH_TOKEN,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      }),
    );
  }
});

afterAll(() => {
  fetchSpy.mockRestore();
  for (const spy of consoleSpies) spy.mockRestore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** The Rancher setup of docs/OIDC.md#rancher for 2.15, with `overrides` on top (undefined deletes). */
function useRancherEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}): void {
  const env: Record<string, string | undefined> = {
    NEXT_PUBLIC_AUTH_PROVIDER: "oidc",
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_SCOPE: "openid profile groups",
    OIDC_ROLE_CLAIM: undefined,
    OIDC_ADMIN_ROLES: undefined,
    OIDC_USER_ROLES: undefined,
    OIDC_ROLE_PREFIX: undefined,
    OIDC_PROMPT: "omit",
    OIDC_LOGOUT_HINT: undefined,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  jar.clear();
  cookieWrites.length = 0;
  cookieDeletes.length = 0;
  storageCalls.length = 0;
  printed.length = 0;
  next.idToken = "";
  next.codeChallenge = "";
  next.tokenRequests.length = 0;
  oidc.resetDiscoveryCache();
});

afterEach(() => {
  oidc.resetDiscoveryCache();
});

/** Starts a sign-in at Studio and returns the authorization URL Studio sent the browser to. */
async function startSignIn(): Promise<URL> {
  const res = await login(new Request(`${STUDIO}/api/auth/oidc/login`));
  expect(res.status).toBe(307);
  const authorize = new URL(res.headers.get("location") as string);
  next.codeChallenge = authorize.searchParams.get("code_challenge") as string;
  return authorize;
}

/** A whole sign-in: login route, Rancher's answer for `line` and `groups`, callback route. */
async function signIn(line: Line, groups: string[] | null) {
  const authorize = await startSignIn();
  const scope = authorize.searchParams.get("scope") as string;
  next.idToken = await rancherIdToken(line, scope, authorize.searchParams.get("nonce") as string, groups);
  const state = authorize.searchParams.get("state") as string;
  const res = await callback(new Request(`${STUDIO}/api/auth/oidc/callback?code=not-a-real-code&state=${state}`));
  const token = jar.get("auth-token");
  return { res, session: token === undefined ? null : await verifyJWT(token) };
}

describe("Rancher as the OIDC identity provider", () => {
  test("the authorization URL carries OIDC_SCOPE as set, no prompt under OIDC_PROMPT=omit, and an S256 challenge", async () => {
    useRancherEnv();
    const authorize = await startSignIn();

    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(authorize.searchParams.get("scope")).toBe("openid profile groups");
    expect(authorize.searchParams.has("prompt")).toBe(false);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${STUDIO}/api/auth/oidc/callback`);
  });

  for (const [line, scope] of [
    ["2.15", "openid profile groups"],
    ["2.14", "openid profile"],
  ] as const) {
    test(`${line}: the username and subject are the Rancher user id, and OIDC_ROLE_CLAIM=groups maps the admin group`, async () => {
      useRancherEnv({ OIDC_SCOPE: scope, OIDC_ROLE_CLAIM: "groups", OIDC_ADMIN_ROLES: "libredb-admins" });
      const { res, session } = await signIn(line, ["github_team://1234", "libredb-admins"]);

      expect(res.headers.get("location")).toBe(`${STUDIO}/admin`);
      expect(session).toMatchObject({
        role: "admin",
        username: RANCHER_USER,
        idpSubject: RANCHER_USER,
        idpIssuer: ISSUER,
      });
      // One token request, which passed the stub's PKCE and client secret checks, as Rancher's would.
      expect(next.tokenRequests).toHaveLength(1);
      expect(next.tokenRequests[0].get("grant_type")).toBe("authorization_code");
    });

    test(`${line}: a member of other groups only is a user`, async () => {
      useRancherEnv({ OIDC_SCOPE: scope, OIDC_ROLE_CLAIM: "groups", OIDC_ADMIN_ROLES: "libredb-admins" });
      const { res, session } = await signIn(line, ["github_team://1234"]);

      expect(res.headers.get("location")).toBe(`${STUDIO}/`);
      expect(session).toMatchObject({ role: "user", username: RANCHER_USER, idpSubject: RANCHER_USER });
    });

    test(`${line}: with OIDC_ROLE_CLAIM unset, a group named admin grants no admin`, async () => {
      useRancherEnv({ OIDC_SCOPE: scope });
      const { session } = await signIn(line, ["admin"]);

      expect(session).toMatchObject({ role: "user", username: RANCHER_USER });
    });

    for (const roleClaim of [undefined, "groups"]) {
      test(`${line}: a local user, whose token has no groups claim, signs in as a user (OIDC_ROLE_CLAIM ${roleClaim ?? "unset"})`, async () => {
        useRancherEnv({ OIDC_SCOPE: scope, OIDC_ROLE_CLAIM: roleClaim, OIDC_ADMIN_ROLES: "libredb-admins" });
        const { res, session } = await signIn(line, null);

        expect(decodeJwt(next.idToken).groups).toBeUndefined();
        expect(res.headers.get("location")).toBe(`${STUDIO}/`);
        expect(session).toMatchObject({ role: "user", username: RANCHER_USER, idpIssuer: ISSUER });
      });
    }
  }

  // Rancher refuses any scope its client does not allow, Studio's default `email` among them, by redirecting back with
  // `error=invalid_scope`; the login page then shows its generic failure, which docs/OIDC.md#rancher explains.
  test("Rancher's invalid_scope answer to the default OIDC_SCOPE ends on oidc_failed with no session", async () => {
    useRancherEnv({ OIDC_SCOPE: undefined });
    const authorize = await startSignIn();
    expect(authorize.searchParams.get("scope")).toBe("openid profile email");

    const state = authorize.searchParams.get("state") as string;
    const res = await callback(
      new Request(
        `${STUDIO}/api/auth/oidc/callback?error=invalid_scope&error_description=invalid+scope%3A+email&state=${state}`,
      ),
    );

    expect(res.headers.get("location")).toBe(`${STUDIO}/login?error=oidc_failed`);
    expect(jar.has("auth-token")).toBe(false);
    expect(next.tokenRequests).toHaveLength(0);
  });

  test("logout ends only Studio's session, because Rancher's discovery has no end_session_endpoint", async () => {
    useRancherEnv();
    const { session } = await signIn("2.15", null);
    expect(session).not.toBeNull();

    const res = await logout(new NextRequest(`${STUDIO}/api/auth/logout`, { method: "POST" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(cookieDeletes).toContain("auth-token");
    expect(jar.has("auth-token")).toBe(false);
  });

  for (const wrong of ["code verifier", "client secret"] as const) {
    test(`Rancher refuses a token request with the wrong ${wrong}, and the sign-in ends on oidc_failed`, async () => {
      useRancherEnv(wrong === "client secret" ? { OIDC_CLIENT_SECRET: "not-the-client-secret" } : {});
      const authorize = await startSignIn();
      if (wrong === "code verifier") next.codeChallenge = "not-the-challenge-of-this-sign-in";
      next.idToken = await rancherIdToken(
        "2.15",
        "openid profile groups",
        authorize.searchParams.get("nonce") as string,
        null,
      );
      const state = authorize.searchParams.get("state") as string;
      const res = await callback(new Request(`${STUDIO}/api/auth/oidc/callback?code=not-a-real-code&state=${state}`));

      expect(next.tokenRequests).toHaveLength(1);
      expect(res.headers.get("location")).toBe(`${STUDIO}/login?error=oidc_failed`);
      expect(jar.has("auth-token")).toBe(false);
    });
  }

  test("the access token, refresh token and Rancher session cookie reach no cookie, storage call, log line or session", async () => {
    useRancherEnv({ OIDC_ROLE_CLAIM: "groups", OIDC_LOGOUT_HINT: "true" });
    // A Rancher session cookie in the jar is copied nowhere either.
    jar.set("R_SESS", RANCHER_SESSION);
    const { session } = await signIn("2.15", ["libredb-admins"]);
    await logout(new NextRequest(`${STUDIO}/api/auth/logout`, { method: "POST" }));

    // The flow did write cookies and print lines, so the checks below inspect something.
    expect(cookieWrites.map((write) => write.name)).toEqual(["oidc-state", "auth-token", "oidc-logout-hint"]);
    // The hint cookie holds the ID token, which OIDC_LOGOUT_HINT asks for, and nothing else.
    expect(cookieWrites[2].value).toBe(next.idToken);
    // Logout warns that Rancher advertises no end-session endpoint, so the log check reads real lines.
    expect(printed.some((line) => line.includes("Failed to build OIDC logout URL"))).toBe(true);

    const everything = JSON.stringify({
      cookies: cookieWrites,
      storage: storageCalls,
      printed,
      session,
      idToken: decodeJwt(next.idToken),
    });
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, RANCHER_SESSION, CLIENT_SECRET]) {
      expect(everything).not.toContain(secret);
    }
  });
});
