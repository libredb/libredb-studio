/**
 * The governance state of this process (spec 7.4, 7.5): the snapshot of the last successful load of the governance
 * source, and why the latest load failed when it did.
 *
 * `snapshot.ts` loads the source and swaps each new snapshot in here at once, as one new state object, so a reader
 * sees the old snapshot or the new one and never a mix. `freshness.ts` derives from this state whether data routes
 * may be served, and the routes, the session check and the admin status read it.
 *
 * The module holds data only: it imports no `pg`, no Node built-in and no other governance module at run time, so
 * any module can read the state without pulling the governance pool into its graph.
 */
import type { AdmissionSkip, AdmittedConnection } from "./admission";
import type { SNAPSHOT_READS } from "./contract";
import type { EnvelopeCode } from "./hpke";
import type { RuntimeSettings } from "./settings";

/** A row of one snapshot read, as the governance source returned it: every column Studio reads, none trusted yet. */
type RowOf<Name extends (typeof SNAPSHOT_READS)[number]["object"]> = Readonly<
  Record<Extract<(typeof SNAPSHOT_READS)[number], { readonly object: Name }>["columns"][number], unknown>
>;

/** A row of `settings_v1`, as read: the settings store validates it against the registry. */
export type SettingRow = RowOf<"settings_v1">;

/** A row of `seal_canary_v1`, as read: the loader opens its envelope. */
export type CanaryRow = RowOf<"seal_canary_v1">;

/** What the canary of one key id gave: `ok`, or the code its envelope failed with (spec 8.4). */
export type CanaryResult = "ok" | EnvelopeCode;

/** What one subject may do on one admitted connection. */
export interface EffectiveGrant {
  readonly connection: AdmittedConnection;
  /** `write` only where the grant row says write and this instance opened the connection's write envelope. */
  readonly level: "read" | "write";
  /** When this level stops, in epoch milliseconds, or null when it does not. Checked at every decision. */
  readonly expiresAt: number | null;
}

/** One consistent read of the governance source. */
export interface GovernanceSnapshot {
  /** When the load that read it started, in epoch milliseconds: its data is at least this recent. */
  readonly loadedAt: number;
  /** The contract version in use: the highest one both Studio and the governance source publish. */
  readonly contractVersion: number;
  /** Every contract version the governance source publishes, ascending. */
  readonly publishedVersions: readonly number[];
  /** The admitted connections by id. */
  readonly connections: ReadonlyMap<string, AdmittedConnection>;
  /** The rows, and write levels of rows, that admission left out. */
  readonly skipped: readonly AdmissionSkip[];
  /** The effective grants by subject, then by connection id. */
  readonly grants: ReadonlyMap<string, ReadonlyMap<string, EffectiveGrant>>;
  /** The latest `revoked_before` of each subject, in epoch milliseconds. */
  readonly revocations: ReadonlyMap<string, number>;
  /** The valid runtime settings, and the keys the settings store ignored. */
  readonly settings: RuntimeSettings;
  /** The result of the canary of each key id with one, as the heartbeat and the admin status report it. */
  readonly canary: Readonly<Record<string, CanaryResult>>;
}

/** Why a load failed, as freshness, the log and the admin status report it. */
export interface LoadFailure {
  /** When the load failed, in epoch milliseconds. */
  readonly at: number;
  /**
   * `misconfigured` and `incompatible` stop data routes at once. A `transient` failure, such as an outage, leaves the
   * state to the age of the last snapshot.
   */
  readonly kind: "transient" | "misconfigured" | "incompatible";
  /** The SQLSTATE or the driver's error code when the failure carries one. */
  readonly code: string | null;
  /** One line that names the cause: the object or privilege, or both version sets. Never a value or a credential. */
  readonly detail: string;
  /**
   * The cause in Studio's own words only, for the public readiness route: the contract object and its SQLSTATE, the
   * keyring variable, or both version sets. Never a server or file system message, which can carry paths and role
   * names; those stay in `detail`, which only the log carries.
   */
  readonly publicDetail: string;
}

export interface GovernanceState {
  /** The snapshot of the last successful load, kept even when a later load failed. */
  readonly snapshot: GovernanceSnapshot | null;
  /** Why the latest load failed, or null when it succeeded or none has run. */
  readonly failure: LoadFailure | null;
}

const NOTHING_LOADED: GovernanceState = Object.freeze({ snapshot: null, failure: null });

/**
 * Where the state lives. Next.js bundles instrumentation, which starts the loads, apart from each route handler, so a
 * module-level variable would hold one state per bundle; a global under a registered symbol holds one per process
 * (src/lib/governance/keyring.ts does the same).
 */
const STATE_KEY = Symbol.for("libredb-studio.governance-state");

type StateHolder = { [STATE_KEY]?: GovernanceState };

export function governanceState(): GovernanceState {
  return (globalThis as StateHolder)[STATE_KEY] ?? NOTHING_LOADED;
}

/** Swaps in the snapshot of a successful load, and clears the failure of the load before it. */
export function recordGovernanceSnapshot(snapshot: GovernanceSnapshot): void {
  (globalThis as StateHolder)[STATE_KEY] = Object.freeze({ snapshot, failure: null });
}

/** Records why the latest load failed, and keeps the last snapshot for the admin status. */
export function recordGovernanceFailure(failure: LoadFailure): void {
  (globalThis as StateHolder)[STATE_KEY] = Object.freeze({ snapshot: governanceState().snapshot, failure });
}

/** Test seam: forgets every load, as a new process would. */
export function resetGovernanceState(): void {
  delete (globalThis as StateHolder)[STATE_KEY];
}

/**
 * What `subject` may do on `connectionId` at `nowMs`, or undefined when nothing: no grant, a connection that was not
 * admitted, or a grant whose `expires_at` has passed by the caller's clock. Expiry fires no notification, so every
 * decision checks it again instead of relying on a reload.
 */
export function effectiveGrant(
  snapshot: GovernanceSnapshot,
  subject: string,
  connectionId: string,
  nowMs: number,
): EffectiveGrant | undefined {
  const grant = snapshot.grants.get(subject)?.get(connectionId);
  if (grant === undefined || (grant.expiresAt !== null && grant.expiresAt <= nowMs)) return undefined;
  return grant;
}
