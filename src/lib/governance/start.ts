/**
 * The governance refresher (docs/GOVERNANCE.md#operating-notes): keeps the snapshot of the governance source current,
 * independent of traffic.
 *
 * `startGovernance()` runs from `register()` in `src/instrumentation.ts`, under governance only and without being
 * awaited, so the server starts serving at once and data routes answer 503 until the first load succeeds. It loads
 * the snapshot at once, then again whenever the snapshot reaches the age `GOVERNANCE_REFRESH_MS`, and every 5 s with
 * jitter while the snapshot is absent or older than the refresh interval. An instance that started before PostgreSQL therefore
 * becomes ready on its own, with no request to wake it, and the process never exits on a database outage: a load
 * records its failure and never throws.
 *
 * It also starts the change notification listener (`listener.ts`, docs/GOVERNANCE.md#change-notification), which asks
 * for a load after every LISTEN and for every window of notifications, and the heartbeat (`heartbeat.ts`,
 * docs/GOVERNANCE.md#heartbeat), and registers `stopGovernance()` as the shutdown hook `governance`
 * (src/lib/shutdown.ts), so a SIGTERM stops the beats and closes the listener's connection and the pool before the
 * process exits.
 *
 * Loads are single-flight: `requestGovernanceLoad()` joins the load under way, if there is one, so the refresher, a
 * readiness probe and a change notification never run two loads at once. Each load that ends sets the next timer from
 * the state it left, so a load another caller asked for also moves the next reload.
 */
import { onShutdown } from "@/lib/shutdown";
import { governanceRefreshMs } from "./config";
import { closeGovernancePool } from "./db";
import { startGovernanceHeartbeat, stopGovernanceHeartbeat } from "./heartbeat";
import { startGovernanceListener, stopGovernanceListener } from "./listener";
import { loadGovernanceSnapshot } from "./snapshot";
import { governanceState } from "./state";

/** The retry interval while the snapshot is absent or older than the refresh interval, and its jitter either way. */
const RETRY_MS = 5000;
const RETRY_JITTER_MS = 1000;

interface Refresher {
  started: boolean;
  inFlight?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Where the refresher lives. Next.js bundles instrumentation, which starts it, apart from each route handler that
 * asks for a load, so the single flight is kept in a global under a registered symbol, one per process
 * (src/lib/governance/keyring.ts does the same).
 */
const REFRESHER_KEY = Symbol.for("libredb-studio.governance-refresher");

type RefresherHolder = { [REFRESHER_KEY]?: Refresher };

function refresher(): Refresher {
  const holder = globalThis as RefresherHolder;
  holder[REFRESHER_KEY] ??= { started: false };
  return holder[REFRESHER_KEY];
}

/**
 * How long to wait before the next load: until the snapshot reaches the refresh interval, or 4 to 6 s once it has,
 * or while there is none.
 */
function nextLoadDelayMs(nowMs: number): number {
  const { snapshot } = governanceState();
  const dueInMs = snapshot === null ? 0 : snapshot.loadedAt + governanceRefreshMs() - nowMs;
  if (dueInMs > 0) return dueInMs;
  // crypto rather than Math.random: the jitter is no secret, but a scanner reads Math.random as a weak generator.
  const fraction = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return RETRY_MS - RETRY_JITTER_MS + fraction * 2 * RETRY_JITTER_MS;
}

function scheduleNextLoad(state: Refresher): void {
  if (!state.started) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void requestGovernanceLoad(), nextLoadDelayMs(Date.now()));
  // The refresher must never hold the process open on its own.
  state.timer.unref?.();
}

/**
 * Loads the snapshot now, or joins the load under way, and settles when that load has recorded its outcome. It never
 * rejects. Without the refresher started it schedules no further load.
 */
export function requestGovernanceLoad(): Promise<void> {
  const state = refresher();
  if (state.inFlight !== undefined) return state.inFlight;
  const load = loadGovernanceSnapshot().finally(() => {
    state.inFlight = undefined;
    scheduleNextLoad(state);
  });
  state.inFlight = load;
  return load;
}

/**
 * Loads the snapshot with a load that starts after this call, and settles when that load has recorded its outcome.
 * A load under way may have read the governance source before the change that prompted the call, so this waits for
 * it to end and then starts the next load, or joins one that another caller started after it. It never rejects.
 */
export async function requestFreshGovernanceLoad(): Promise<void> {
  const { inFlight } = refresher();
  if (inFlight !== undefined) await inFlight;
  await requestGovernanceLoad();
}

/**
 * Starts the refresher, the change notification listener and the heartbeat of this process, once, and registers their
 * stop as a shutdown hook. The first load and the first beat run at once and are not awaited.
 */
export function startGovernance(): void {
  const state = refresher();
  if (state.started) return;
  state.started = true;
  void requestGovernanceLoad();
  startGovernanceListener(requestFreshGovernanceLoad);
  startGovernanceHeartbeat();
  onShutdown("governance", stopGovernance);
}

/**
 * Stops the refresher, the heartbeat and the listener and closes the governance pool. A load under way records its
 * outcome when it ends, and schedules nothing after it.
 */
export async function stopGovernance(): Promise<void> {
  const state = refresher();
  state.started = false;
  clearTimeout(state.timer);
  state.timer = undefined;
  stopGovernanceHeartbeat();
  await stopGovernanceListener();
  await closeGovernancePool();
}
