import type { DatabaseConnection, SSHTunnelConfig, SSLConfig } from "@/lib/types";

/** A seed connection as `GET /api/connections/managed` serializes it. */
export type ManagedConnectionPayload = Omit<DatabaseConnection, "createdAt"> & { createdAt: string; seedId?: string };

/**
 * The `reason` `GET /api/connections/managed` puts on its 500 when the failure was its
 * own seed configuration rather than anything else in the request.
 *
 * A bare 500 says only "this request failed", and a browser reading that cannot tell it
 * from "the server serves no seeds" — which is a legitimate answer, and the one a
 * default deployment gets when no seed file exists. Naming the failure is what lets the
 * client hold "I do not have the seed list" instead of "the list is empty" (B37).
 */
export const SEED_CONFIG_UNREADABLE_REASON = "seed-config-unreadable";

/**
 * What the browser knows about the server's seed list.
 *
 * Deliberately not an array: an array has no way to say "I do not have it", so a load
 * that failed becomes an empty list, and an empty list is a real answer. Everything
 * downstream then draws a conclusion from an absence it cannot distinguish from a
 * failure. The load state is part of the value so that no caller can forget to ask.
 */
export type ServedSeeds =
  | { readonly loaded: true; readonly seeds: readonly ManagedConnectionPayload[] }
  | { readonly loaded: false };

/** The seed list before anything has been served: loaded, and genuinely empty. */
export const NO_SERVED_SEEDS: ServedSeeds = { loaded: true, seeds: [] };

/**
 * Why a connection has no id a run may be started on.
 *
 * - `browser-only` — the server cannot rebuild this connection: it has never heard of
 *   it, or it holds a seed of this id that reaches somewhere else. The settings that
 *   decide where it points live in this browser.
 * - `seed-config-unreadable` — the server could not read its own seed configuration, so
 *   nothing is known about what it can rebuild. Nothing has been established about this
 *   connection at all.
 */
type UnresolvableConnectionReason = "browser-only" | typeof SEED_CONFIG_UNREADABLE_REASON;

/** The id a run may be started on, or the reason there is none. */
export type AgentRunConnection =
  | { readonly id: string; readonly reason?: undefined }
  | { readonly id: null; readonly reason: UnresolvableConnectionReason };

/**
 * Builds the connection portion of an API request body.
 * For managed connections: sends { connectionId: "seed:X" } (no credentials).
 * For user connections: sends { connection: conn } (full object).
 */
export function buildConnectionPayload(
  conn: DatabaseConnection,
): { connectionId: string } | { connection: DatabaseConnection } {
  if (conn.managed && conn.seedId) {
    return { connectionId: `seed:${conn.seedId}` };
  }
  return { connection: conn };
}

/**
 * Whether a field decides WHICH database a connection reaches and as whom, or only
 * how the connection is presented.
 *
 * `Record<keyof T, ...>` rather than a list of names, for the reason
 * `connection-secrets.ts` gives about credentials: a list fails silently. Add a field
 * to `DatabaseConnection`, `SSLConfig` or `SSHTunnelConfig` and these literals stop
 * satisfying their type until it is classified, so the failure mode is `bun run
 * typecheck`, not a run that quietly investigates the wrong database.
 *
 * `nested` marks a container whose own map carries the classification — "it is a
 * container" and "nobody thought about it" are different answers.
 */
type FieldRelevance = "resolution" | "cosmetic" | "nested";

const CONNECTION_RELEVANCE: Record<keyof DatabaseConnection, FieldRelevance> = {
  // Identity in the list, not in the database: two connections reaching the same
  // place under different names still reach the same place.
  id: "cosmetic",
  name: "cosmetic",
  color: "cosmetic",
  group: "cosmetic",
  environment: "cosmetic",
  createdAt: "cosmetic",
  // Both sides of a comparison are already matched on seedId, and `managed` is what
  // selects the comparison rather than a term in it.
  managed: "cosmetic",
  seedId: "cosmetic",
  type: "resolution",
  host: "resolution",
  port: "resolution",
  user: "resolution",
  password: "resolution",
  database: "resolution",
  connectionString: "resolution",
  serviceName: "resolution",
  instanceName: "resolution",
  // Which data centre the driver balances against. It decides which NODES a
  // statement reaches, and a wrong value refuses the connection outright, so two
  // connections differing only here are not the same connection.
  localDataCenter: "resolution",
  // Which database the credentials are checked against. A copy that authenticates
  // somewhere else is authenticating as a different principal, so it does not resolve
  // to the same connection.
  authSource: "resolution",
  // The role a run executes as. A copy that carries its own is a different execution
  // profile even when it points at the same database (#328).
  agentUser: "resolution",
  agentPassword: "resolution",
  ssl: "nested",
  sshTunnel: "nested",
};

