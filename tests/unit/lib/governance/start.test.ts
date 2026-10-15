/**
 * The governance refresher (docs/GOVERNANCE.md#operating-notes): `startGovernance()` loads the snapshot at once and
 * keeps reloading it every `GOVERNANCE_REFRESH_MS`, and every 5 s with jitter while the snapshot is absent or older
 * than the refresh interval, whether or not any request arrives. Loads are single-flight, a failed load never rejects,
 * and `register()` starts the refresher under governance without waiting for its first load.
 *
 * `pg` is the fake of tests/helpers/governance/pg-fake.ts, and the timers are bun's fake timers, which move
 * `Date.now()` with them, so every interval is checked in virtual time. The change notification listener that
 * `startGovernance()` also starts never connects here unless a case lets it, so the other cases count the refresher's
 * loads alone; tests/unit/lib/governance/listener.test.ts drives the listener itself. The heartbeat it starts is
 * replaced by counters here, because its beats would share the pool whose connections these cases count;
 * tests/unit/lib/governance/heartbeat.test.ts drives the heartbeat itself.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { keyringFileOf, removeKeyringFiles, testKey } from "../../../helpers/governance/keyring-file";
import {
  answerSnapshot,
  EMPTY_SOURCE,
  FakeListenerClient,
  FakePool,
  fakePg,
  nodeError,
  pgError,
  settle,
} from "../../../helpers/governance/pg-fake";

const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: FakeListenerClient, types: realPg.types }));
/** How many times the heartbeat was started and stopped. */
const heartbeat = { starts: 0, stops: 0 };
mock.module("@/lib/governance/heartbeat", () => ({
  startGovernanceHeartbeat: () => {
    heartbeat.starts += 1;
  },
  stopGovernanceHeartbeat: () => {
    heartbeat.stops += 1;
  },
}));

const { requestFreshGovernanceLoad, requestGovernanceLoad, startGovernance, stopGovernance } = await import(
  "@/lib/governance/start"
);
const { governanceFreshness } = await import("@/lib/governance/freshness");
const { governanceListenerStatus } = await import("@/lib/governance/listener");
const { governanceState, resetGovernanceState } = await import("@/lib/governance/state");
const { resetGovernanceKeyring } = await import("@/lib/governance/keyring");
const { resetShutdownHooks, runShutdownHooks } = await import("@/lib/shutdown");
const { register } = await import("@/instrumentation");
const { logger } = await import("@/lib/logger");

const KEYRING_FILE = keyringFileOf(testKey());

/** A governance install that passes the boot preflight, as docs/GOVERNANCE.md#studio-configuration describes it. */
const GOVERNED: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: "postgresql://libredb_studio@db.internal:5432/libredb?sslmode=verify-full",
  GOVERNANCE_INSTANCE_ID: "libredb-studio",
  GOVERNANCE_PRIVATE_KEYS_FILE: KEYRING_FILE,
  STORAGE_POSTGRES_SCHEMA: "studio",
  NEXT_PUBLIC_AUTH_PROVIDER: "oidc",
  OIDC_ROLE_CLAIM: "libredb_roles",
  OIDC_USER_ROLES: "user",
  // tests/setup.ts sets both passwords for every other test file; a governance install has none.
  ADMIN_PASSWORD: undefined,
  USER_PASSWORD: undefined,
  GOVERNANCE_POSTGRES_SCHEMA: undefined,
  GOVERNANCE_REFRESH_MS: undefined,
  GOVERNANCE_MAX_STALENESS_MS: undefined,
  GOVERNANCE_ALLOWED_ENGINES: undefined,
  NEXT_RUNTIME: undefined,
  AUTH_BOOTSTRAP: undefined,
  LIBREDB_NO_BANNER: undefined,
  LIBREDB_EMBEDDED_SAMPLE: undefined,
  SQLITE_EMBEDDED_SAMPLE: undefined,
};

let saved: Record<string, string | undefined> = {};
let spies: ReturnType<typeof spyOn>[] = [];

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The time of every connection attempt, in the order they were made. */
let attempts: number[] = [];
/** Whether the governance source accepts connections. */
let up = true;

beforeEach(() => {
  saved = {};
  for (const [name, value] of Object.entries(GOVERNED)) {
    saved[name] = process.env[name];
    setEnv(name, value);
  }
  fakePg.reset();
  attempts = [];
  up = true;
  heartbeat.starts = 0;
  heartbeat.stops = 0;
  fakePg.connecting = async () => {
    attempts.push(Date.now());
    if (!up) throw nodeError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:5432");
  };
  // The listener's connection stays opening: it asks for no load and holds no timer.
  fakePg.listenerConnecting = () => new Promise(() => {});
  spies = (["error", "warn", "info", "debug"] as const).map((level) =>
    spyOn(logger, level).mockImplementation(() => {}),
  );
});

