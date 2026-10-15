/**
 * The governance snapshot loader (spec 7.4): one consistent read of the governance source, swapped into the state
 * holder at once.
 *
 * A load runs the statements `buildSnapshotStatements()` builds, in one `REPEATABLE READ, READ ONLY` transaction on
 * one client of the governance pool, under a deadline of 20 s for the whole load. It reads `contract` first and stops
 * there, ending the transaction with COMMIT, when no contract version is common to Studio and the governance source,
 * so it never touches a `_v1` object of a version it cannot read.
 *
 * The rows of `connections_v1` go through admission (`admission.ts`), which opens their envelopes with this
 * process's keyring. Each grant row on an admitted connection becomes the effective grant of its subject: `write` only
 * where the row says write and this instance opened the write envelope, and `read` otherwise, with its `expires_at`
 * kept for a check at every decision (`effectiveGrant()` in `state.ts`). Revocations are kept as the latest
 * `revoked_before` of each subject, and the settings rows as read, for the store that checks them.
 *
 * Every load also opens the seal canary of each key id (spec 8.4): the envelope of `{"user":"libredb-canary"}` that the
 * control plane sealed for connection `canary`, level `read`, engine `canary` and definition `{}`. The snapshot keeps
 * `ok` or the envelope's code for each kid, which the heartbeat and the admin status report, so a control plane that
 * seals to a wrong public key shows up before its first real connection.
 *
 * A grant or revocation row that breaks a rule the contract publishes for its view grants or revokes nothing and is
 * counted in a log line, as a governance source that breaks a CHECK hands Studio a row it skips. Two rows for one
 * subject and connection grant nothing either, because Studio cannot tell which one the control plane meant.
 *
 * A load never throws: it records the new snapshot, or why it failed (`freshness.ts`), and the process keeps running
 * through any outage. Nothing it logs carries a value, a credential or an envelope.
 */
import type { PoolClient } from "pg";
import { logger } from "@/lib/logger";
import { type AdmissionSkip, type AdmittedConnection, admitConnectionRows, type ConnectionRow } from "./admission";
import { governanceAllowedEngines, governancePostgresSchema } from "./config";
import { buildSnapshotStatements, type SNAPSHOT_READS, SUPPORTED_CONTRACT_VERSIONS } from "./contract";
import { withGovernanceClient } from "./db";
import { IncompatibleContractError, KeyringUnavailableError, loadFailureOf, SnapshotReadError } from "./freshness";
import { governanceKeyring } from "./keyring";
import { SealedSecretError, type SecretBinding } from "./lsb1";
import { openGovernedSecret } from "./secrets";
import {
  type CanaryResult,
  type CanaryRow,
  type EffectiveGrant,
  type GovernanceSnapshot,
  type GovernanceState,
  governanceState,
  recordGovernanceFailure,
  recordGovernanceSnapshot,
  type SettingRow,
} from "./state";

/** The deadline of one whole load, from asking the pool for a connection to COMMIT (spec 7.4). */
const LOAD_DEADLINE_MS = 20_000;

/** The longest subject the contract admits: the CHECK on `subject` in `grants_v1` and `session_revocations_v1`. */
const SUBJECT_MAX_LENGTH = 512;

const ROUTE = "governance/snapshot";

/** The binding every canary is sealed for (spec 8.4). */
const CANARY_BINDING: SecretBinding = { connectionId: "canary", level: "read", engine: "canary", definition: {} };
/** The user a canary carries, and nothing else. */
const CANARY_USER = "libredb-canary";
/** The CHECK on `kid` in `seal_canary_v1`, the form of a key id (spec 8.1). */
const KID = /^[0-9a-f]{16}$/;

type Row = Readonly<Record<string, unknown>>;

/** What a load read from a governance source whose contract it can read. */
interface SourceRows {
  readonly contractVersion: number;
  readonly publishedVersions: readonly number[];
  readonly connections: readonly ConnectionRow[];
  readonly grants: readonly Row[];
  readonly settings: readonly SettingRow[];
  readonly revocations: readonly Row[];
  readonly canaries: readonly CanaryRow[];
}

/** What a load read: every row, or only the published versions when none of them is one Studio supports. */
type SourceRead =
  | { readonly compatible: true; readonly rows: SourceRows }
  | { readonly compatible: false; readonly publishedVersions: readonly number[] };

type ReadObject = (typeof SNAPSHOT_READS)[number]["object"];

const isInteger = (value: unknown): value is number => Number.isInteger(value);

