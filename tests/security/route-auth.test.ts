import { describe, expect, test, mock, spyOn, beforeEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverRoutes } from "./helpers/discover-routes";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

// ─── Mock @/lib/llm so a bypassed guard can never be mistaken for a working one ──
//
// Without this, a route that lost its guard would fall through to the real
// createLLMProvider() (network call, needs a valid key) and, on some failure
// modes, src/lib/api/errors.ts maps LLMAuthError to HTTP 401 — the exact status
// this test expects from the guard. A status-only assertion could then pass for
// the wrong reason. Making createLLMProvider throw a plain Error (not one of the
// LLM* classes) means a bypassed guard can only produce a 500 (the "Generic
// Error" branch in createErrorResponse), never a 401 — so 401 here can only mean
// the guard actually ran. This also means the test makes no network call.

class MockLLMError extends Error {
  statusCode?: number;
  constructor(msg: string, _provider?: string, code?: number) {
    super(msg);
    this.name = "LLMError";
    this.statusCode = code;
  }
}
class MockLLMConfigError extends MockLLMError {
  constructor(msg: string) {
    super(msg);
    this.name = "LLMConfigError";
  }
}
class MockLLMAuthError extends MockLLMError {
  constructor(msg: string) {
    super(msg, undefined, 401);
    this.name = "LLMAuthError";
  }
}
class MockLLMRateLimitError extends MockLLMError {
  constructor(msg: string) {
    super(msg, undefined, 429);
    this.name = "LLMRateLimitError";
  }
}
class MockLLMSafetyError extends MockLLMError {
  constructor(msg: string) {
    super(msg, undefined, 400);
    this.name = "LLMSafetyError";
  }
}
class MockLLMStreamError extends MockLLMError {
  constructor(msg: string) {
    super(msg);
    this.name = "LLMStreamError";
  }
}

const mockCreateLLMProvider = mock(async () => {
  throw new Error("createLLMProvider must not be reached: the guardRoute guard should have returned 401 first");
});

mock.module("@/lib/llm", () => ({
  createLLMProvider: mockCreateLLMProvider,
  LLMError: MockLLMError,
  LLMConfigError: MockLLMConfigError,
  LLMAuthError: MockLLMAuthError,
  LLMRateLimitError: MockLLMRateLimitError,
  LLMSafetyError: MockLLMSafetyError,
}));

mock.module("@/lib/llm/types", () => ({
  LLMError: MockLLMError,
  LLMConfigError: MockLLMConfigError,
  LLMAuthError: MockLLMAuthError,
  LLMRateLimitError: MockLLMRateLimitError,
  LLMSafetyError: MockLLMSafetyError,
  LLMStreamError: MockLLMStreamError,
}));

const { guardRoute } = await import("@/lib/api/require-session");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");

describe("guardRoute", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns the session when the caller is authenticated", async () => {
    const request = new Request("http://localhost:3000/api/db/query", { method: "POST" });

    const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request });

    expect(guard).toEqual({ session: { role: "admin", username: "admin" } });
  });

  test("returns a 401 response when no session exists", async () => {
    mockGetSession.mockImplementation(async () => null);
    const request = new Request("http://localhost:3000/api/db/query", { method: "POST" });

    const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request });

    expect("response" in guard).toBe(true);
    const response = (guard as { response: Response }).response;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  test("still returns 401 when the permission_denied audit emit throws", async () => {
    // Isolated in its own try/catch: a broken audit sink must never change a denial this route
    // already decided into an unrelated 500.
    mockGetSession.mockImplementation(async () => null);
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const request = new Request("http://localhost:3000/api/db/query", { method: "POST" });

      const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request });

      expect("response" in guard).toBe(true);
      const response = (guard as { response: Response }).response;
      expect(response.status).toBe(401);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("still returns 429 when the rate_limit_exceeded audit emit throws", async () => {
    const request = () => new Request("http://localhost:3000/api/db/query", { method: "POST" });
    // Trip the "query" bucket (default max 120) with a working audit sink first.
    for (let i = 0; i < 120; i += 1) {
      await guardRoute({ route: "POST /api/db/query", bucket: "query", request: request() });
    }

    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request: request() });

      expect("response" in guard).toBe(true);
      const response = (guard as { response: Response }).response;
      expect(response.status).toBe(429);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// Enumerated from disk instead of hardcoded, so a route added ANYWHERE under src/app/api/ is
