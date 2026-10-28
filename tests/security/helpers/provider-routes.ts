/**
 * The route inventory of the security tests: every route handler under `src/app/api/`, the routes that reach no
 * database or LLM provider with the reason for each, and the provider-reaching rest, split into the routes that turn a
 * request body into a connection and the others, each with its reason.
 *
 * Moved unchanged out of tests/security/route-auth.test.ts, which proves every provider route requires a session, so
 * the governance security tests share the same inventory instead of keeping a second one that could drift from it.
 */
import { join } from "node:path";
import { discoverRoutes } from "./discover-routes";

// Enumerated from disk instead of hardcoded, so a route added ANYWHERE under src/app/api/ is
// checked automatically instead of silently escaping route-auth.test.ts. This replaces a curated
// GUARDED_ROUTES list (AI routes discovered dynamically, plus one hand-picked db/ entry) that
// was itself an instance of the exact failure it was trying to prevent: it never covered
// db/query, db/multi-query, db/transaction, db/maintenance, db/cancel, db/health,
// db/monitoring, db/pool-stats, db/profile, db/provider-meta, db/schema, db/schema/list,
// db/schema/relations, db/schema-snapshot, db/test-connection or admin/fleet-health - eleven of
// which reached a database provider through a bare inline getSession() with no rate limit and
// no denial audit, sitting undetected next to routes that had already been fixed. Walking the
// whole tree and requiring an explicit reason for every exemption is what makes a newly added
// provider-reaching route red by default instead of invisible by default.
export const SRC_ROOT_DIR = join(import.meta.dir, "..", "..", "..", "src");
export const API_ROOT_DIR = join(SRC_ROOT_DIR, "app", "api");

export const ALL_ROUTES = discoverRoutes(API_ROOT_DIR);

/**
 * Every route that legitimately reaches no database or LLM provider, so the enumeration in
 * route-auth.test.ts does not require it to call guardRoute. Every entry needs a reason: an
 * unexplained addition here is exactly the hand-maintained-inventory drift this enumeration exists
 * to prevent, and the sanity check there fails if a key does not match a route that actually exists.
 *
 * Two entries (`agent/drive` and `mcp`) are NOT in that category and say so in their own reasons:
 * each does reach a provider, and each is exempt from THIS enumeration only because the
 * enumeration probes with a POST carrying no credential and asserts guardRoute's exact 401 body.
 * Neither takes a user session. `agent/drive` is the durable transport's callback and verifies a
 * server-minted single-purpose credential, proven in tests/api/agent/drive.test.ts; `mcp` is
 * called by an MCP client of the user's own and verifies a scoped bearer token, because a session
 * cookie must not open a machine API, proven in tests/security/mcp-auth.test.ts. An exemption
 * whose reason is a different verified control is the only kind allowed here; "it has no auth"
 * never is.
 */
