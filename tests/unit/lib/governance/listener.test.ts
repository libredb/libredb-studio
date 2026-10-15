/**
 * The governance listener (docs/GOVERNANCE.md#change-notification): one dedicated connection to the governance source,
 * outside the pool, that LISTENs for change notifications and folds them into one reload per 250 ms, pings itself every
 * 60 s on its instance's channel and reconnects when two pings did not come back, destroys a connection whose liveness
 * query does not answer within 5 s, reconnects with full jitter, and leaves the snapshot to the periodic refresh when
 * the server refuses LISTEN.
 *
 * `pg` is the fake of tests/helpers/governance/pg-fake.ts: the listener's Client is a FakeListenerClient, which
 * delivers a notification only on a channel it LISTENs on, as PostgreSQL does, and the snapshot loads go to a
 * FakePool. The timers are bun's fake timers, which move `Date.now()` with them.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import {
  buildListenerProbeStatement,
  buildListenStatement,
  buildPingListenStatement,
  buildPingNotifyStatement,
  NOTIFY_CHANNEL,
  pingChannel,
} from "@/lib/governance/contract";
import { keyringFileOf, removeKeyringFiles, testKey } from "../../../helpers/governance/keyring-file";
import {
  type Answer,
  answerListener,
  FakeListenerClient,
  FakePool,
  fakePg,
  nodeError,
  pgError,
  settle,
} from "../../../helpers/governance/pg-fake";

const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: FakeListenerClient, types: realPg.types }));
// The heartbeat `startGovernance()` starts would share the pool and the log these cases count.
mock.module("@/lib/governance/heartbeat", () => ({
  startGovernanceHeartbeat: () => {},
  stopGovernanceHeartbeat: () => {},
}));

const { governanceListenerStatus, startGovernanceListener, stopGovernanceListener } = await import(
  "@/lib/governance/listener"
);
const { startGovernance, stopGovernance } = await import("@/lib/governance/start");
const { resetGovernanceState } = await import("@/lib/governance/state");
const { resetGovernanceKeyring } = await import("@/lib/governance/keyring");
const { logger } = await import("@/lib/logger");

const INSTANCE_ID = "libredb-studio";
const PING_CHANNEL = pingChannel(INSTANCE_ID);
/** What a connection issues first, in this order, before the listener asks for a load. */
const LISTENS = [buildListenStatement(), buildPingListenStatement(INSTANCE_ID)];
const PROBE = buildListenerProbeStatement();
const PING = buildPingNotifyStatement();
/** The payload the governance source's triggers send. */
const HINT = JSON.stringify({ v: 1, kind: "grants" });
const URL = "postgresql://libredb_studio@db.internal:5432/libredb?sslmode=verify-full";

const GOVERNED: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: URL,
  GOVERNANCE_INSTANCE_ID: INSTANCE_ID,
  GOVERNANCE_PRIVATE_KEYS_FILE: keyringFileOf(testKey()),
  GOVERNANCE_POSTGRES_SCHEMA: undefined,
  GOVERNANCE_REFRESH_MS: undefined,
  GOVERNANCE_MAX_STALENESS_MS: undefined,
  GOVERNANCE_ALLOWED_ENGINES: undefined,
};

let saved: Record<string, string | undefined> = {};
let spies: ReturnType<typeof spyOn>[] = [];
/** The listener's reload, standing in for the single-flight load of start.ts. */
let reload = mock(async () => {});
/** The statements of the latest connection at each reload, to show what ran before it. */
let statementsAtReload: string[][] = [];

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const latest = (): FakeListenerClient => FakeListenerClient.made.at(-1) as FakeListenerClient;
const sqls = (client: FakeListenerClient): string[] => client.statements.map((statement) => statement.sql);
const listenerState = () => governanceListenerStatus()?.state;
const warnings = (): string[] =>
  (logger.warn as ReturnType<typeof spyOn>).mock.calls.map((call: unknown[]) => String(call[0]));

beforeEach(() => {
  saved = {};
  for (const [name, value] of Object.entries(GOVERNED)) {
    saved[name] = process.env[name];
    setEnv(name, value);
  }
  fakePg.reset();
  statementsAtReload = [];
  reload = mock(async () => {
    statementsAtReload.push(sqls(latest()));
  });
  spies = (["error", "warn", "info", "debug"] as const).map((level) =>
    spyOn(logger, level).mockImplementation(() => {}),
  );
});

afterEach(async () => {
  await stopGovernanceListener();
  await stopGovernance();
  jest.useRealTimers();
  resetGovernanceState();
  resetGovernanceKeyring();
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  for (const spy of spies) spy.mockRestore();
});

afterAll(() => {
  removeKeyringFiles();
});