/** Runs the statements of one snapshot on `client`, checking the deadline before each one. */
async function readSource(client: PoolClient, signal: AbortSignal, schema: string): Promise<SourceRead> {
  const statements = buildSnapshotStatements(schema);
  const run = async (sql: string): Promise<Row[]> => {
    signal.throwIfAborted();
    return (await client.query(sql)).rows;
  };
  // A read that fails names the object it read, which the server's own message may not.
  const read = async (sql: string, object: ReadObject): Promise<Row[]> => {
    signal.throwIfAborted();
    try {
      return (await client.query(sql)).rows;
    } catch (error) {
      throw new SnapshotReadError(`${schema}.${object}`, error);
    }
  };

  await run(statements.begin);
  const contract = await read(statements.contract, "contract");
  const publishedVersions = [...new Set(contract.map((row) => row.version).filter(isInteger))].sort((a, b) => a - b);
  const common = SUPPORTED_CONTRACT_VERSIONS.filter((version) => publishedVersions.includes(version));
  if (common.length === 0) {
    await run(statements.commit);
    return { compatible: false, publishedVersions };
  }
  const connections = await read(statements.connections, "connections_v1");
  const grants = await read(statements.grants, "grants_v1");
  const settings = await read(statements.settings, "settings_v1");
  const revocations = await read(statements.revocations, "session_revocations_v1");
  const canaries = await read(statements.canary, "seal_canary_v1");
  await run(statements.commit);
  return {
    compatible: true,
    rows: {
      contractVersion: Math.max(...common),
      publishedVersions,
      connections,
      grants,
      settings,
      revocations,
      canaries,
    },
  };
}

/** An instant `pg` returned for a `timestamptz`, in epoch ms: a Date, or plus or minus Infinity; NaN for anything else. */
function instantMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY ? value : Number.NaN;
}

const isSubject = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= SUBJECT_MAX_LENGTH;

interface GrantFields {
  readonly subject: string;
  readonly connectionId: string;
  readonly level: "read" | "write";
  readonly expiresAt: number | null;
}

/** The fields of a grant row Studio reads, or undefined when the row breaks the rules its view publishes. */
function grantFields(row: Row): GrantFields | undefined {
  const { subject, connection_id: connectionId, level, expires_at: expires } = row;
  const expiresAt = expires === null ? null : instantMs(expires);
  const valid = isSubject(subject) && typeof connectionId === "string" && !Number.isNaN(expiresAt);
  if (valid && (level === "read" || level === "write")) return { subject, connectionId, level, expiresAt };
  return undefined;
}

/** One subject's grant on one connection, as a key no subject or id can forge by holding a separator. */
const pairKey = ({ subject, connectionId }: GrantFields): string => JSON.stringify([subject, connectionId]);

interface Tally<T> {
  readonly bySubject: T;
  /** The rows that grant or revoke nothing because they break the contract's rules. */
  readonly ignored: number;
}

function effectiveGrants(
  rows: readonly Row[],
  connections: ReadonlyMap<string, AdmittedConnection>,
): Tally<Map<string, Map<string, EffectiveGrant>>> {
  const grants = rows.map(grantFields);
  const rowsPerPair = new Map<string, number>();
  for (const grant of grants) {
    if (grant !== undefined) rowsPerPair.set(pairKey(grant), (rowsPerPair.get(pairKey(grant)) ?? 0) + 1);
  }
  const bySubject = new Map<string, Map<string, EffectiveGrant>>();
  let ignored = 0;
  for (const grant of grants) {
    if (grant === undefined || rowsPerPair.get(pairKey(grant)) !== 1) {
      ignored += 1;
      continue;
    }
    // A grant on a connection admission skipped, or that no longer exists, has nothing to grant.
    const connection = connections.get(grant.connectionId);
    if (connection === undefined) continue;
    const level = grant.level === "write" && connection.write !== undefined ? "write" : "read";
    const ofSubject = bySubject.get(grant.subject) ?? new Map<string, EffectiveGrant>();
    ofSubject.set(grant.connectionId, { connection, level, expiresAt: grant.expiresAt });
    bySubject.set(grant.subject, ofSubject);
  }
  return { bySubject, ignored };
}

/** The latest `revoked_before` of each subject: a revocation only ever denies, so the latest one is the one in force. */
function latestRevocations(rows: readonly Row[]): Tally<Map<string, number>> {
  const bySubject = new Map<string, number>();
  let ignored = 0;
  for (const { subject, revoked_before: revokedBefore } of rows) {
    const at = instantMs(revokedBefore);
    if (!isSubject(subject) || Number.isNaN(at)) {
      ignored += 1;
      continue;
    }
    bySubject.set(subject, Math.max(at, bySubject.get(subject) ?? Number.NEGATIVE_INFINITY));
  }
  return { bySubject, ignored };
}

/**
 * What one canary envelope gives: `ok` when it opens to exactly `{"user":"libredb-canary"}`, PLAINTEXT_INVALID when it
 * opens to anything else, and the envelope's code when it does not open. An error that is no envelope's fault, such
 * as a keyring that does not load, fails the load.
 */