export const ROUTES_WITHOUT_A_PROVIDER: Record<string, string> = {
  "admin/accounts":
    "reads and writes the app's own account registry on the storage backend (STORAGE_PROVIDER), not a user database or LLM provider",
  "admin/accounts/[email]":
    "same account registry as admin/accounts, one account at a time (PATCH and DELETE, no POST export)",
  "admin/audit": "reads/writes the in-process audit ring buffer only; no database or LLM provider",
  "admin/discovery":
    "reads the CapRover discovery status for the admin Overview card: an export file on disk, plus a bare TCP reachability probe for built-image candidates, and never a database or LLM provider (GET, no POST export). It still calls guardRoute with the query bucket and answers 403 to a non-admin (tests/api/admin/discovery.test.ts)",
  "admin/governance":
    "reads the governance status for the admin Overview card: the in-process governance state, the process environment and the keyring file, and never a database or LLM provider or the governance source itself (GET, no POST export). It still calls guardRoute with the query bucket and answers 403 to a non-admin (tests/api/admin/governance.test.ts)",
  "admin/seed-sources":
    "reads the operator seed sources' status for the admin Overview card: seed files on disk and the process environment, and never a database or LLM provider (GET, no POST export). It still calls guardRoute with the query bucket and answers 403 to a non-admin (tests/api/admin/seed-sources.test.ts)",
  "agent/config":
    "answers whether the agent runtime is enabled, from process.env alone; no database or LLM provider (GET, no POST export). It still requires a session — a bare getSession() like connections/managed, because metering a visibility probe out of the ai bucket would spend a run's budget on rendering a panel — and tests/api/agent/config.test.ts proves an unauthenticated caller learns nothing about the flag",
  "agent/drive":
    "reaches a provider, but is the durable transport's callback and can have no user session: it verifies a server-minted single-purpose credential and its 401 body differs from guardRoute's on purpose (tests/api/agent/drive.test.ts)",
  "agent/runs/[runId]":
    "reads, cancels, pauses and resumes one run's own durable ledger; the resume action drives the run in-process, which reaches a provider, but the route still requires a session (guardRoute, through src/lib/api/agent-run-access.ts)",
  "agent/runs/[runId]/artifacts/[correlationId]":
    "hands back rows one run already stored, from process memory; no database or LLM provider is reached to answer it (GET, no POST export). Same guardRoute path as above, through src/lib/api/agent-run-access.ts, and tests/api/agent/artifacts.test.ts proves an unauthenticated caller gets 401 and reads nothing",
  "agent/runs/[runId]/stream":
    "follows one run's own durable ledger; no database or LLM provider (GET, no POST export). Same guardRoute path as above",
  "auth/launch": "exchanges a platform launch token for a session; a session cannot be required before one exists",
  "auth/login": "authenticates the credential itself; a session cannot be required before one exists",
  "auth/totp":
    "enrols a TOTP secret on the caller's own stored account; the storage backend is not a user database or LLM provider",
  "auth/passkey":
    "manages passkeys on the caller's own stored account (list, register, rename, remove); the storage backend is not a user database or LLM provider",
  "auth/passkey/sign-in": "authenticates a passkey assertion itself; a session cannot be required before one exists",
  "auth/logout": "clears the session cookie unconditionally; touches no provider either way",
  "auth/me": "reads the caller's own session claims only (GET, no POST export)",
  "auth/oidc/callback": "completes the OIDC exchange that CREATES the session (GET, no POST export)",
  "auth/oidc/login": "starts the OIDC redirect before a session exists (GET, no POST export)",
  "connections/managed":
    "reads seed config metadata and the CapRover discovery export, or under governance the in-process governance snapshot; never opens a database connection, and its only network use is a bare node:net reachability probe for built-image candidates when SEED_DISCOVERY_PATH is set and, with KUBERNETES_ACCESS_REVIEW on, one SubjectAccessReview to the Kubernetes API per connection that names its Kubernetes Secret (GET, no POST export)",
  "connections/policy":
    "answers whether custom connections are allowed, from process.env alone (ALLOW_CUSTOM_CONNECTIONS); no database or LLM provider (GET, no POST export). It requires a session, a bare getSession() answering the session-required 401 like connections/managed, and tests/api/seed/policy-route.test.ts proves an unauthenticated caller learns nothing about the policy",
  health:
    "liveness only: returns a fixed body and touches nothing, so there is no provider to require a session for (GET, no POST export). The connection-scoped check is POST /api/db/health, which is not on this list",
  mcp: "reaches a provider, but is called by an MCP client of the user's own and verifies a scoped bearer token instead of a session (src/lib/mcp/bearer.ts): its 401 body differs from guardRoute's on purpose, and tests/security/mcp-auth.test.ts proves that no refused identity constructs a provider",
  ready:
    "readiness only, public because an orchestrator's probe carries no session: answers from the in-process governance state and never opens a user database or an LLM provider (GET, no POST export). Under governance a probe that finds no usable snapshot asks the governance source for a single-flight load without waiting for it, which is the refresher's own read and never a user database (tests/api/ready.test.ts)",
  storage: "reaches the app's own storage backend (STORAGE_PROVIDER), not a user database or LLM provider (GET only)",
  "storage/[collection]": "same storage backend as above, scoped to the caller's own data (PUT, no POST export)",
  "storage/config": "publicly documents whether server storage is enabled; no session, no provider (GET only)",
  "storage/migrate": "same storage backend as above; its own 401 body differs from guardRoute's on purpose",
};

