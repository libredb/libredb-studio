/**
 * Control 1.10 (docs/SECURITY.md): under governance the identity provider is the only way in. A session the OIDC
 * callback did not mint for the identity provider at OIDC_ISSUER reaches no route: getSession() refuses an env
 * password, passkey or launch session, an OIDC session whose subject is empty and one minted for another issuer, and
 * clears its cookie; the password route answers 403 without reading credentials; and an MCP token, whose owner
 * carries no identity provider subject in this version, is refused too. A session also ends once the governance
 * source revokes its subject: getSession() refuses a session issued at or before the subject's `revoked_before`, while
 * a snapshot that cannot be served refuses no session.
 *
 * Through the real session check and every real route, with nothing mocked but next/headers. The boot check that
 * refuses ADMIN_PASSWORD under governance is not run here, as if it had been bypassed: tests/setup.ts sets that
 * password, and it still signs no one in. The revocation cases record the snapshot in the state holder as the loader
 * swaps one in.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { UserPayload } from "@/lib/auth";
import { recordGovernanceSnapshot, resetGovernanceState } from "@/lib/governance/state";
import { grantedSnapshot } from "../helpers/governance/granted-snapshot";
import { cookieJar, deletedCookies, installNextHeadersMock, resetCookieJar } from "../helpers/next-cookie-jar";
import { discoverRoutes } from "./helpers/discover-routes";

installNextHeadersMock();

const { getSession, signJWT } = await import("@/lib/auth");
const { POST: passwordLogin } = await import("@/app/api/auth/login/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { mcpTokenOwnerAllowed } = await import("@/lib/mcp/account-check");

const ISSUER = "https://idp.example/realms/libredb";
const SESSION_COOKIE = "auth-token";
const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

/** The sessions governance refuses: every sign-in but the OIDC callback, and two the callback could not have minted. */
const REFUSED_SESSIONS: Record<string, UserPayload> = {
  "an env password session": { role: "admin", username: "admin@libredb.org" },
  "a stored password or passkey session": { role: "admin", username: "admin@libredb.org", sessionVersion: 1 },
  "a launch session": { role: "user", username: "member@example.com", sessionVersion: 2 },
  "an OIDC session whose subject is empty": {
    role: "admin",
    username: "alice@example.com",
    idpSubject: "",
    idpIssuer: ISSUER,
  },
  "an OIDC session from another issuer": {
    role: "admin",
    username: "alice@example.com",
    idpSubject: "kc-user-1",
    idpIssuer: "https://other.example/realms/libredb",
  },
};

/** What the OIDC callback mints for the identity provider at OIDC_ISSUER. */
const GOVERNED_SESSION: UserPayload = {
  role: "admin",
  username: "alice@example.com",
  idpSubject: "kc-user-1",
  idpIssuer: ISSUER,
};

/**
 * The route handlers that read no user session, each with the reason. Every other handler reads the session through
 * getSession(), which the enumeration below proves by the cookie it clears, so this list is the whole of what the
 * governed rule does not decide. A handler here that starts reading the session fails the enumeration until it moves.
 */
const READS_NO_SESSION: Record<string, string> = {
  "POST /api/agent/drive":
    "the durable transport's callback verifies a server-minted single-purpose credential, never a session",
  "POST /api/auth/launch":
    "exchanges a launch token for a session and is refused before any session is read while launch sign-in is unavailable, as it is with NEXT_PUBLIC_AUTH_PROVIDER=oidc",
  "POST /api/auth/login": "refuses every caller under governance before it reads a body or a session",
  "GET /api/auth/oidc/callback": "completes the OIDC exchange that mints the governed session",
  "GET /api/auth/oidc/login": "starts the OIDC redirect before a session exists",
  "GET /api/auth/openshift/callback":
    "answers the 404 of an unknown path outside openshift sign-in mode, and governance signs in only under oidc",
  "GET /api/auth/openshift/login":
    "answers the 404 of an unknown path outside openshift sign-in mode, and governance signs in only under oidc",
  "POST /api/auth/passkey/sign-in":
    "authenticates a passkey assertion before a session exists, and the session it mints carries no identity provider subject, which getSession() refuses",
  "GET /api/db/health": "the public liveness answer of the database health route; its POST requires a session",
  "GET /api/health": "public liveness, a fixed body",
  "GET /api/mcp": "verifies a scoped MCP bearer token instead of a session; the owner check below refuses it",
  "POST /api/mcp": "verifies a scoped MCP bearer token instead of a session; the owner check below refuses it",
  "DELETE /api/mcp": "verifies a scoped MCP bearer token instead of a session; the owner check below refuses it",
  "GET /api/ready": "public readiness, answered from the in-process governance state for an orchestrator's probe",
  "GET /api/storage/config": "publicly documents whether server storage is enabled",
  "GET /health": "public liveness at the app root, a fixed body",
};