/** Moves virtual time by `ms` in steps, letting every promise the timers start settle on the way. */
async function advance(ms: number, step = 50): Promise<void> {
  for (let moved = 0; moved < ms; moved += step) {
    jest.advanceTimersByTime(Math.min(step, ms - moved));
    // oxlint-disable-next-line no-await-in-loop -- each step's statements answer before virtual time moves on.
    await settle();
  }
}

/** Fires the next timer at its due time, and lets what it starts settle. */
async function nextTimer(): Promise<void> {
  jest.advanceTimersToNextTimer();
  await settle();
}

/** Answers the listener's statements by default, and refuses every LISTEN as a hot standby does. */
const refuseListen = (sql: string, values: readonly unknown[] | undefined, client: FakeListenerClient): Answer =>
  sql.startsWith("LISTEN ")
    ? Promise.reject(pgError("25006", "cannot execute LISTEN during recovery"))
    : answerListener(sql, values, client);

describe("the connection", () => {
  test("it is one dedicated client with TCP keepalive, outside the pool, that LISTENs on both channels and then loads", async () => {
    startGovernanceListener(reload);
    startGovernanceListener(reload);
    await settle();

    expect(FakeListenerClient.made).toHaveLength(1);
    expect(FakePool.made).toEqual([]);
    expect(latest().config).toEqual({
      connectionString: URL,
      ssl: { rejectUnauthorized: false },
      keepAlive: true,
      connectionTimeoutMillis: 5000,
      application_name: "libredb-studio-governance-listener",
    });
    expect(sqls(latest())).toEqual(LISTENS);
    expect(statementsAtReload).toEqual([LISTENS]);
    expect(listenerState()).toBe("listening");
  });

  test("a reconnect issues LISTEN on both channels before the load", async () => {
    jest.useFakeTimers();
    startGovernanceListener(reload);
    await settle();
    const first = latest();

    // pg reports a terminated backend twice, as an error and then as the end of the connection.
    first.drop(pgError("57P01", "terminating connection due to administrator command", "FATAL"));

    expect(listenerState()).toBe("reconnecting");
    expect(first.ends).toBe(1);
    expect(warnings()).toEqual(["Governance listener connection lost"]);
    expect(jest.getTimerCount()).toBe(1);

    await nextTimer();

    const second = latest();
    expect(second).not.toBe(first);
    expect(sqls(second)).toEqual(LISTENS);
    expect(statementsAtReload).toEqual([LISTENS, LISTENS]);
    expect(listenerState()).toBe("listening");
  });

  test("the status is null before the start and after the stop, and a start after a stop opens a new connection", async () => {
    expect(governanceListenerStatus()).toBeNull();

    startGovernanceListener(reload);
    await settle();
    expect(governanceListenerStatus()?.state).toBe("listening");

    await stopGovernanceListener();
    expect(governanceListenerStatus()).toBeNull();

    startGovernanceListener(reload);
    await settle();
    expect(FakeListenerClient.made).toHaveLength(2);
    expect(FakeListenerClient.made[0].ends).toBe(1);
    expect(governanceListenerStatus()?.state).toBe("listening");
  });

  test("reconnects back off with full jitter whose bound doubles from 1 s to 30 s, and start over once a ping comes back", async () => {
    jest.useFakeTimers();
    spies.push(spyOn(Math, "random").mockReturnValue(0.5));
    const attempts: number[] = [];
    let up = false;
    fakePg.listenerConnecting = async () => {
      attempts.push(Date.now());
      if (!up) throw nodeError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:5432");
    };

    startGovernanceListener(reload);
    await settle();
    const since = governanceListenerStatus()?.since;
    for (let retry = 0; retry < 7; retry += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt fails before the next one is timed.
      await nextTimer();
    }
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
    expect(gaps).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 15_000]);
    expect(listenerState()).toBe("reconnecting");
    // The state has held since the listener started, through every failed attempt.
    expect(governanceListenerStatus()?.since).toBe(since);

    up = true;
    await nextTimer();
    expect(listenerState()).toBe("listening");

    // A connection that drops before a ping came back keeps the bound where it was.
    latest().drop(nodeError("ECONNRESET", "read ECONNRESET"));
    let droppedAt = Date.now();
    await nextTimer();
    expect(Date.now() - droppedAt).toBe(15_000);
    expect(listenerState()).toBe("listening");

    // One ping that comes back starts the backoff over.
    await advance(60_000, 1000);
    latest().drop(nodeError("ECONNRESET", "read ECONNRESET"));
    droppedAt = Date.now();
    await nextTimer();
    expect(Date.now() - droppedAt).toBe(500);
    expect(listenerState()).toBe("listening");
  });

  test("a probe or ping that fails lets the connection go and reconnects", async () => {
    jest.useFakeTimers();
    startGovernanceListener(reload);
    await settle();
    const failing = latest();
    fakePg.listenerRespond = (sql, values, client) =>
      client === failing && sql === PING
        ? Promise.reject(nodeError("ECONNRESET", "read ECONNRESET"))
        : answerListener(sql, values, client);

    await advance(60_000, 1000);

    expect(listenerState()).toBe("reconnecting");
    expect(failing.ends).toBe(1);
    await nextTimer();
    expect(latest()).not.toBe(failing);
    expect(listenerState()).toBe("listening");
  });
});