// checked automatically instead of silently escaping this test. This replaces a curated
// GUARDED_ROUTES list (AI routes discovered dynamically, plus one hand-picked db/ entry) that
// was itself an instance of the exact failure it was trying to prevent: it never covered
// db/query, db/multi-query, db/transaction, db/maintenance, db/cancel, db/health,
// db/monitoring, db/pool-stats, db/profile, db/provider-meta, db/schema, db/schema/list,
// db/schema/relations, db/schema-snapshot, db/test-connection or admin/fleet-health - eleven of
// which reached a database provider through a bare inline getSession() with no rate limit and
// no denial audit, sitting undetected next to routes that had already been fixed. Walking the
// whole tree and requiring an explicit reason for every exemption is what makes a newly added
// provider-reaching route red by default instead of invisible by default.
const SRC_ROOT_DIR = join(import.meta.dir, "..", "..", "src");
const API_ROOT_DIR = join(SRC_ROOT_DIR, "app", "api");

const ALL_ROUTES = discoverRoutes(API_ROOT_DIR);

/**
 * Every route that legitimately reaches no database or LLM provider, so the enumeration below
 * does not require it to call guardRoute. Every entry needs a reason: an unexplained addition
 * here is exactly the hand-maintained-inventory drift this enumeration exists to prevent, and
 * the sanity check below fails if a key does not match a route that actually exists.
 *
 * One entry (`agent/drive`) is NOT in that category and says so in its own reason: it does reach
 * a provider, and it is exempt from THIS enumeration only because the enumeration probes with a
 * POST carrying no credential and asserts guardRoute's exact 401 body. That route cannot have a
 * user session by construction - it is the durable transport's callback - so it authenticates
 * with a server-minted single-purpose credential instead, and the same "no credential, no work"
 * property is proven against it in tests/api/agent/drive.test.ts. An exemption whose reason is a
 * different verified control is the only kind allowed here; "it has no auth" never is.
 */
const ROUTES_WITHOUT_A_PROVIDER: Record<string, string> = {
  "admin/audit": "reads/writes the in-process audit ring buffer only; no database or LLM provider",
  "agent/config":
    "answers whether the agent runtime is enabled, from process.env alone; no database or LLM provider (GET, no POST export). It still requires a session — a bare getSession() like connections/managed, because metering a visibility probe out of the ai bucket would spend a run's budget on rendering a panel — and tests/api/agent/config.test.ts proves an unauthenticated caller learns nothing about the flag",
  "agent/drive":
    "reaches a provider, but is the durable transport's callback and can have no user session: it verifies a server-minted single-purpose credential and its 401 body differs from guardRoute's on purpose (tests/api/agent/drive.test.ts)",
  "agent/runs/[runId]":
    "reads and cancels one run's own durable ledger; no database or LLM provider (GET/DELETE, no POST export). Its session check is guardRoute, through src/lib/api/agent-run-access.ts",
  "agent/runs/[runId]/artifacts/[correlationId]":
    "hands back rows one run already stored, from process memory; no database or LLM provider is reached to answer it (GET, no POST export). Same guardRoute path as above, through src/lib/api/agent-run-access.ts, and tests/api/agent/artifacts.test.ts proves an unauthenticated caller gets 401 and reads nothing",
  "agent/runs/[runId]/stream":
    "follows one run's own durable ledger; no database or LLM provider (GET, no POST export). Same guardRoute path as above",
  "auth/login": "authenticates the credential itself; a session cannot be required before one exists",
  "auth/logout": "clears the session cookie unconditionally; touches no provider either way",
  "auth/me": "reads the caller's own session claims only (GET, no POST export)",
  "auth/oidc/callback": "completes the OIDC exchange that CREATES the session (GET, no POST export)",
  "auth/oidc/login": "starts the OIDC redirect before a session exists (GET, no POST export)",
  "connections/managed": "reads seed config metadata only; never opens a database connection (GET, no POST export)",
  storage: "reaches the app's own storage backend (STORAGE_PROVIDER), not a user database or LLM provider (GET only)",
  "storage/[collection]": "same storage backend as above, scoped to the caller's own data (PUT, no POST export)",
  "storage/config": "publicly documents whether server storage is enabled; no session, no provider (GET only)",
  "storage/migrate": "same storage backend as above; its own 401 body differs from guardRoute's on purpose",
};

