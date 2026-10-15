/**
 * The governance status an administrator reads (spec 9.3, 12.2): what `GET /api/admin/governance` answers and the
 * admin Overview card shows.
 *
 * It is built from the state holder and the listener at the moment of the request: the source and schema, the
 * contract versions on both sides, the freshness state, the age and load time of the snapshot, why the latest load
 * failed, how many connections were admitted, the rows admission skipped, the key ids of the keyring, the result of
 * each key id's seal canary, and the listener's state, how long it has held and when the last change notification
 * arrived. The settings and sink slices add their sections here.
 *
 * Like the heartbeat, it carries ids, levels, paths and codes only: never a definition value, an envelope, a
 * credential or a statement. The one exception is the full message of the latest load failure, which only an
 * administrator reads here: the public `GET /api/ready` names the cause in Studio's own words alone, and without this
 * message an operator would have the log alone to find a privilege or object the server named.
 */
import type { AdmissionSkip, SkippedItem } from "./admission";
import { type GovernanceSource, governancePostgresSchema, governanceSource } from "./config";
import { SUPPORTED_CONTRACT_VERSIONS } from "./contract";
import { type FreshnessState, governanceFreshness } from "./freshness";
import type { EnvelopeCode } from "./hpke";
import { governanceKeyring } from "./keyring";
import { governanceListenerStatus, type ListenerState } from "./listener";
import { type CanaryResult, governanceState, type LoadFailure } from "./state";

/** A row, or a row's write level, that admission left out, with the envelope code the heartbeat item has no field for. */
export type GovernanceStatusSkip = SkippedItem & { readonly envelopeCode?: EnvelopeCode };

export interface GovernanceStatus {
  readonly source: GovernanceSource;
  readonly schema: string;
  readonly contract: {
    /** The contract versions this Studio supports. */
    readonly supported: readonly number[];
    /** The versions the governance source published at the last successful load, or null before one. */
    readonly published: readonly number[] | null;
    /** The version in use, or null before a successful load. */
    readonly active: number | null;
  };
  readonly freshness: FreshnessState;
  /** The snapshot in use, or null before a successful load. */
  readonly snapshot: {
    /** When its load started, as an ISO 8601 instant. */
    readonly loadedAt: string;
    /** Its age at the moment of the request, in milliseconds. */
    readonly ageMs: number;
  } | null;
  /** Why the latest load failed, or null when it succeeded or none has run. */
  readonly lastError: {
    readonly at: string;
    readonly kind: LoadFailure["kind"];
    /** The SQLSTATE or the driver's error code, or null when the failure carries none. */
    readonly code: string | null;
    /** The failure's full message, the server's own words included. Never a value or a credential. */
    readonly message: string;
  } | null;
  /** How many connections the snapshot admitted, or null before a successful load. */
  readonly admittedConnections: number | null;
  readonly skipped: readonly GovernanceStatusSkip[];
  /** The key ids of the keyring this process opens envelopes with, in the order the file lists them. */
  readonly keyringKids: readonly string[];
  /** For each key id with a seal canary, `ok` or the code its envelope failed with; null before a successful load. */
  readonly canary: Readonly<Record<string, CanaryResult>> | null;
  /** The change notification listener of this process, or null when none runs. */
  readonly listener: {
    readonly state: ListenerState;
    /** Since when the state has held, as an ISO 8601 instant. */
    readonly since: string;
    /** How long the state has held at the moment of the request, in milliseconds. */
    readonly heldMs: number;
    /** When the last change notification arrived, as an ISO 8601 instant, or null before the first. */
    readonly lastNotificationAt: string | null;
  } | null;
}

const skipOf = ({ item, envelopeCode }: AdmissionSkip): GovernanceStatusSkip =>
  envelopeCode === undefined ? item : { ...item, envelopeCode };

function listenerAt(nowMs: number): GovernanceStatus["listener"] {
  const listener = governanceListenerStatus();
  if (listener === null) return null;
  const { state, since, lastNotificationAt } = listener;
  return {
    state,
    since: new Date(since).toISOString(),
    heldMs: nowMs - since,
    lastNotificationAt: lastNotificationAt === null ? null : new Date(lastNotificationAt).toISOString(),
  };
}

/**
 * The governance status of this process at `nowMs`. Call it under governance only. It throws when the keyring does
 * not load, which the boot preflight rules out for a running server.
 */
export function governanceStatus(nowMs = Date.now()): GovernanceStatus {
  const { snapshot, failure } = governanceState();
  return {
    source: governanceSource(),
    schema: governancePostgresSchema(),
    contract: {
      supported: SUPPORTED_CONTRACT_VERSIONS,
      published: snapshot?.publishedVersions ?? null,
      active: snapshot?.contractVersion ?? null,
    },
    freshness: governanceFreshness(nowMs),
    snapshot:
      snapshot === null
        ? null
        : { loadedAt: new Date(snapshot.loadedAt).toISOString(), ageMs: nowMs - snapshot.loadedAt },
    lastError:
      failure === null
        ? null
        : { at: new Date(failure.at).toISOString(), kind: failure.kind, code: failure.code, message: failure.detail },
    admittedConnections: snapshot?.connections.size ?? null,
    skipped: (snapshot?.skipped ?? []).map(skipOf),
    keyringKids: [...governanceKeyring().keys()],
    canary: snapshot?.canary ?? null,
    listener: listenerAt(nowMs),
  };
}