export const PROVIDER_ROUTES = ALL_ROUTES.filter(([key]) => !(key in ROUTES_WITHOUT_A_PROVIDER));

/**
 * The provider routes that pass the request body to `resolveConnection`, directly or through `handleObjectRequest` in
 * src/lib/api/object-route.ts, each with a minimal well-formed body: the fields the route reads beside the
 * connection. A test adds a `connectionId` or an inline `connection` to it, so every route that turns a request into
 * a connection is sent both, and the inventory test in tests/security/governance-grants.test.ts fails until a new
 * provider route is classified here or in `PROVIDER_ROUTES_WITHOUT_A_CONNECTION_BODY`.
 */
export const CONNECTION_ROUTES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "db/cancel": { queryId: "governance-probe" },
  "db/health": {},
  "db/keys/scan": { cursor: "0" },
  "db/maintenance": { type: "analyze", target: "orders" },
  "db/maintenance/preview": { type: "analyze", target: "orders" },
  "db/monitoring": {},
  "db/multi-query": { sql: "SELECT 1; SELECT 2" },
  "db/objects/containers": {},
  "db/objects/counts": { container: ["public"] },
  "db/objects/describe": { path: ["public", "orders"], kind: "table" },
  "db/objects/edit-apply": { plan: { kind: "view" }, planToken: "governance-probe" },
  "db/objects/edit-plan": { path: ["public", "orders_view"], kind: "view", partId: "definition", text: "SELECT 1" },
  "db/objects/inventory": {},
  "db/objects/list": { container: ["public"], kind: "table" },
  "db/objects/search": { term: "orders" },
  "db/objects/source": { path: ["public", "orders_view"], kind: "view" },
  "db/pool-stats": {},
  "db/profile": { tablePath: ["public", "orders"], columns: ["id"] },
  "db/provider-meta": {},
  "db/query": { sql: "SELECT 1" },
  "db/test-connection": {},
  "db/transaction": { action: "begin" },
};

/**
 * Every other provider route, with the reason it passes no request body to `resolveConnection`. An entry needs a
 * reason, as `ROUTES_WITHOUT_A_PROVIDER` does, and the inventory test fails when an entry names no provider route.
 */
export const PROVIDER_ROUTES_WITHOUT_A_CONNECTION_BODY: Readonly<Record<string, string>> = {
  "admin/fleet-health":
    "resolves each item of its `connections` list through resolveConnection on its own and reports a refusal as that item's error, so it never answers one connection's refusal for the whole request (tests/api/admin/fleet-health.test.ts)",
  "agent/classify":
    "takes only a connectionId, which it resolves as a seed id, never an inline connection; under governance it answers as with the agent switched off (tests/security/governance-holds.test.ts)",
  "agent/runs":
    "takes only a connectionId, which it resolves as a seed id, never an inline connection; under governance it answers as with the agent switched off (tests/security/governance-holds.test.ts)",
  "agent/runs/[runId]/handover":
    "resolves only the connectionId the run recorded, under the run's own actor, and reads no connection from the request; under governance it answers as with the agent switched off (tests/security/governance-holds.test.ts)",
  "ai/describe-schema": "reaches only an LLM: the schema it describes arrives as text, and no connection is resolved",
  "ai/explain": "reaches only an LLM: the statement and the plan arrive as text, and no connection is resolved",
  "ai/query-safety": "reaches only an LLM: the statement arrives as text, and no connection is resolved",
  "db/disconnect":
    "builds none, and under governance resolves no connection: it removes only the caller's own cached providers of the connection id it names, which needs no grant; without governance it resolves a connection of the user's own only to name the cache entries it removes, the editor's and the execution profiles' of that record (tests/api/db/disconnect.test.ts)",
  "mcp/token":
    "mints an MCP token for the session's own user and takes no connection; under governance MCP is held off, so it mints none (tests/unit/mcp/config.test.ts)",
};