const PROVIDER_ROUTES = ALL_ROUTES.filter(([key]) => !(key in ROUTES_WITHOUT_A_PROVIDER));

describe("routes that reach a provider require a session", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => null);
  });

  // A directory-listing bug that silently finds zero routes would make every test below
  // vacuously pass (a `for` loop over an empty array runs no assertions). This is the guard
  // that keeps the guard honest: today there are 21 provider-reaching routes (16 db/ + 3 AI +
  // admin/fleet-health + agent/runs), and the enumeration must find at least that many, or
  // this test suite is no longer proving what it claims to prove.
  test("the filesystem enumeration finds at least today's 21 provider-reaching routes", () => {
    expect(PROVIDER_ROUTES.length).toBeGreaterThanOrEqual(21);
  });

  // A recursion bug that only ever looked one level deep would still pass the check above by
  // over-counting somewhere else; this independently confirms the AI routes specifically -
  // exactly one directory level under src/app/api/ai/ - are still found by the same walk that
  // also has to reach three levels deep for db/schema/list and db/schema/relations.
  //
  // Three since #331 T3 removed chat with the in-editor assistant it served, after T2 removed
  // nl2sql, autopilot, impact and index-advisor with their panels: describe-schema, explain,
  // query-safety.
  test("the same walk finds at least today's three AI routes", () => {
    expect(ALL_ROUTES.filter(([key]) => key.startsWith("ai/")).length).toBeGreaterThanOrEqual(3);
  });

  // A typo'd or stale allowlist key silently exempts fewer routes than intended (or a route
  // that no longer exists) without ever failing loudly - this is what catches that.
  test("every allowlist entry names a route that actually exists", () => {
    for (const key of Object.keys(ROUTES_WITHOUT_A_PROVIDER)) {
      expect(ALL_ROUTES.some(([routeKey]) => routeKey === key)).toBe(true);
    }
  });

  // The check above proves an allowlist key names a real route. It does NOT prove the key's
  // REASON - "reaches no database or LLM provider" - is still true, so a route already on the
  // allowlist that later grows a provider call escapes the sweep above forever, silently. This
  // is the second, independent check: it reads each allowlisted route's own source and fails if
  // the file reaches any of the provider entry points the non-allowlisted routes use.
  //
  // The entry-point set below is not a guess: it is every way a route under src/app/api/ obtains
  // a provider today - the `@/lib/db` barrel and `@/lib/db/factory`
  // (getOrCreateProvider, createDatabaseProvider, removeProvider, findOpenSingleWriterProvider,
  // acquireExecutionProfileProvider, withOneShotTunnel), `@/lib/llm`
  // (createLLMProvider) and its config helpers, and `@/lib/api/schema-route`
  // (handleSchemaRequest), which is how db/schema/list and db/schema/relations reach a provider
  // without naming @/lib/db themselves. Matching on the module specifier prefix rather than on a
  // fixed list of exported names means a NEW factory export is covered the day it is added.
  //
  // Deliberately NOT flagged: `@/lib/api/errors`, which nearly every route imports and which
  // itself imports @/lib/db/errors and @/lib/llm/types - error mapping reaches no provider, and
  // treating it as an entry point would make this check fire on all sixteen allowlisted routes.
  const PROVIDER_ENTRY_POINTS: Array<{ label: string; pattern: RegExp }> = [
    { label: 'a "@/lib/db" import', pattern: /from\s+"@\/lib\/db(?:\/[^"]*)?"/ },
    { label: 'a "@/lib/llm" import', pattern: /from\s+"@\/lib\/llm(?:\/[^"]*)?"/ },
    { label: 'a "@/lib/api/schema-route" import', pattern: /from\s+"@\/lib\/api\/schema-route"/ },
    { label: "a getOrCreateProvider() call", pattern: /\bgetOrCreateProvider\s*\(/ },
    { label: "a createDatabaseProvider() call", pattern: /\bcreateDatabaseProvider\s*\(/ },
    { label: "an acquireExecutionProfileProvider() call", pattern: /\bacquireExecutionProfileProvider\s*\(/ },
    { label: "a findOpenSingleWriterProvider() call", pattern: /\bfindOpenSingleWriterProvider\s*\(/ },
    { label: "a withOneShotTunnel() call", pattern: /\bwithOneShotTunnel\s*\(/ },
    { label: "a removeProvider() call", pattern: /\bremoveProvider\s*\(/ },
    { label: "a createLLMProvider() call", pattern: /\bcreateLLMProvider\s*\(/ },
    { label: "a handleSchemaRequest() call", pattern: /\bhandleSchemaRequest\s*\(/ },
  ];

  // The one allowlist entry whose reason does NOT claim to be provider-free (see the doc comment
  // on ROUTES_WITHOUT_A_PROVIDER). Skipping it is itself verified below - the assertion requires
  // the entry's reason to still say so, so this set cannot quietly grow into a second unchecked
  // allowlist.
  const ALLOWLISTED_BUT_REACHES_A_PROVIDER = ["agent/drive"];

  /** Blanks out comments while preserving line numbering, so a mention in prose is not a hit. */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  test("every allowlisted route entry that claims to reach a provider still says so", () => {
    for (const key of ALLOWLISTED_BUT_REACHES_A_PROVIDER) {
      expect(ROUTES_WITHOUT_A_PROVIDER[key]).toContain("reaches a provider");
    }
  });

  test("every allowlisted route is still provider-free in its own source", () => {
    const violations: string[] = [];

    for (const key of Object.keys(ROUTES_WITHOUT_A_PROVIDER)) {
      if (ALLOWLISTED_BUT_REACHES_A_PROVIDER.includes(key)) {
        continue;
      }
      const source = withoutComments(readFileSync(join(API_ROOT_DIR, key, "route.ts"), "utf8"));
      source.split("\n").forEach((rawLine, index) => {
        // A type-only import is erased at compile time and can reach nothing at runtime.
        if (rawLine.trimStart().startsWith("import type ")) {
          return;
        }
        for (const { label, pattern } of PROVIDER_ENTRY_POINTS) {
          if (pattern.test(rawLine)) {
            violations.push(
              `"${key}" is allowlisted as provider-free but route.ts:${index + 1} contains ${label}: ${rawLine.trim()}`,
            );
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });

  // ─── The residual the check above leaves: what the route's IMPORTS reach ────
  //
  // Reading a route's own source proves it names no provider entry point itself. It does not
  // prove the module it delegates to names none either, so a route that obtained a provider
  // through a NEW indirect helper would still pass. `@/lib/api/schema-route` is the one such
  // helper that exists on the non-allowlisted side, and it is only covered above because
  // somebody thought to name it.
  //
  // Resolving the import graph transitively was measured 2026-08-27 and rejected: it flags four
  // of the fifteen allowlisted routes, all of them wrongly. The three `agent/runs/*` routes reach
  // `@/lib/agent/runtime`, which does import `@/lib/db` - but for the in-process
  // `ExecutionArtifactStore` the route reads, not for a provider; `agent/config` reaches
  // `@/lib/llm/utils/config` to validate a model id. A module-level graph cannot tell an import
  // used on this route's path from a sibling in the same file, so transitively it answers "reaches
  // a provider" for every route that touches a shared module - a guard that is red for correct
  // code teaches people to widen it.
  //
  // So the SET of indirect helpers is pinned instead. A new one cannot appear unnoticed: it has to
  // be added here with a reason, and adding it is where the judgement gets made.
  //
  // Each reason also carries whether the helper names a provider module of its own, and both
  // directions are enforced below - a helper that GROWS a provider import fails until its reason
  // says so, and a stale marker on a helper that lost one fails too, so the marker cannot rot into
  // a blanket exemption.
  const PROVIDER_NAMING_HELPER = "names a provider module";

  const ALLOWLISTED_ROUTE_HELPERS: Record<string, string> = {
    "@/hooks/use-connection-payload": "shapes a connection record for the client; opens nothing",
    "@/lib/agent/config": `reads the agent runtime's env config and ${PROVIDER_NAMING_HELPER} (@/lib/llm/utils/config) to validate the model id, which resolves config rather than calling a model`,
    "@/lib/agent/model-tuning": "the per-model tuning table; data only",
    "@/lib/agent/runtime": `the run loop, and it ${PROVIDER_NAMING_HELPER} - but the artifacts route imports only readAgentArtifact, which reads the in-process ExecutionArtifactStore`,
    "@/lib/api/agent-run-access": "resolves a run id to its ledger behind guardRoute; reads no provider",
    "@/lib/api/client-address": "parses the forwarded-for chain for the audit record",
    "@/lib/api/errors": `maps a thrown error to a response and ${PROVIDER_NAMING_HELPER} (@/lib/db/errors, @/lib/llm/types) for the error CLASSES alone - nearly every route imports it, and treating it as an entry point would fire on all fifteen`,
    "@/lib/api/rate-limit": "the in-process token buckets",
    "@/lib/api/require-session": "guardRoute itself",
    "@/lib/audit": "the in-process audit ring buffer",
    "@/lib/auth": "session cookie minting and reading",
    "@/lib/auth-compare": "constant-time credential comparison",
    "@/lib/auth-errors": "the auth failure taxonomy",
    "@/lib/local-auth": "the local email/password credential store",
    "@/lib/logger": "structured logging",
    "@/lib/oidc": "the OIDC discovery and PKCE exchange",
    "@/lib/seed": "reads seed connection metadata from config; never connects",
    "@/lib/storage/factory": "the app's own storage backend (STORAGE_PROVIDER), not a user database",
    "@/lib/storage/types": "the storage backend's interfaces",
  };

  /**
   * The `@/`-aliased modules this source imports at runtime, one level deep.
   *
   * A `from "@/…"` on a continuation line of a multi-line `import type` block reads as a runtime
   * import here. That errs toward demanding a pin entry for a module that could reach nothing,
   * which is the safe direction: the guard fails loudly rather than falling silent.
   */
  function aliasedImports(source: string): string[] {
    const specifiers = new Set<string>();

    for (const line of withoutComments(source).split("\n")) {
      if (line.trimStart().startsWith("import type ")) {
        continue;
      }
      const match = line.match(/from\s+"(@\/[^"]+)"/);
      if (match !== null) {
        specifiers.add(match[1]);
      }
    }

    return [...specifiers];
  }

  /** Where `@/x` lives on disk, or null. Both shapes are in use: `@/lib/auth`, `@/lib/seed`. */
  function resolveAliasedModule(specifier: string): string | null {
    const relative = specifier.slice("@/".length);

    for (const candidate of [`${relative}.ts`, join(relative, "index.ts")]) {
      const path = join(SRC_ROOT_DIR, candidate);
      if (existsSync(path)) {
        return path;
      }
    }

    return null;
  }

  function allowlistedRouteKeys(): string[] {
    return Object.keys(ROUTES_WITHOUT_A_PROVIDER).filter((key) => !ALLOWLISTED_BUT_REACHES_A_PROVIDER.includes(key));
  }

  test("every module an allowlisted route imports is pinned", () => {
    const unpinned: string[] = [];

    for (const key of allowlistedRouteKeys()) {
      const source = readFileSync(join(API_ROOT_DIR, key, "route.ts"), "utf8");
      for (const specifier of aliasedImports(source)) {
        if (!(specifier in ALLOWLISTED_ROUTE_HELPERS)) {
          unpinned.push(
            `"${key}" imports "${specifier}", which is not pinned: add it to ALLOWLISTED_ROUTE_HELPERS with a reason it reaches no provider on this route's path, or stop importing it`,
          );
        }
      }
    }

    expect(unpinned).toEqual([]);
  });

  // A pin nobody imports any more is the same drift as a stale allowlist key: it keeps a reason
  // alive for a path that no longer exists, and the next reader trusts it.
  test("every pinned module is still imported by an allowlisted route", () => {
    const imported = new Set(
      allowlistedRouteKeys().flatMap((key) =>
        aliasedImports(readFileSync(join(API_ROOT_DIR, key, "route.ts"), "utf8")),
      ),
    );

    expect(Object.keys(ALLOWLISTED_ROUTE_HELPERS).filter((specifier) => !imported.has(specifier))).toEqual([]);
  });

  test("every pinned module resolves to a file", () => {
    for (const specifier of Object.keys(ALLOWLISTED_ROUTE_HELPERS)) {
      expect(resolveAliasedModule(specifier), specifier).not.toBeNull();
    }
  });

  test("a pinned module's reason says whether the module names a provider module", () => {
    const wrong: string[] = [];

    for (const [specifier, reason] of Object.entries(ALLOWLISTED_ROUTE_HELPERS)) {
      const path = resolveAliasedModule(specifier);
      if (path === null) {
        continue;
      }
      const source = withoutComments(readFileSync(path, "utf8"));
      const named = source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("import type "))
        .some((line) => PROVIDER_ENTRY_POINTS.some(({ pattern }) => pattern.test(line)));
      const claimed = reason.includes(PROVIDER_NAMING_HELPER);

      if (named && !claimed) {
        wrong.push(`"${specifier}" now names a provider module; its reason has to say so and explain the path`);
      }
      if (!named && claimed) {
        wrong.push(`"${specifier}" no longer names a provider module; drop the claim from its reason`);
      }
    }

    expect(wrong).toEqual([]);
  });

  for (const [route, load] of PROVIDER_ROUTES) {
    test(`POST /api/${route} returns 401 without a session`, async () => {
      const routeModule = await load();
      const POST = routeModule.POST;
      // Narrows POST off its optional RouteModule type and doubles as its own assertion: a
      // route in PROVIDER_ROUTES that exports no POST is either missing one or belongs in the
      // allowlist above, not something this loop should silently skip.
      if (typeof POST !== "function") {
        throw new Error(`"${route}" reaches a provider but exports no POST - allowlist it or add one`);
      }

      // A non-empty body clears every route's own pre-guard "empty body" check (several parse
      // and validate the body before reaching the guard), so every route's guard is reached
      // regardless of what it validates afterward - the guard-here-blocks-everything property
      // this test proves does not depend on the request being otherwise well-formed.
      const req = new Request(`http://localhost/api/${route}`, {
        method: "POST",
        body: JSON.stringify({ probe: true }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await POST(req as never);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required" });
    });
  }
});

// Threat: a role denial that leaves no trace. guardRoute audits SESSION failures; the admin-only
// routes check the ROLE themselves, afterwards, and used to answer 403 silently - so an
// authenticated (or stolen) session probing for a role it does not hold was invisible in the one
// channel this project treats as authoritative.
//
// This lives here rather than beside each route's own tests because the assertion reads the real
// stdout line: several files under tests/api mock @/lib/audit process-wide, and nothing under
// tests/security does.
describe("an admin-only route's role denial is audited", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "bob" }));
  });

  function probe(): Request {
    return new Request("http://localhost/api/admin/fleet-health", {
      method: "POST",
      body: JSON.stringify({ connections: [] }),
      headers: { "Content-Type": "application/json" },
    });
  }

  test("POST /api/admin/fleet-health emits permission_denied with reason insufficient_role", async () => {
    const { POST } = await import("@/app/api/admin/fleet-health/route");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await POST(probe());

      expect(res.status).toBe(403);
      const lines = logSpy.mock.calls.map(
        (call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe("permission_denied");
      expect(lines[0].reason).toBe("insufficient_role");
      expect(lines[0].actor).toBe("bob");
      expect(lines[0].route).toBe("POST /api/admin/fleet-health");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("still returns 403 when that audit emit throws", async () => {
    const { POST } = await import("@/app/api/admin/fleet-health/route");
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const res = await POST(probe());

      expect(res.status).toBe(403);
    } finally {
      logSpy.mockRestore();
    }
  });
});
