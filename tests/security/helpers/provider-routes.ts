/**
 * The route inventory of the security tests: every route handler under `src/app/api/`, the routes that reach no
 * database or LLM provider with the reason for each, and the provider-reaching rest.
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
    "reads seed config metadata and the CapRover discovery export; never opens a database connection, and its only network use is a bare node:net reachability probe for built-image candidates when SEED_DISCOVERY_PATH is set (GET, no POST export)",
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