afterEach(async () => {
  await stopGovernance();
  jest.useRealTimers();
  resetGovernanceState();
  resetGovernanceKeyring();
  resetShutdownHooks();
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  for (const spy of spies) spy.mockRestore();
});

afterAll(() => {
  removeKeyringFiles();
});

/** Moves virtual time by `ms` in steps, letting every load the timers start finish on the way. */
async function advance(ms: number, step = 100): Promise<void> {
  for (let moved = 0; moved < ms; moved += step) {
    jest.advanceTimersByTime(Math.min(step, ms - moved));
    // oxlint-disable-next-line no-await-in-loop -- each step's loads finish before virtual time moves on.
    await settle();
  }
}

/**
 * Fires the next `count` timers, each at its exact due time, letting the load it starts finish before the next, so
 * the timer that load sets is measured from the moment it ended.
 */
async function nextTimers(count: number): Promise<void> {
  for (let fired = 0; fired < count; fired += 1) {
    jest.advanceTimersToNextTimer();
    // oxlint-disable-next-line no-await-in-loop -- a load ends before the next timer fires, as in real time.
    await settle();
  }
}

/** The gaps between consecutive connection attempts. */
const gaps = (): number[] => attempts.slice(1).map((at, index) => at - attempts[index]);

describe("the refresher", () => {
  test("the first load fails, no request arrives, the database returns, and the refresher loads within 10 s", async () => {
    jest.useFakeTimers();
    up = false;

    startGovernance();
    await settle();
    expect(attempts).toHaveLength(1);
    expect(governanceFreshness()).toBe("loading");

    up = true;
    const returnedAt = Date.now();
    while (governanceFreshness() !== "ok" && Date.now() - returnedAt <= 10_000) {
      // oxlint-disable-next-line no-await-in-loop -- virtual time moves in order, 100 ms at a time.
      await advance(100);
    }

    expect(governanceFreshness()).toBe("ok");
    expect(Date.now() - returnedAt).toBeLessThanOrEqual(10_000);
  });

  test("after a successful load the next one waits GOVERNANCE_REFRESH_MS", async () => {
    jest.useFakeTimers();
    process.env.GOVERNANCE_REFRESH_MS = "45000";
    process.env.GOVERNANCE_MAX_STALENESS_MS = "180000";

    startGovernance();
    await settle();
    await advance(44_900);
    expect(attempts).toHaveLength(1);
    await advance(100);

    expect(attempts).toHaveLength(2);
    expect(gaps()).toEqual([45_000]);
    expect(governanceFreshness()).toBe("ok");
  });

  test("while the snapshot is absent the refresher retries 4 to 6 s after each failed load", async () => {
    jest.useFakeTimers();
    up = false;

    startGovernance();
    await settle();
    await nextTimers(10);

    expect(attempts).toHaveLength(11);
    for (const gap of gaps()) {
      expect(gap).toBeGreaterThanOrEqual(4000);
      expect(gap).toBeLessThanOrEqual(6000);
    }
    expect(governanceFreshness()).toBe("loading");
  });

  test("once reloads fail past the refresh interval it retries 4 to 6 s apart, and keeps the interval again after one succeeds", async () => {
    jest.useFakeTimers();

    startGovernance();
    await settle();
    up = false;
    await nextTimers(1);
    expect(gaps()).toEqual([30_000]);
    expect(governanceFreshness()).toBe("degraded");

    await nextTimers(5);
    const retries = gaps().slice(1);
    expect(retries).toHaveLength(5);
    for (const gap of retries) {
      expect(gap).toBeGreaterThanOrEqual(4000);
      expect(gap).toBeLessThanOrEqual(6000);
    }

    up = true;
    await nextTimers(1);
    expect(governanceFreshness()).toBe("ok");
    await nextTimers(1);
    expect(gaps().at(-1)).toBe(30_000);
  });

  test("a misconfigured source with a fresh snapshot is retried when the snapshot reaches the refresh interval", async () => {
    jest.useFakeTimers();
    startGovernance();
    await settle();
    const loadedAt = attempts[0];
    await advance(10_000);
    // A reload 10 s after the first load finds the schema's USAGE revoked.
    fakePg.respond = async (sql) => {
      if (sql.includes(".contract")) throw pgError("42501", "permission denied for schema bridge");
      return answerSnapshot(EMPTY_SOURCE)(sql);
    };
    await requestGovernanceLoad();
    expect(governanceFreshness()).toBe("misconfigured");

    await nextTimers(1);
    expect(attempts.map((at) => at - loadedAt)).toEqual([0, 10_000, 30_000]);
  });

  test("loads requested while one runs join it, and the next request starts a new one", async () => {
    let connect: () => void = () => {};
    fakePg.connecting = () =>
      new Promise((resolve) => {
        attempts.push(Date.now());
        connect = resolve;
      });

    const first = requestGovernanceLoad();
    const second = requestGovernanceLoad();
    expect(second).toBe(first);
    connect();
    await first;
    expect(attempts).toHaveLength(1);
    expect(governanceFreshness()).toBe("ok");

    const third = requestGovernanceLoad();
    expect(third).not.toBe(first);
    connect();
    await third;
    expect(attempts).toHaveLength(2);
  });

  test("a load requested without the refresher schedules no further load", async () => {
    jest.useFakeTimers();

    await requestGovernanceLoad();

    expect(jest.getTimerCount()).toBe(0);
    await advance(60_000, 1000);
    expect(attempts).toHaveLength(1);
  });

  test("a failed load never rejects", async () => {
    up = false;

    await expect(requestGovernanceLoad()).resolves.toBeUndefined();
    expect(governanceState().failure?.code).toBe("ECONNREFUSED");
  });

  test("starting twice runs one refresher", async () => {
    jest.useFakeTimers();

    startGovernance();
    startGovernance();
    await settle();

    expect(attempts).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  test("stopping clears the timer, closes the pool, and a load that finishes afterwards schedules nothing", async () => {
    jest.useFakeTimers();
    startGovernance();
    await settle();
    const [pool] = FakePool.made;

    let connect: () => void = () => {};
    fakePg.connecting = () =>
      new Promise((resolve) => {
        connect = resolve;
      });
    const inFlight = requestGovernanceLoad();
    await stopGovernance();
    connect();
    await inFlight;

    expect(pool.ended).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("loads that must start after a change", () => {
  test("a fresh load waits for the load under way and starts the next one, which a second caller joins", async () => {
    let connect: () => void = () => {};
    fakePg.connecting = () =>
      new Promise((resolve) => {
        attempts.push(Date.now());
        connect = resolve;
      });

    const underWay = requestGovernanceLoad();
    const fresh = requestFreshGovernanceLoad();
    const joining = requestFreshGovernanceLoad();
    await settle();
    expect(attempts).toHaveLength(1);

    connect();
    await underWay;
    await settle();
    expect(attempts).toHaveLength(2);
    expect(governanceFreshness()).toBe("ok");

    connect();
    await Promise.all([fresh, joining]);
    expect(attempts).toHaveLength(2);
  });

  test("with no load under way a fresh load starts at once", async () => {
    await requestFreshGovernanceLoad();

    expect(attempts).toHaveLength(1);
    expect(governanceFreshness()).toBe("ok");
  });
});

describe("the listener", () => {
  test("startGovernance() starts the listener, whose LISTEN is followed by a load that starts after it", async () => {
    let connect: () => void = () => {};
    fakePg.connecting = () =>
      new Promise((resolve) => {
        attempts.push(Date.now());
        connect = resolve;
      });
    fakePg.listenerConnecting = async () => {};

    startGovernance();
    await settle();
    // The first load is under way, and the listener has issued LISTEN: its load waits for the first one to end.
    expect(governanceListenerStatus()?.state).toBe("listening");
    expect(attempts).toHaveLength(1);

    connect();
    await settle();
    expect(attempts).toHaveLength(2);
    connect();
    await settle();
    expect(governanceFreshness()).toBe("ok");
  });

  test("startGovernance() registers the shutdown hook that stops the refresher, the listener and the pool", async () => {
    jest.useFakeTimers();
    fakePg.listenerConnecting = async () => {};
    startGovernance();
    await settle();
    const [pool] = FakePool.made;
    const [listening] = FakeListenerClient.made;

    await runShutdownHooks();

    expect(governanceListenerStatus()).toBeNull();
    expect(listening.ends).toBe(1);
    expect(pool.ended).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("startGovernance() starts the heartbeat once, and stopping governance stops it", async () => {
    startGovernance();
    startGovernance();
    expect(heartbeat).toEqual({ starts: 1, stops: 0 });

    await stopGovernance();

    expect(heartbeat).toEqual({ starts: 1, stops: 1 });
  });
});

describe("register()", () => {
  test("register() starts the refresher under governance without waiting for its first load", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_NO_BANNER = "1";
    let connect: () => void = () => {};
    fakePg.connecting = () =>
      new Promise((resolve) => {
        attempts.push(Date.now());
        connect = resolve;
      });

    await register();

    // The first load is under way and has not finished: register() did not wait for it.
    expect(attempts).toHaveLength(1);
    expect(governanceFreshness()).toBe("loading");
    connect();
    await requestGovernanceLoad();
    expect(governanceFreshness()).toBe("ok");
  });

  test("register() without GOVERNANCE_SOURCE never makes the governance pool", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_NO_BANNER = "1";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.GOVERNANCE_SOURCE;

    await register();
    await settle();

    expect(FakePool.made).toEqual([]);
    expect(FakeListenerClient.made).toEqual([]);
    expect(attempts).toEqual([]);
    expect(governanceFreshness()).toBe("loading");
  });
});
