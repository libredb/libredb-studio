/**
 * The governance listener (spec 7.3): one dedicated connection to the governance source that hears its change
 * notifications, so a change reaches the snapshot within moments instead of at the next refresh.
 *
 * The connection is a `pg` Client of its own, outside the governance pool, with TCP keepalive, named
 * `libredb-studio-governance-listener` in `pg_stat_activity`. After every connect it issues `LISTEN libredb_bridge`
 * and `LISTEN` on this instance's ping channel, and only then asks for a load, because a change that committed while
 * nothing listened sent a notification nobody heard.
 *
 * A payload is only a hint, since any role that can connect can notify the channel: it is parsed with `JSON.parse`
 * for the log line and never read for data. Every notification on `libredb_bridge` stamps `lastNotificationAt` and
 * opens a window of 250 ms if none is open, and when the window closes one reload of the whole snapshot runs for
 * everything that arrived in it. The reload is a load that starts after the window closed, so a notification that
 * arrives while a load runs gets a load of its own after that one (`requestFreshGovernanceLoad()` in start.ts).
 *
 * Every 60 s the listener checks its connection. Its liveness query races a 5 s timer, and on timeout the socket is
 * destroyed, because a half-open TCP connection never errors on its own; every other statement of the listener races
 * the same timer. Then it pings itself with `SELECT pg_notify(<ping channel>, <nonce>)`. A ping that has not come back
 * by the next check is missed, and the second miss in a row makes the listener `deaf` and reconnects it. A ping never
 * changes `lastNotificationAt`, so a control plane can read it as proof that its own notifications arrive.
 *
 * A connect that fails or a connection that drops puts the listener in `reconnecting`. It reconnects after a delay
 * drawn at random below a bound that starts at 1 s and doubles with each attempt up to 30 s (full jitter), and the
 * bound starts over once a ping comes back. A server that refuses `LISTEN`, as a hot standby or a transaction pooler
 * does, puts it in `polling`: the refresher of start.ts keeps the snapshot current on its own, and the listener tries
 * again on the same backoff.
 *
 * The listener lives in a global under a registered symbol, one per process: Next.js bundles instrumentation, which
 * starts it, apart from the admin route that reports it (src/lib/governance/keyring.ts does the same).
 */
import { randomBytes } from "node:crypto";
import { Client, type ClientConfig, type Notification } from "pg";
import { logger } from "@/lib/logger";
import { pgSslConfig } from "@/lib/pg-ssl";
import { governancePostgresUrl } from "./config";
import {
  buildListenerProbeStatement,
  buildListenStatement,
  buildPingListenStatement,
  buildPingNotifyStatement,
  type LISTENER_STATES,
  NOTIFY_CHANNEL,
  NOTIFY_KINDS,
  pingChannel,
} from "./contract";
import { governanceInstanceId } from "./instance";

export type ListenerState = (typeof LISTENER_STATES)[number];

/** How often the listener checks its connection and pings itself. */
const PING_INTERVAL_MS = 60_000;
/** The missed pings in a row that make the listener deaf. */
const DEAF_AFTER_MISSED_PINGS = 2;
/** How long a statement of the listener may take before its socket is destroyed. */
const ANSWER_TIMEOUT_MS = 5000;
/** The window that folds the notifications arriving in it into one reload. */
const RELOAD_WINDOW_MS = 250;
/** The bound of the first reconnect delay, and the most the bound doubles to. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** The connection's options beside the URL and its TLS setting, which it gets as the governance pool does. */
const CLIENT_OPTIONS = {
  keepAlive: true,
  connectionTimeoutMillis: 5000,
  application_name: "libredb-studio-governance-listener",
} as const;

const ROUTE = "governance/listener";

// One template literal per message, never a concatenation across lines: bun's line coverage under-counts the
// continuation lines of a message built that way.
const CONNECT_FAILED = "Governance listener could not connect";
const LOST = "Governance listener connection lost";
const REFUSED = "Governance listener cannot LISTEN: only the periodic reload keeps the snapshot current";
const DEAF = "Governance listener is deaf: two pings did not come back";

/** The listener as the admin status and the heartbeat report it. */
export interface GovernanceListenerStatus {
  readonly state: ListenerState;
  /** Since when the state has held, in epoch milliseconds. */
  readonly since: number;
  /** When the last `libredb_bridge` notification arrived, in epoch milliseconds, or null before the first. */
  readonly lastNotificationAt: number | null;
}

export interface GovernanceListenerOptions {
  /** How often the listener checks its connection and pings itself: every 60 s unless a live check wants it sooner. */
  readonly pingIntervalMs?: number;
}

