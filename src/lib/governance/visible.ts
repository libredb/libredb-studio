/**
 * Which connections a caller may see and open (docs/GOVERNANCE.md#grants-and-the-connection-list): the one dispatcher
 * `GET /api/connections/managed` and `resolveConnection` ask, so the list a browser shows and the connection a route
 * opens can never disagree.
 *
 * Without governance it answers from `getSeedListing`: the seed connections the caller's role may see, in their order,
 * with the rows only the Kubernetes access review may list (`pendingReview`, each naming its Kubernetes Secret) handed
 * to the review in their place and kept only where it lets the caller use them (src/lib/kubernetes-access/gate.ts). No
 * other row is ever reviewed, an open reviews only the row it names, and an id no section holds sends no review; the
 * options change nothing.
 *
 * Under governance (`GOVERNANCE_SOURCE`, docs/GOVERNANCE.md) it answers from the governance snapshot alone, for the
 * identity provider subject of the session:
 *
 * - A connection is visible only while the subject holds an effective grant on it, and `expires_at` is checked again
 *   against Studio's own clock at every call, because expiry fires no notification.
 * - The role decides nothing: an admin sees only its own grants, because the admin role toggles the admin pages and
 *   maintenance only. A session without a subject holds no grant.
 * - A record carries one credential: the one of the grant's level by default, or always the read credential with
 *   `credential: "read"`, which the agent, MCP, classification and handover paths ask for. It carries the statement
 *   timeout of governed connections, the runtime setting `query.timeoutMs`, and the server-only markers `literal`, so
 *   no `${NAME}` or Vault reference in a value the control plane set is ever resolved, and `grantLevel`, the level of
 *   the credential it carries. The managed route removes both before anything reaches the browser.
 * - A connection that does not exist and one granted to another subject are the same miss: only the caller's own
 *   grants are read, so nothing here can tell a caller which ids exist.
 * - While the snapshot cannot be served (docs/GOVERNANCE.md#freshness-and-readiness), every call throws
 *   `GovernanceUnavailableError`, which the routes answer with 503 GOVERNANCE_UNAVAILABLE, never with an empty list a
 *   browser would read as "nothing granted".
 *
 * Like `state.ts` and `freshness.ts`, this module imports no `pg`: it reads the snapshot the loader swapped in.
 */
import { ApiErrorCode } from "@/lib/api/error-codes";
import { connectionsUnderAccessReview, connectionUnderAccessReview } from "@/lib/kubernetes-access/gate";
import { getSeedListing, seedRolesOf, type ManagedConnection } from "@/lib/seed";
import { governanceEnabled } from "./config";
import { governanceServable } from "./freshness";
import { runtimeSetting } from "./settings";
import { type EffectiveGrant, effectiveGrant, type GovernanceSnapshot, governanceState } from "./state";

/** Who asks: the session's role and username, and the identity provider subject that grants name under governance. */
export interface Principal {
  readonly role: string;
  readonly username: string;
  readonly idpSubject?: string;
  /** The identity provider's issuer, which keys the Kubernetes access review's groups record with the subject. */
  readonly idpIssuer?: string;
  readonly claimRoles?: readonly string[];
}

export interface VisibilityOptions {
  /**
   * Which credential a governed record carries: `grant`, the default, the one of the caller's grant level, for the
   * editor routes; `read`, always the read credential whatever the grant. Without governance it changes nothing.
   */
  readonly credential?: "grant" | "read";
}

/** A governed connection as it reaches a route: the record of one credential level, with the server-only markers. */
export interface GovernedConnection extends ManagedConnection {
  readonly literal: true;
  /** The level of the credential this record carries. Server-only: the managed route removes it. */
  readonly grantLevel: EffectiveGrant["level"];
}

/** The sentence of every refusal while the snapshot cannot be served. */
export const GOVERNANCE_UNAVAILABLE_MESSAGE =
  "Connection access is unavailable while this server cannot read its governance source";

/**
 * The snapshot cannot be served: it is still loading, older than GOVERNANCE_MAX_STALENESS_MS, or the latest load found
 * the governance source misconfigured or incompatible. Its status and code are what every route answers with.
 */