describe("change notifications", () => {
  test("ten notifications within 100 ms cause exactly one reload", async () => {
    jest.useFakeTimers();
    startGovernanceListener(reload);
    await settle();
    reload.mockClear();

    for (let sent = 0; sent < 10; sent += 1) {
      latest().notify(NOTIFY_CHANNEL, HINT);
      jest.advanceTimersByTime(10);
    }
    jest.advanceTimersByTime(149);
    expect(reload).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);

    await advance(10_000, 1000);
    expect(reload).toHaveBeenCalledTimes(1);

    // A notification after that reload started gets a reload of its own.
    latest().notify(NOTIFY_CHANNEL, HINT);
    await advance(250);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test("the payload is only a hint: any notification on the channel reloads the whole snapshot, whatever it holds", async () => {
    jest.useFakeTimers();
    startGovernanceListener(reload);
    await settle();

    for (const payload of [HINT, '{"v":2,"kind":"everything"}', "null", "not json", ""]) {
      latest().notify(NOTIFY_CHANNEL, payload);
      // oxlint-disable-next-line no-await-in-loop -- one notification per reload window.
      await advance(250);
    }

    expect(reload).toHaveBeenCalledTimes(6);
    const hints = (logger.debug as ReturnType<typeof spyOn>).mock.calls
      .filter((call: unknown[]) => call[0] === "Governance change notification")
      .map((call: unknown[]) => (call[1] as { kind: string }).kind);
    expect(hints).toEqual(["grants", "unknown", "unknown", "unparsable", "unparsable"]);
  });

  test("a ping on the instance channel does not change last_notification_at", async () => {
    jest.useFakeTimers();
    startGovernanceListener(reload);
    await settle();
    expect(governanceListenerStatus()?.lastNotificationAt).toBeNull();

    await advance(60_000, 1000);
    const pings = latest().statements.filter((statement) => statement.sql === PING);
    expect(pings.map((ping) => ping.values)).toEqual([[PING_CHANNEL, expect.stringMatching(/^[0-9a-f]{16}$/)]]);
    expect(sqls(latest()).slice(2)).toEqual([PROBE, PING]);
    expect(governanceListenerStatus()?.lastNotificationAt).toBeNull();

    latest().notify(NOTIFY_CHANNEL, HINT);
    const heardAt = Date.now();
    expect(governanceListenerStatus()?.lastNotificationAt).toBe(heardAt);

    // A ping someone else sends on the instance channel, and the next real one, leave it where the change put it.
    latest().notify(PING_CHANNEL, "0123456789abcdef");
    await advance(60_000, 1000);
    expect(governanceListenerStatus()?.lastNotificationAt).toBe(heardAt);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(listenerState()).toBe("listening");
  });
});

describe("deafness and liveness", () => {
  test("two missed pings set deaf and reconnect", async () => {
    jest.useFakeTimers();
    startGovernanceListener(reload);
    await settle();
    const deaf = latest();
    // The session no longer hears its ping channel, as behind a pooler that moved it to another backend.
    deaf.channels.delete(PING_CHANNEL);

    await advance(120_000, 1000);
    expect(listenerState()).toBe("listening");
    expect(deaf.ends).toBe(0);

    await advance(60_000, 1000);
    expect(listenerState()).toBe("deaf");
    expect(deaf.ends).toBe(1);
    expect(deaf.statements.filter((statement) => statement.sql === PING)).toHaveLength(2);
    expect(warnings()).toEqual(["Governance listener is deaf: two pings did not come back"]);

    await nextTimer();
    expect(latest()).not.toBe(deaf);
    expect(sqls(latest())).toEqual(LISTENS);
    expect(listenerState()).toBe("listening");
  });

  test("a liveness query that does not answer within 5 s destroys the socket", async () => {
    jest.useFakeTimers();
    startGovernanceListener(reload);
    await settle();
    const halfOpen = latest();
    // The connection is half-open from here on: no statement answers, and nothing errors on its own.
    fakePg.listenerRespond = (sql, values, client) =>
      client === halfOpen ? new Promise(() => {}) : answerListener(sql, values, client);

    await advance(60_000, 1000);
    expect(sqls(halfOpen).at(-1)).toBe(PROBE);
    jest.advanceTimersByTime(4999);
    await settle();
    expect(halfOpen.destroyed).toBe(0);
    expect(listenerState()).toBe("listening");

    jest.advanceTimersByTime(1);
    await settle();
    expect(halfOpen.destroyed).toBe(1);
    expect(listenerState()).toBe("reconnecting");

    await nextTimer();
    expect(latest()).not.toBe(halfOpen);
    expect(listenerState()).toBe("listening");
  });

  test("a LISTEN that does not answer within 5 s destroys the socket and reconnects", async () => {
    jest.useFakeTimers();
    fakePg.listenerRespond = (sql, values, client) =>
      FakeListenerClient.made.length === 1 ? new Promise(() => {}) : answerListener(sql, values, client);

    startGovernanceListener(reload);
    await settle();
    jest.advanceTimersByTime(5000);
    await settle();

    expect(FakeListenerClient.made[0].destroyed).toBe(1);
    expect(listenerState()).toBe("reconnecting");
    expect(reload).not.toHaveBeenCalled();
    await nextTimer();
    expect(listenerState()).toBe("listening");
    expect(statementsAtReload).toEqual([LISTENS]);
  });
});

describe("a server that refuses LISTEN", () => {
  test("a refused LISTEN sets polling and keeps the refresher running", async () => {
    jest.useFakeTimers();
    let loads = 0;
    fakePg.connecting = async () => {
      loads += 1;
    };
    fakePg.listenerRespond = refuseListen;

    startGovernance();
    await settle();

    expect(listenerState()).toBe("polling");
    expect(latest().ends).toBe(1);
    expect(warnings()).toEqual([
      "Governance listener cannot LISTEN: only the periodic reload keeps the snapshot current",
    ]);
    // The refresher's first load; a listener that cannot listen asks for none.
    expect(loads).toBe(1);
    const since = governanceListenerStatus()?.since;

    await advance(30_000, 1000);

    expect(loads).toBe(2);
    expect(listenerState()).toBe("polling");
    expect(governanceListenerStatus()?.since).toBe(since);
    // The listener kept trying, within its backoff, and was refused each time.
    expect(FakeListenerClient.made.length).toBeGreaterThan(1);
    expect(FakeListenerClient.made.every((client) => client.ends === 1)).toBe(true);
  });

  test("a listener that polls listens again once the server accepts LISTEN", async () => {
    jest.useFakeTimers();
    fakePg.listenerRespond = refuseListen;
    startGovernanceListener(reload);
    await settle();
    expect(listenerState()).toBe("polling");
    expect(reload).not.toHaveBeenCalled();

    fakePg.listenerRespond = answerListener;
    await nextTimer();

    expect(listenerState()).toBe("listening");
    expect(statementsAtReload).toEqual([LISTENS]);
  });
});

describe("stopping", () => {
  test("stopping ends the connection and clears every timer, and nothing the connection still reports starts anything", async () => {
    jest.useFakeTimers();
    startGovernanceListener(reload);
    await settle();
    const client = latest();
    // A notification whose reload window is still open when the listener stops.
    client.notify(NOTIFY_CHANNEL, HINT);

    await stopGovernanceListener();

    expect(client.ends).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
    client.notify(NOTIFY_CHANNEL, HINT);
    client.drop(nodeError("ECONNRESET", "read ECONNRESET"));
    await advance(120_000, 1000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(FakeListenerClient.made).toHaveLength(1);
    expect(warnings()).toEqual([]);
    await stopGovernanceListener();
  });

  test("stopping while the connection opens leaves nothing running once it opens", async () => {
    jest.useFakeTimers();
    let open: () => void = () => {};
    fakePg.listenerConnecting = () =>
      new Promise<void>((resolve) => {
        open = resolve;
      });
    startGovernanceListener(reload);
    await settle();
    const opening = latest();

    await stopGovernanceListener();
    open();
    await settle();

    expect(opening.ends).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(governanceListenerStatus()).toBeNull();
  });

  test("a liveness query that answers after the listener stopped schedules no further check", async () => {
    jest.useFakeTimers();
    startGovernanceListener(reload);
    await settle();
    let answer: () => void = () => {};
    fakePg.listenerRespond = (sql, values, client) =>
      sql === PROBE
        ? new Promise((resolve) => {
            answer = () => resolve({ rows: [{ "?column?": 1 }] });
          })
        : answerListener(sql, values, client);
    await advance(60_000, 1000);

    await stopGovernanceListener();
    answer();
    await settle();

    expect(jest.getTimerCount()).toBe(0);
  });
});
