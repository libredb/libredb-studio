/**
 * The governance heartbeat (spec 7.2, 12.2): every 30 s this instance upserts its row of `studio_instances_v1` with
 * the statement `buildHeartbeatUpsert()` builds, so a control plane's fleet view sees each instance, its health and
 * whether the seal works.
 *
 * A beat reports the instance id (`GOVERNANCE_INSTANCE_ID`), the Studio version, the contract versions Studio supports
 * and the one in use (0 while none is negotiated), the key ids of the keyring, the listener's state and its last
 * change notification, the snapshot's load time, the rows admission skipped and the setting keys the settings store
 * ignored, the query event sink's state and the result of each key id's seal canary. Every beat sends the process
 * start time as `started_at`, which only the first insert writes; the update of every later beat sets each reported
 * column and `last_seen_at = now()`, so a restart with the same instance id updates the same row and a control plane
 * reads liveness from `last_seen_at`.
 *
 * Like the admin status, a beat carries ids, levels, paths and codes only: a skipped row goes out as the item
 * admission built, without the envelope code beside it, and never with a definition value, an envelope or a
 * credential. An ignored setting goes out as `{kind: "setting", id: <key>, code: "SETTING_INVALID"}`, never with its
 * value.
 *
 * `startGovernance()` starts the beats. A failed beat is logged at most once a minute and touches nothing else: the
 * freshness of the snapshot depends on the loads alone, so a heartbeat refused by the database never stops data routes.
 */
import { getAppVersion } from "@/lib/app-version";
import { logger } from "@/lib/logger";
import { governancePostgresSchema } from "./config";
import { buildHeartbeatUpsert, HEARTBEAT_COLUMNS, SUPPORTED_CONTRACT_VERSIONS } from "./contract";
import { withGovernanceClient } from "./db";
import { governanceInstanceId } from "./instance";
import { governanceKeyring } from "./keyring";
import { governanceListenerStatus } from "./listener";
import { governanceState } from "./state";

/** How often an instance beats (spec 7.2). */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** The deadline of one beat, from asking the pool for a connection to the answer. */
const BEAT_DEADLINE_MS = 10_000;
/** The most skipped rows a beat reports: the CHECK on the `skipped` column. */
const SKIPPED_MAX = 500;
/** The shortest gap between two log lines of failed beats. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * The query event sink's state as the manifest shapes it. No sink runs in this release, so nothing is queued, dropped
 * or refused, and no flush has happened.
 */
const IDLE_SINK = {
  queued: 0,
  dropped: 0,
  rejected: 0,
  lastFlushAt: null,
  backingOff: false,
  lastSqlstate: null,
} as const;

/** When this process started, which every beat sends as `started_at`. */
const PROCESS_STARTED_AT = new Date(performance.timeOrigin);

const ROUTE = "governance/heartbeat";

type HeartbeatColumn = (typeof HEARTBEAT_COLUMNS)[number];

/** The parameters of one beat, `$1` to `$12` in the order of HEARTBEAT_COLUMNS. */
function heartbeatParameters(): unknown[] {
  const version = getAppVersion();
  if (version === null) {
    throw new Error(
      "NEXT_PUBLIC_APP_VERSION is not set: the heartbeat reports the Studio version, which the build injects",
    );
  }
  const listener = governanceListenerStatus();
  if (listener === null) {
    throw new Error("The heartbeat cannot report a listener state: the governance listener is not running");
  }
  const { snapshot } = governanceState();
  const row: Readonly<Record<HeartbeatColumn, unknown>> = {
    instance_id: governanceInstanceId(),
    studio_version: version,
    supported_contracts: [...SUPPORTED_CONTRACT_VERSIONS],
    contract_version: snapshot?.contractVersion ?? 0,
    keyring_kids: [...governanceKeyring().keys()],
    listener_state: listener.state,
    last_notification_at: listener.lastNotificationAt === null ? null : new Date(listener.lastNotificationAt),
    snapshot_loaded_at: snapshot === null ? null : new Date(snapshot.loadedAt),
    // `pg` would send an array as a PostgreSQL array, so the JSON columns go out as their JSON text.
    skipped: JSON.stringify(
      [...(snapshot?.skipped ?? []).map(({ item }) => item), ...(snapshot?.settings.ignored ?? [])].slice(
        0,
        SKIPPED_MAX,
      ),
    ),
    sink: JSON.stringify(IDLE_SINK),
    canary: JSON.stringify(snapshot?.canary ?? {}),
    started_at: PROCESS_STARTED_AT,
  };
  return HEARTBEAT_COLUMNS.map((column) => row[column]);
}

/** Sends one beat, and settles when the database answered it. It rejects with the reason a beat failed. */
export async function sendGovernanceHeartbeat(): Promise<void> {
  const parameters = heartbeatParameters();
  const sql = buildHeartbeatUpsert(governancePostgresSchema());
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error(`The governance heartbeat did not finish within ${BEAT_DEADLINE_MS} ms`)),
    BEAT_DEADLINE_MS,
  );
  deadline.unref?.();
  try {
    await withGovernanceClient(controller.signal, (client) => client.query(sql, parameters));
  } finally {
    clearTimeout(deadline);
  }
}

interface Beats {
  timer?: ReturnType<typeof setInterval>;
  inFlight: boolean;
  /** When a failed beat was last logged, in epoch milliseconds. */
  lastFailureLoggedAt: number | null;
}

/**
 * Where the beats live. Next.js bundles instrumentation, which starts them, apart from each route handler, so the
 * loop is kept in a global under a registered symbol, one per process (src/lib/governance/keyring.ts does the same).
 */
const BEATS_KEY = Symbol.for("libredb-studio.governance-heartbeat");

type BeatsHolder = { [BEATS_KEY]?: Beats };

const codeOf = (error: unknown): string | null => {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
};

function logFailure(beats: Beats, error: unknown): void {
  const now = Date.now();
  if (beats.lastFailureLoggedAt !== null && now - beats.lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return;
  beats.lastFailureLoggedAt = now;
  const message = error instanceof Error ? error.message : String(error);
  logger.warn("Governance heartbeat failed", { route: ROUTE, code: codeOf(error), error: message });
}

/** Sends a beat unless the one before it is still running, and logs its failure. It never rejects. */
async function beat(beats: Beats): Promise<void> {
  if (beats.inFlight) return;
  beats.inFlight = true;
  try {
    await sendGovernanceHeartbeat();
  } catch (error) {
    logFailure(beats, error);
  } finally {
    beats.inFlight = false;
  }
}

interface GovernanceHeartbeatOptions {
  /** How often to beat: every 30 s unless a test wants it sooner. */
  readonly intervalMs?: number;
}

/** Starts the beats of this process, once: one at once, then one every 30 s. */
export function startGovernanceHeartbeat(options: GovernanceHeartbeatOptions = {}): void {
  const holder = globalThis as BeatsHolder;
  if (holder[BEATS_KEY] !== undefined) return;
  const beats: Beats = { inFlight: false, lastFailureLoggedAt: null };
  beats.timer = setInterval(() => void beat(beats), options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  // The heartbeat must never hold the process open on its own.
  beats.timer.unref?.();
  holder[BEATS_KEY] = beats;
  void beat(beats);
}

/** Stops the beats of this process, if they run. A beat under way still ends, and none follows it. */
export function stopGovernanceHeartbeat(): void {
  const holder = globalThis as BeatsHolder;
  const beats = holder[BEATS_KEY];
  if (beats === undefined) return;
  delete holder[BEATS_KEY];
  clearInterval(beats.timer);
}