export class GovernanceUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = ApiErrorCode.GOVERNANCE_UNAVAILABLE;

  constructor() {
    super(GOVERNANCE_UNAVAILABLE_MESSAGE);
    this.name = "GovernanceUnavailableError";
  }
}

/**
 * The statement timeout of a governed connection when the control plane set no valid `query.timeoutMs`: the default of
 * that runtime setting (docs/GOVERNANCE.md#runtime-settings). A definition may not set `queryTimeout` (row admission),
 * so a control plane sets it for every governed connection at once and never per connection.
 */
const GOVERNED_QUERY_TIMEOUT_MS = 60_000;

/** The snapshot to answer from at `nowMs`, or the error every caller answers with while it cannot be served. */
function servableSnapshot(nowMs: number): GovernanceSnapshot {
  const { snapshot } = governanceState();
  if (!governanceServable(nowMs) || snapshot === null) throw new GovernanceUnavailableError();
  return snapshot;
}

/** The subject grants name for this principal, or undefined when its session carries none. */
const subjectOf = ({ idpSubject }: Principal): string | undefined =>
  typeof idpSubject === "string" && idpSubject !== "" ? idpSubject : undefined;

/** The record a grant hands out: a copy, so no caller can change the snapshot it came from. */
function projection(grant: EffectiveGrant, options: VisibilityOptions): GovernedConnection {
  const level = options.credential === "read" ? "read" : grant.level;
  const record = level === "write" ? grant.connection.write : grant.connection.read;
  if (record === undefined) {
    // The loader grants write only where this instance opened the write envelope, so only a broken snapshot gets here.
    throw new Error(
      `The governance snapshot grants write on connection "${grant.connection.id}", which has no write credential`,
    );
  }
  // Read at every projection, so a changed value applies to the next statement a route opens the record for.
  const queryTimeout = runtimeSetting("query.timeoutMs") ?? GOVERNED_QUERY_TIMEOUT_MS;
  return { ...record, queryTimeout, literal: true, grantLevel: level };
}

/** By name, then by id: the governance source returns its rows in no particular order. */
const byNameThenId = (a: ManagedConnection, b: ManagedConnection): number =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The connections `principal` may see: with governance off the seed connections of its role that the Kubernetes access
 * review lets it use, and under governance the connections its subject holds an unexpired grant on, by name.
 */
export async function visibleConnections(
  principal: Principal,
  options: VisibilityOptions = {},
): Promise<ManagedConnection[]> {
  if (!governanceEnabled()) {
    const { before, pendingReview, after } = await getSeedListing(seedRolesOf(principal));
    return [...before, ...(await connectionsUnderAccessReview(principal, pendingReview)), ...after];
  }
  const nowMs = Date.now();
  const snapshot = servableSnapshot(nowMs);
  const subject = subjectOf(principal);
  if (subject === undefined) return [];
  return [...(snapshot.grants.get(subject)?.keys() ?? [])]
    .flatMap((id) => {
      const grant = effectiveGrant(snapshot, subject, id, nowMs);
      return grant === undefined ? [] : [projection(grant, options)];
    })
    .sort(byNameThenId);
}

/**
 * The connection `id` (without the `seed:` prefix) as `principal` may open it, or null: with governance off the seed
 * connection its role may see and the Kubernetes access review lets it use, and under governance the connection its
 * subject holds an unexpired grant on.
 */
export async function visibleConnectionById(
  principal: Principal,
  id: string,
  options: VisibilityOptions = {},
): Promise<ManagedConnection | null> {
  if (!governanceEnabled()) {
    const { before, pendingReview, after } = await getSeedListing(seedRolesOf(principal));
    const listed = [...before, ...after].find((connection) => connection.seedId === id);
    if (listed !== undefined) return listed;
    return connectionUnderAccessReview(principal, pendingReview.find((connection) => connection.seedId === id) ?? null);
  }
  const nowMs = Date.now();
  const snapshot = servableSnapshot(nowMs);
  const subject = subjectOf(principal);
  const grant = subject === undefined ? undefined : effectiveGrant(snapshot, subject, id, nowMs);
  return grant === undefined ? null : projection(grant, options);
}