interface Listener {
  readonly reload: () => Promise<void>;
  readonly pingIntervalMs: number;
  readonly clientConfig: ClientConfig;
  readonly instanceId: string;
  readonly pingChannel: string;
  state: ListenerState;
  since: number;
  lastNotificationAt: number | null;
  /** The connection in use or being opened; undefined between attempts and once the listener stopped. */
  client?: Client;
  /** How many reconnects were timed since a ping last came back. */
  attempt: number;
  /** The nonce of the latest ping, until it comes back. */
  pendingPing?: string;
  /** How many checks in a row found the ping before them missing. */
  missedPings: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  checkTimer?: ReturnType<typeof setTimeout>;
  reloadTimer?: ReturnType<typeof setTimeout>;
}

const LISTENER_KEY = Symbol.for("libredb-studio.governance-listener");

type ListenerHolder = { [LISTENER_KEY]?: Listener };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The driver's code of an error: a SQLSTATE, or a Node error code such as ECONNREFUSED. */
function codeOf(error: unknown): string | null {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** Whether the server refused a statement: `pg` hands a server's error over with its severity, a socket error never. */
function refusedByServer(error: unknown): boolean {
  return typeof (error as { readonly severity?: unknown } | null | undefined)?.severity === "string";
}

/** The kind a change notification names, for the log only: a payload is a hint that any role can send, never data. */
function hintedKind(payload: string | undefined): string {
  let kind: unknown;
  try {
    kind = (JSON.parse(payload ?? "") as { readonly kind?: unknown } | null)?.kind;
  } catch {
    return "unparsable";
  }
  return (NOTIFY_KINDS as readonly unknown[]).includes(kind) ? String(kind) : "unknown";
}

function setState(listener: Listener, state: ListenerState): void {
  if (listener.state === state) return;
  listener.state = state;
  listener.since = Date.now();
}

/**
 * Runs one statement on `client`, raced against a timer: a statement that has not answered within ANSWER_TIMEOUT_MS
 * destroys the socket, which makes `pg` end the client, and rejects.
 */
async function answerWithin(client: Client, sql: string, values?: readonly unknown[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.connection.stream.destroy();
      reject(new Error(`The governance listener's connection did not answer within ${ANSWER_TIMEOUT_MS} ms`));
    }, ANSWER_TIMEOUT_MS);
  });
  try {
    await Promise.race([client.query(sql, values as unknown[] | undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Times the next connect: at random below a bound that doubles with each attempt, from 1 s up to 30 s. */
function scheduleReconnect(listener: Listener): void {
  const boundMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** listener.attempt);
  listener.attempt += 1;
  listener.reconnectTimer = setTimeout(() => void connect(listener), Math.random() * boundMs);
  listener.reconnectTimer.unref?.();
}

/**
 * Lets go of `client` when it is still the listener's connection: logs why, ends it, and times the next connect in
 * state `next`. A client the listener already let go of, or one of a listener that stopped, is left as it is, so a
 * drop that `pg` reports twice, as an error and then as the end, is handled once.
 */
function letGo(listener: Listener, client: Client, next: ListenerState, message: string, error?: unknown): void {
  if (listener.client !== client) return;
  listener.client = undefined;
  clearTimeout(listener.checkTimer);
  listener.pendingPing = undefined;
  listener.missedPings = 0;
  logger.warn(message, {
    route: ROUTE,
    state: next,
    ...(error === undefined ? {} : { code: codeOf(error), error: messageOf(error) }),
  });
  setState(listener, next);
  void client.end();
  scheduleReconnect(listener);
}

function scheduleCheck(listener: Listener, client: Client): void {
  listener.checkTimer = setTimeout(() => void check(listener, client), listener.pingIntervalMs);
  listener.checkTimer.unref?.();
}

/**
 * The periodic check of a listening connection: the ping before it counts as missed when it has not come back, and
 * the second miss in a row lets the connection go as deaf. Otherwise the liveness query runs, and then the next ping.
 */
async function check(listener: Listener, client: Client): Promise<void> {
  if (listener.pendingPing !== undefined) {
    listener.missedPings += 1;
    if (listener.missedPings >= DEAF_AFTER_MISSED_PINGS) return letGo(listener, client, "deaf", DEAF);
  }
  const nonce = randomBytes(8).toString("hex");
  try {
    await answerWithin(client, buildListenerProbeStatement());
    // Set before the ping goes out: the server delivers a session's own notification ahead of the statement's answer.
    listener.pendingPing = nonce;
    await answerWithin(client, buildPingNotifyStatement(), [listener.pingChannel, nonce]);
  } catch (error) {
    return letGo(listener, client, "reconnecting", LOST, error);
  }
  if (listener.client === client) scheduleCheck(listener, client);
}

/** A notification on one of the two channels the connection listens on. */
function heard(listener: Listener, client: Client, { channel, payload }: Notification): void {
  if (listener.client !== client) return;
  if (channel === listener.pingChannel) {
    if (listener.pendingPing !== undefined && payload === listener.pendingPing) {
      listener.pendingPing = undefined;
      listener.missedPings = 0;
      listener.attempt = 0;
    }
    return;
  }
  // Every other notification is on `libredb_bridge`, the only other channel the connection listens on.
  listener.lastNotificationAt = Date.now();
  logger.debug("Governance change notification", { route: ROUTE, kind: hintedKind(payload) });
  if (listener.reloadTimer !== undefined) return;
  listener.reloadTimer = setTimeout(() => {
    listener.reloadTimer = undefined;
    void listener.reload();
  }, RELOAD_WINDOW_MS);
  listener.reloadTimer.unref?.();
}

/** Opens a connection, LISTENs on both channels and then asks for a load; or lets the connection go and retries. */
async function connect(listener: Listener): Promise<void> {
  listener.reconnectTimer = undefined;
  const client = new Client(listener.clientConfig);
  // `pg` reports a drop as an error and then as the end; an error with no listener would be thrown.
  client.on("error", (error) => letGo(listener, client, "reconnecting", LOST, error));
  client.on("end", () => letGo(listener, client, "reconnecting", LOST, new Error("Connection ended")));
  client.on("notification", (message) => heard(listener, client, message));
  listener.client = client;
  try {
    await client.connect();
  } catch (error) {
    return letGo(listener, client, "reconnecting", CONNECT_FAILED, error);
  }
  try {
    await answerWithin(client, buildListenStatement());
    await answerWithin(client, buildPingListenStatement(listener.instanceId));
  } catch (error) {
    if (refusedByServer(error)) return letGo(listener, client, "polling", REFUSED, error);
    return letGo(listener, client, "reconnecting", LOST, error);
  }
  if (listener.client !== client) return;
  setState(listener, "listening");
  logger.info("Governance listener is listening", { route: ROUTE, channels: [NOTIFY_CHANNEL, listener.pingChannel] });
  scheduleCheck(listener, client);
  void listener.reload();
}

/**
 * Starts the listener of this process, once, and returns at once: it connects in the background and calls `reload`
 * after every LISTEN and for every window of notifications. It throws when `GOVERNANCE_POSTGRES_URL` or
 * `GOVERNANCE_INSTANCE_ID` is not usable, which the boot preflight rules out for a running server.
 */
export function startGovernanceListener(reload: () => Promise<void>, options: GovernanceListenerOptions = {}): void {
  const holder = globalThis as ListenerHolder;
  if (holder[LISTENER_KEY] !== undefined) return;
  const connectionString = governancePostgresUrl();
  const instanceId = governanceInstanceId();
  const listener: Listener = {
    reload,
    pingIntervalMs: options.pingIntervalMs ?? PING_INTERVAL_MS,
    clientConfig: { connectionString, ssl: pgSslConfig(connectionString), ...CLIENT_OPTIONS },
    instanceId,
    pingChannel: pingChannel(instanceId),
    state: "reconnecting",
    since: Date.now(),
    lastNotificationAt: null,
    attempt: 0,
    missedPings: 0,
  };
  holder[LISTENER_KEY] = listener;
  void connect(listener);
}

/** Stops the listener of this process, if one runs: clears its timers and ends its connection. */
export async function stopGovernanceListener(): Promise<void> {
  const holder = globalThis as ListenerHolder;
  const listener = holder[LISTENER_KEY];
  if (listener === undefined) return;
  delete holder[LISTENER_KEY];
  clearTimeout(listener.reconnectTimer);
  clearTimeout(listener.checkTimer);
  clearTimeout(listener.reloadTimer);
  const { client } = listener;
  listener.client = undefined;
  await client?.end();
}

/** The listener of this process as the admin status and the heartbeat report it, or null when none runs. */
export function governanceListenerStatus(): GovernanceListenerStatus | null {
  const listener = (globalThis as ListenerHolder)[LISTENER_KEY];
  if (listener === undefined) return null;
  return { state: listener.state, since: listener.since, lastNotificationAt: listener.lastNotificationAt };
}