// Every transport field changes whether, and to what, a connection actually connects.
const SSL_RELEVANCE: Record<keyof SSLConfig, FieldRelevance> = {
  mode: "resolution",
  rejectUnauthorized: "resolution",
  caCert: "resolution",
  clientCert: "resolution",
  clientKey: "resolution",
};

const SSH_TUNNEL_RELEVANCE: Record<keyof SSHTunnelConfig, FieldRelevance> = {
  enabled: "resolution",
  host: "resolution",
  port: "resolution",
  username: "resolution",
  authMethod: "resolution",
  password: "resolution",
  privateKey: "resolution",
  passphrase: "resolution",
};

/** Derived, never written out twice: a second hand-maintained list is a second thing that drifts. */
function resolutionKeysOf(map: Record<string, FieldRelevance>): string[] {
  return Object.keys(map).filter((key) => map[key] === "resolution");
}

const CONNECTION_RESOLUTION_KEYS = resolutionKeysOf(CONNECTION_RELEVANCE);
const SSL_RESOLUTION_KEYS = resolutionKeysOf(SSL_RELEVANCE);
const SSH_TUNNEL_RESOLUTION_KEYS = resolutionKeysOf(SSH_TUNNEL_RELEVANCE);

function sameFields(a: object, b: object, keys: readonly string[]): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return keys.every((key) => left[key] === right[key]);
}

/** A container present on one side only is a difference, not an empty one. */
function sameContainer(a: unknown, b: unknown, keys: readonly string[]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameFields(a as object, b as object, keys);
}

function reachesSameDatabase(conn: DatabaseConnection, served: ManagedConnectionPayload): boolean {
  return (
    sameFields(conn, served, CONNECTION_RESOLUTION_KEYS) &&
    sameContainer(conn.ssl, served.ssl, SSL_RESOLUTION_KEYS) &&
    sameContainer(conn.sshTunnel, served.sshTunnel, SSH_TUNNEL_RESOLUTION_KEYS)
  );
}

/**
 * The id a run may be STARTED on, or the reason there is none — the server cannot
 * re-resolve this connection to the same database later, or it could not read its own
 * seed configuration and so nothing has been established either way (B37).
 *
 * A different question from `buildConnectionPayload`, which asks how to send a
 * connection ONCE and may hand the server the whole object. A run persists an id and
 * no credential, so whatever it stores has to still mean the same database after a
 * restart — an object the browser holds is not something a resumed run can rebuild.
 *
 * The two answers coincide for a managed connection (the server's copy is
 * authoritative and the UI is read-only) and for one the user typed in (the server
 * has never heard of it). They diverge for the editable copy of a seed, which is what
 * a zero-config deployment ships: the server WILL resolve `seed:<id>`, but to its own
 * descriptor — so the copy may be started by id exactly while it still matches. Once
 * the user edits it to point somewhere else, starting a run by id would investigate
 * the seed's database and report on it as if it were the one on screen.
 */
export function resolveAgentRunConnectionId(conn: DatabaseConnection, servedSeeds: ServedSeeds): AgentRunConnection {
  if (!conn.seedId) return { id: null, reason: "browser-only" };
  if (conn.managed) return { id: `seed:${conn.seedId}` };

  // An unread seed list is not an empty one (B37). Comparing against seeds nobody has
  // seen would answer "the server does not hold this" from having asked nothing, which
  // is wrong for exactly the connections this application seeds itself — and it points a
  // user at their own settings while the server's own configuration is what failed.
  if (!servedSeeds.loaded) return { id: null, reason: SEED_CONFIG_UNREADABLE_REASON };

  const served = servedSeeds.seeds.find((seed) => seed.seedId === conn.seedId);
  if (served === undefined) return { id: null, reason: "browser-only" };

  return reachesSameDatabase(conn, served) ? { id: `seed:${conn.seedId}` } : { id: null, reason: "browser-only" };
}