function canaryResult(envelope: unknown): CanaryResult {
  if (typeof envelope !== "string") return "FORMAT";
  try {
    const opened = openGovernedSecret(envelope, CANARY_BINDING);
    const keys = Object.keys(opened);
    return keys.length === 1 && opened.user === CANARY_USER ? "ok" : "PLAINTEXT_INVALID";
  } catch (error) {
    if (!(error instanceof SealedSecretError)) throw error;
    return error.code;
  }
}

/** The result of each key id's canary. A row whose kid breaks the contract's CHECK reports nothing and is counted. */
function canaryResults(rows: readonly CanaryRow[]): Tally<Record<string, CanaryResult>> {
  const byKid: Record<string, CanaryResult> = {};
  let ignored = 0;
  for (const { kid, envelope } of rows) {
    if (typeof kid !== "string" || !KID.test(kid)) {
      ignored += 1;
      continue;
    }
    byKid[kid] = canaryResult(envelope);
  }
  return { bySubject: byKid, ignored };
}

function buildSnapshot(rows: SourceRows, loadedAt: number): GovernanceSnapshot {
  const { admitted, skipped } = admitConnectionRows(rows.connections, {
    allowedEngines: governanceAllowedEngines(),
    openSecret: openGovernedSecret,
  });
  const connections = new Map(admitted.map((connection) => [connection.id, connection]));
  const grants = effectiveGrants(rows.grants, connections);
  const revocations = latestRevocations(rows.revocations);
  const canary = canaryResults(rows.canaries);
  if (grants.ignored > 0 || revocations.ignored > 0 || canary.ignored > 0) {
    logger.warn("Governance rows ignored", {
      route: ROUTE,
      grants: grants.ignored,
      revocations: revocations.ignored,
      canaries: canary.ignored,
    });
  }
  return {
    loadedAt,
    contractVersion: rows.contractVersion,
    publishedVersions: rows.publishedVersions,
    connections,
    skipped,
    grants: grants.bySubject,
    revocations: revocations.bySubject,
    settings: rows.settings,
    canary: canary.bySubject,
  };
}

/** Reads the governance source and builds its snapshot, or throws why it could not. */
async function readSnapshot(loadedAt: number): Promise<GovernanceSnapshot> {
  try {
    governanceKeyring();
  } catch (error) {
    throw new KeyringUnavailableError(error);
  }
  const schema = governancePostgresSchema();
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error(`The governance snapshot did not load within ${LOAD_DEADLINE_MS} ms`)),
    LOAD_DEADLINE_MS,
  );
  deadline.unref?.();
  let read: SourceRead;
  try {
    read = await withGovernanceClient(controller.signal, (client) => readSource(client, controller.signal, schema));
  } finally {
    clearTimeout(deadline);
  }
  if (!read.compatible) throw new IncompatibleContractError(SUPPORTED_CONTRACT_VERSIONS, read.publishedVersions);
  return buildSnapshot(read.rows, loadedAt);
}

/** A skip as the log line shows it: the heartbeat's item, and the envelope code that item has no field for. */
const skipLine = ({ item, envelopeCode }: AdmissionSkip) =>
  envelopeCode === undefined ? item : { ...item, envelopeCode };

function logLoaded(snapshot: GovernanceSnapshot, previous: GovernanceState): void {
  const context = {
    route: ROUTE,
    contract: snapshot.contractVersion,
    connections: snapshot.connections.size,
    skipped: snapshot.skipped.length,
    subjects: snapshot.grants.size,
  };
  // The first load, and the first after a failure, are news; a routine reload every GOVERNANCE_REFRESH_MS is not.
  if (previous.snapshot === null || previous.failure !== null) logger.info("Governance snapshot loaded", context);
  else logger.debug("Governance snapshot reloaded", context);
  const skipped = snapshot.skipped.map(skipLine);
  const before = (previous.snapshot?.skipped ?? []).map(skipLine);
  if (skipped.length > 0 && JSON.stringify(skipped) !== JSON.stringify(before)) {
    logger.warn("Governance rows skipped", { route: ROUTE, skipped });
  }
}

/**
 * Loads the governance source once and records the outcome in the state holder: the new snapshot, swapped in at
 * once, or why the load failed. It never throws, so neither a database outage nor a misconfigured source can stop the
 * process. The snapshot's load time is the moment the load started, so its age is never understated.
 */
export async function loadGovernanceSnapshot(): Promise<void> {
  const startedAt = Date.now();
  try {
    const snapshot = await readSnapshot(startedAt);
    const previous = governanceState();
    recordGovernanceSnapshot(snapshot);
    logLoaded(snapshot, previous);
  } catch (error) {
    const failure = loadFailureOf(error, Date.now());
    recordGovernanceFailure(failure);
    logger.warn("Governance snapshot load failed", {
      route: ROUTE,
      kind: failure.kind,
      code: failure.code,
      detail: failure.detail,
    });
  }
}