/** Handlers that read the session and answer 2xx without one, because what they do needs none. */
const SUCCEEDS_WITHOUT_A_SESSION: Record<string, string> = {
  "POST /api/auth/logout": "ends the session, which needs no session, and clears the cookie itself",
};

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** The params of every dynamic segment the routes use, so a handler reaches its session check. */
const ROUTE_CONTEXT = {
  params: Promise.resolve({ runId: "probe", correlationId: "probe", collection: "probe", email: "probe@example.com" }),
};

type RouteHandler = (request: Request, context: typeof ROUTE_CONTEXT) => Response | Promise<Response>;
type LoadRoute = () => Promise<Record<string, unknown>>;

/** Every route handler of the app: the API tree and the one route outside it, as tests/security/route-auth pins it. */
const ROUTES: Array<[string, LoadRoute]> = [
  ...discoverRoutes(join(SRC, "app", "api")).map(([key, load]): [string, LoadRoute] => [`/api/${key}`, load]),
  ["/health", () => import("@/app/health/route")],
];

const GOVERNANCE_ENV: Record<string, string | undefined> = {
  GOVERNANCE_SOURCE: "postgres",
  NEXT_PUBLIC_AUTH_PROVIDER: "oidc",
  OIDC_ISSUER: ISSUER,
  // The defaults: a snapshot can no longer be served once it is 120 s old.
  GOVERNANCE_REFRESH_MS: undefined,
  GOVERNANCE_MAX_STALENESS_MS: undefined,
  // Unset, so the OIDC login route answers oidc_config instead of asking the network for discovery.
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
};
const savedEnv: Record<string, string | undefined> = {};
let silenced: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  for (const [key, value] of Object.entries(GOVERNANCE_ENV)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Every refusal writes an audit line or a log line; they are not what this file reads.
  silenced = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterAll(() => {
  for (const spy of silenced) spy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  resetCookieJar();
  clearRateLimitState();
});

async function holdSession(session: UserPayload): Promise<string> {
  const token = await signJWT(session);
  cookieJar.set(SESSION_COOKIE, { value: token });
  return token;
}

const sessionCleared = (): boolean => deletedCookies.some((cookie) => cookie.name === SESSION_COOKIE);

describe("getSession() under governance", () => {
  for (const [kind, session] of Object.entries(REFUSED_SESSIONS)) {
    test(`refuses ${kind} and clears its cookie`, async () => {
      await holdSession(session);

      expect(await getSession()).toBeNull();
      expect(sessionCleared()).toBe(true);
      expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    });
  }

  // The control: the refusals above are the governed rule, not a session check that refuses everything.
  test("keeps a session the OIDC callback minted for OIDC_ISSUER", async () => {
    await holdSession(GOVERNED_SESSION);

    expect(await getSession()).toMatchObject(GOVERNED_SESSION);
    expect(sessionCleared()).toBe(false);
  });
});

/** Swaps in a snapshot loaded `ageMs` ago whose only revocations are `revocations`, as the loader does. */
function recordRevocations(revocations: ReadonlyArray<readonly [string, number]>, ageMs = 0): void {
  recordGovernanceSnapshot({ ...grantedSnapshot([], [], Date.now() - ageMs), revocations: new Map(revocations) });
}

describe("getSession() and the session revocations of the governance source", () => {
  afterEach(() => {
    resetGovernanceState();
  });

  test("refuses a session issued at or before its subject's revoked_before and clears its cookie", async () => {
    await holdSession(GOVERNED_SESSION);
    // The token's iat is the second it was signed in, so a revocation stamped from now on is at or after it.
    recordRevocations([["kc-user-1", Date.now()]]);

    expect(await getSession()).toBeNull();
    expect(sessionCleared()).toBe(true);
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });

  test("keeps a session issued after its subject's revoked_before, and one whose subject no row revokes", async () => {
    // Two seconds before the second the token is signed in, and a revocation of another subject for good.
    recordRevocations([
      ["kc-user-1", Date.now() - 2000],
      ["kc-user-2", Number.POSITIVE_INFINITY],
    ]);
    await holdSession(GOVERNED_SESSION);

    expect(await getSession()).toMatchObject(GOVERNED_SESSION);
    expect(sessionCleared()).toBe(false);
  });

  test("a revocation in a snapshot that cannot be served refuses no session, so an outage starts no sign-in storm", async () => {
    // GOVERNANCE_MAX_STALENESS_MS old: data routes answer 503 GOVERNANCE_UNAVAILABLE meanwhile.
    recordRevocations([["kc-user-1", Number.POSITIVE_INFINITY]], 120_000);
    await holdSession(GOVERNED_SESSION);

    expect(await getSession()).toMatchObject(GOVERNED_SESSION);
    expect(sessionCleared()).toBe(false);
  });
});

describe("routes under governance", () => {
  test("under governance no route accepts a session that lacks the identity provider subject", async () => {
    const answers: Array<{ handler: string; kind: string; status: number; cleared: boolean }> = [];

    for (const [path, load] of ROUTES) {
      const routeModule = await load();
      for (const method of METHODS) {
        const handler = routeModule[method];
        if (typeof handler !== "function") continue;
        for (const [kind, session] of Object.entries(REFUSED_SESSIONS)) {
          resetCookieJar();
          clearRateLimitState();
          const token = await holdSession(session);
          const response = await (handler as RouteHandler)(
            new Request(`http://localhost:3000${path}`, {
              method,
              headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
              // A non-empty body clears every route's own empty-body check, so each one reaches its session check.
              ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify({ probe: true }) }),
            }),
            ROUTE_CONTEXT,
          );
          answers.push({ handler: `${method} ${path}`, kind, status: response.status, cleared: sessionCleared() });
        }
      }
    }

    // Each handler that reads a session read it through getSession(), which refused it and cleared its cookie, and
    // none answered with what a session would buy; each handler that reads none is listed above with its reason.
    const accepted = answers
      .filter(({ handler, status, cleared }) =>
        handler in READS_NO_SESSION
          ? cleared
          : !cleared || (status >= 200 && status < 300 && !(handler in SUCCEEDS_WITHOUT_A_SESSION)),
      )
      .map(({ handler, kind, status, cleared }) => `${handler} with ${kind}: ${status}, cookie cleared: ${cleared}`);
    expect(accepted).toEqual([]);

    // Non-vacuity: the walk reached every listed handler and the routes that hold the data behind a session.
    const handlers = new Set(answers.map((answer) => answer.handler));
    for (const listed of [...Object.keys(READS_NO_SESSION), ...Object.keys(SUCCEEDS_WITHOUT_A_SESSION)]) {
      expect(handlers.has(listed)).toBe(true);
    }
    for (const guarded of [
      "POST /api/db/query",
      "GET /api/connections/managed",
      "GET /api/auth/me",
      "GET /api/admin/audit",
    ]) {
      expect(handlers.has(guarded)).toBe(true);
    }
    expect(handlers.size).toBeGreaterThanOrEqual(70);
  });

  test("valid env credentials sign no one in", async () => {
    const response = await passwordLogin(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@libredb.org", password: process.env.ADMIN_PASSWORD }),
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });

  test("an MCP token's owner, which carries no identity provider subject, is refused", async () => {
    const owner = { username: "admin@libredb.org", role: "admin", sessionVersion: 1 };

    expect(await mcpTokenOwnerAllowed({ token: "probe", clientId: "probe", scopes: [], extra: owner })).toBe(false);
  });

  // getSession() is every route's session check only while nothing else reads the session cookie: a module that read
  // and verified it itself would skip the governed rule. The proxy reads it too, for the signature alone, to route a
  // page request; it decides no data, and every route it lets through checks the session again.
  test("only src/lib/auth.ts reads the session cookie for a route, and only src/proxy.ts besides it", () => {
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && /\.get\(\s*["']auth-token["']\s*\)/.test(readFileSync(path, "utf8"))) {
          // Forward slashes whatever the platform, so the expectation below holds on the Windows leg of CI.
          readers.push(relative(ROOT, path).split(sep).join("/"));
        }
      }
    };
    walk(SRC);

    expect(readers.sort()).toEqual(["src/lib/auth.ts", "src/proxy.ts"]);
  });
});
