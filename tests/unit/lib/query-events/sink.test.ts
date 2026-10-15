/**
 * The query event sink (docs/GOVERNANCE.md#query-events): `recordQueryEvent()` is a synchronous enqueue that never
 * throws and does nothing outside governance, where no pool is opened; the queue holds at most 10000 events and drops
 * the newest beyond that; it flushes every second, or at once at 500 events, and once more at shutdown within the
 * hook's deadline; and its state is what the heartbeat reports, in the manifest's `sink` shape.
 *
 * `pg` is the fake of tests/helpers/governance/pg-fake.ts, so every insert and heartbeat is seen. The listener is
 * replaced by a status this file sets, as in heartbeat.test.ts, so a beat can be sent without one running.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GovernanceListenerStatus } from "@/lib/governance/listener";
import { keyringFileOf, removeKeyringFiles, testKey } from "../../../helpers/governance/keyring-file";
import { type FakeClient, FakePool, fakePg, pgError, settle } from "../../../helpers/governance/pg-fake";
import { queryEventInput, startInTheFuture } from "../../../helpers/governance/query-event-input";

const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: realPg.Client, types: realPg.types }));
const listenerStatus: GovernanceListenerStatus = { state: "listening", since: 0, lastNotificationAt: null };
mock.module("@/lib/governance/listener", () => ({ governanceListenerStatus: () => listenerStatus }));

const {
  flushQueryEvents,
  QUERY_EVENT_BATCH_ROWS,
  QUERY_EVENT_QUEUE_CAPACITY,
  queryEventSinkState,
  recordQueryEvent,
  resetQueryEventSink,
} = await import("@/lib/query-events/sink");
const { sendGovernanceHeartbeat } = await import("@/lib/governance/heartbeat");
const { buildHeartbeatUpsert, HEARTBEAT_COLUMNS, QUERY_EVENT_COLUMNS } = await import("@/lib/governance/contract");
const { closeGovernancePool } = await import("@/lib/governance/db");
const { resetGovernanceKeyring } = await import("@/lib/governance/keyring");
const { resetShutdownHooks, runShutdownHooks } = await import("@/lib/shutdown");
const { logger } = await import("@/lib/logger");

const ROOT = path.resolve(import.meta.dir, "../../../..");

const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/governance/contract-v1.json"), "utf8")) as {
  readonly heartbeat: { readonly sink: { readonly schema: Record<string, unknown> } };
};

/** The sink shape the manifest publishes, as a validator (see governance-contract-manifest.test.ts). */
const SINK_SHAPE = z.fromJSONSchema(MANIFEST.heartbeat.sink.schema);

const IDLE = { queued: 0, dropped: 0, rejected: 0, lastFlushAt: null, backingOff: false, lastSqlstate: null };

const ENV: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: "postgresql://libredb_studio@db.internal:5432/libredb?sslmode=verify-full",
  GOVERNANCE_INSTANCE_ID: "libredb-studio",
  GOVERNANCE_PRIVATE_KEYS_FILE: keyringFileOf(testKey()),
  GOVERNANCE_POSTGRES_SCHEMA: undefined,
  NEXT_PUBLIC_APP_VERSION: "0.19.0",
};

let saved: Record<string, string | undefined> = {};
let spies: Record<"stdout" | "warn" | "error" | "info", ReturnType<typeof spyOn>>;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved = {};
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    setEnv(name, value);
  }
  fakePg.reset();
  fakePg.respond = async () => ({ rows: [] });
  spies = {
    stdout: spyOn(console, "log").mockImplementation(() => {}),
    warn: spyOn(logger, "warn").mockImplementation(() => {}),
    error: spyOn(logger, "error").mockImplementation(() => {}),
    // The keyring logs the kids it loaded.
    info: spyOn(logger, "info").mockImplementation(() => {}),
  };
});

afterEach(async () => {
  resetQueryEventSink();
  resetShutdownHooks();
  jest.useRealTimers();
  await closeGovernancePool();
  resetGovernanceKeyring();
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  for (const spy of Object.values(spies)) spy.mockRestore();
});

afterAll(() => {
  removeKeyringFiles();
});

/** Every client the governance pool handed out, in order. */
const clients = (): FakeClient[] => FakePool.made.flatMap((pool) => pool.clients);

const INSERT_PREFIX = 'INSERT INTO "bridge".query_events_v1 ';

/** A value of every row each query event insert carried, in the order they were sent. */
function inserted(column: (typeof QUERY_EVENT_COLUMNS)[number]): unknown[] {
  const width = QUERY_EVENT_COLUMNS.length;
  const offset = QUERY_EVENT_COLUMNS.indexOf(column);
  return clients().flatMap((client) =>
    client.statements.flatMap((sql, index) => {
      if (!sql.startsWith(INSERT_PREFIX)) return [];
      const values = client.parameters[index] ?? [];
      return Array.from({ length: values.length / width }, (_, row) => values[row * width + offset]);
    }),
  );
}

/** Lets the timers move `ms` on, then lets every insert they started settle. */
async function elapse(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await settle();
}

/** Lets inserts that follow one another settle, until the queue is empty. */
async function drain(): Promise<void> {
  for (let round = 0; round < 100 && queryEventSinkState().queued > 0; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each round lets the inserts started by the one before it settle.
    await settle();
  }
}

describe("recordQueryEvent", () => {
  test("outside governance recordQueryEvent creates no pool", async () => {
    jest.useFakeTimers();
    delete process.env.GOVERNANCE_SOURCE;

    recordQueryEvent(queryEventInput());
    // Not even an input no row can be made of is looked at.
    recordQueryEvent(queryEventInput({ connection: { id: "orders", name: null, engine: null, accessLevel: null } }));

    expect(jest.getTimerCount()).toBe(0);
    await elapse(60_000);
    await flushQueryEvents();
    await runShutdownHooks();
    expect(FakePool.made).toEqual([]);
    expect(queryEventSinkState()).toEqual(IDLE);
    expect(spies.error).not.toHaveBeenCalled();
  });

  test("an event waits at most a second for its insert", async () => {
    jest.useFakeTimers();
    recordQueryEvent(queryEventInput({ correlationId: "a" }));
    await elapse(500);
    recordQueryEvent(queryEventInput({ correlationId: "b" }));
    expect(queryEventSinkState()).toMatchObject({ queued: 2 });

    await elapse(499);
    expect(FakePool.made).toEqual([]);
    await elapse(1);

    expect(inserted("correlation_id")).toEqual(["a", "b"]);
    expect(queryEventSinkState()).toMatchObject({ queued: 0, backingOff: false });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("an input no row can be made of is logged without a throw, and nothing is queued", () => {
    const refused = queryEventInput({ source: "multi-query", unitIndex: -1 });

    expect(() => recordQueryEvent(refused)).not.toThrow();

    expect(queryEventSinkState()).toEqual(IDLE);
    expect(spies.error).toHaveBeenCalledTimes(1);
    const [message, error, context] = spies.error.mock.calls[0];
    expect(message).toBe("Query event not recorded: no row can be made of it");
    expect((error as Error).message).toBe("unit_index must be a whole number from 0 to 2147483647, got -1");
    expect(context).toEqual({ route: "query-events", source: "multi-query" });
  });

  test("a full queue drops the newest event and counts it", async () => {
    jest.useFakeTimers();
    let answer: () => void = () => {};
    // The governance source does not answer, so the queue only grows.
    fakePg.connecting = () =>
      new Promise((resolve) => {
        answer = resolve;
      });

    for (let unit = 0; unit <= QUERY_EVENT_QUEUE_CAPACITY; unit += 1) {
      recordQueryEvent(queryEventInput({ unitIndex: unit }));
    }
    expect(queryEventSinkState()).toMatchObject({ queued: 10_000, dropped: 1 });
    recordQueryEvent(queryEventInput({ unitIndex: QUERY_EVENT_QUEUE_CAPACITY + 1 }));
    expect(queryEventSinkState()).toMatchObject({ queued: 10_000, dropped: 2 });
    // One line for the spell of drops, not one per dropped event.
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledWith("Query event queue full: new events are dropped until it has room", {
      route: "query-events",
      capacity: 10_000,
    });

    fakePg.connecting = async () => {};
    answer();
    await drain();

    // Every queued event went in, oldest first, in batches of 500; the two newest never did.
    const units = inserted("unit_index");
    expect(units).toEqual(Array.from({ length: QUERY_EVENT_QUEUE_CAPACITY }, (_, unit) => unit));
    expect(clients()).toHaveLength(QUERY_EVENT_QUEUE_CAPACITY / QUERY_EVENT_BATCH_ROWS);
    expect(queryEventSinkState()).toMatchObject({ queued: 0, dropped: 2, backingOff: false });

    // With room again, the next spell of drops is logged again.
    fakePg.connecting = () => new Promise(() => {});
    for (let unit = 0; unit <= QUERY_EVENT_QUEUE_CAPACITY; unit += 1) recordQueryEvent(queryEventInput());
    expect(queryEventSinkState()).toMatchObject({ queued: 10_000, dropped: 3 });
    expect(spies.warn).toHaveBeenCalledTimes(2);
  });
});

describe("shutdown", () => {
  test("the shutdown hook flushes queued events within its deadline", async () => {
    jest.useFakeTimers();
    recordQueryEvent(queryEventInput({ correlationId: "a" }));
    recordQueryEvent(queryEventInput({ correlationId: "b" }));

    // The second has not passed: the hook sends them at once.
    await runShutdownHooks();

    expect(inserted("correlation_id")).toEqual(["a", "b"]);
    expect(queryEventSinkState()).toMatchObject({ queued: 0, backingOff: false });
    // Nothing is armed after the shutdown, and an event recorded during it is left for the hook alone.
    expect(jest.getTimerCount()).toBe(0);
    recordQueryEvent(queryEventInput({ correlationId: "late" }));
    expect(jest.getTimerCount()).toBe(0);
    expect(spies.warn).not.toHaveBeenCalled();
  });

  test("the shutdown flush ignores the backoff and sends every batch", async () => {
    jest.useFakeTimers();
    let refuse = true;
    fakePg.respond = async () => {
      if (refuse) throw pgError("57P01", "terminating connection due to administrator command", "FATAL");
      return { rows: [] };
    };
    for (let unit = 0; unit < 499; unit += 1) recordQueryEvent(queryEventInput({ unitIndex: unit }));
    await elapse(1000);
    expect(queryEventSinkState()).toMatchObject({ queued: 499, backingOff: true });
    for (let unit = 499; unit < 1100; unit += 1) recordQueryEvent(queryEventInput({ unitIndex: unit }));

    refuse = false;
    await flushQueryEvents();

    expect(inserted("unit_index").slice(499)).toEqual(Array.from({ length: 1100 }, (_, unit) => unit));
    expect(queryEventSinkState()).toMatchObject({ queued: 0, backingOff: false });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("an insert under way when the shutdown begins ends first, and the rest follows it", async () => {
    jest.useFakeTimers();
    let answer: () => void = () => {};
    fakePg.respond = () =>
      new Promise((resolve) => {
        answer = () => resolve({ rows: [] });
      });
    for (let unit = 0; unit < 600; unit += 1) recordQueryEvent(queryEventInput({ unitIndex: unit }));
    await settle();
    expect(clients()).toHaveLength(1);

    const shutdown = runShutdownHooks();
    await settle();
    fakePg.respond = async () => ({ rows: [] });
    answer();
    await shutdown;

    expect(inserted("unit_index")).toEqual(Array.from({ length: 600 }, (_, unit) => unit));
    expect(clients()).toHaveLength(2);
    expect(queryEventSinkState()).toMatchObject({ queued: 0 });
  });

  test("a governance source that does not answer holds the hook 4 s at most, before the hooks' own 5 s cut", async () => {
    jest.useFakeTimers();
    fakePg.respond = () => new Promise(() => {});
    recordQueryEvent(queryEventInput());
    recordQueryEvent(queryEventInput());

    let ended = false;
    const shutdown = runShutdownHooks().then(() => {
      ended = true;
    });
    await elapse(3999);
    expect(ended).toBe(false);
    await elapse(1);
    await shutdown;

    expect(clients()[0].releasedWith).toBeInstanceOf(Error);
    expect(spies.warn).toHaveBeenCalledWith("Query events not flushed at shutdown", {
      route: "query-events",
      unsent: 2,
    });
    expect(spies.warn).not.toHaveBeenCalledWith("Shutdown hooks cut at the deadline", expect.anything());
  });

  test("an insert under way that outlives the deadline leaves the rest unsent", async () => {
    jest.useFakeTimers();
    fakePg.respond = () => new Promise(() => {});
    for (let unit = 0; unit < 500; unit += 1) recordQueryEvent(queryEventInput({ unitIndex: unit }));
    await settle();

    const shutdown = runShutdownHooks();
    await elapse(4000);
    await shutdown;

    // The hook never started an insert of its own.
    expect(clients()).toHaveLength(1);
    expect(spies.warn).toHaveBeenCalledWith("Query events not flushed at shutdown", {
      route: "query-events",
      unsent: 500,
    });
  });
});

describe("the sink state", () => {
  /** The `sink` parameter of the heartbeat sent last, parsed. */
  function sentSink(): unknown {
    const beat = clients()
      .flatMap((client) => client.statements.map((sql, index) => ({ sql, values: client.parameters[index] })))
      .findLast(({ sql }) => sql === buildHeartbeatUpsert("bridge"));
    return JSON.parse(String(beat?.values?.[HEARTBEAT_COLUMNS.indexOf("sink")]));
  }

  test("the sink state the heartbeat sends validates against the manifest's sink shape", async () => {
    jest.useFakeTimers();
    await sendGovernanceHeartbeat();
    expect(sentSink()).toEqual(IDLE);
    expect(SINK_SHAPE.safeParse(sentSink()).success).toBe(true);

    // A refusal for good, then a transient failure: every field of the state carries a value.
    let failure = pgError(
      "23514",
      'new row for relation "query_event" violates check constraint "query_event_not_future"',
    );
    fakePg.respond = async (sql, client) => {
      const values = client.parameters.at(-1) ?? [];
      const future = Date.parse(String(values[1])) > Date.now() + 5 * 60_000;
      if (sql.startsWith(INSERT_PREFIX) && (future || failure.message.startsWith("terminating"))) throw failure;
      return { rows: [] };
    };
    recordQueryEvent(queryEventInput({ started: startInTheFuture() }));
    await elapse(1000);
    const flushedAt = new Date().toISOString();
    failure = pgError("57P01", "terminating connection due to administrator command", "FATAL");
    recordQueryEvent(queryEventInput());
    await elapse(1000);

    await sendGovernanceHeartbeat();

    const expected = {
      queued: 1,
      dropped: 0,
      rejected: 1,
      lastFlushAt: flushedAt,
      backingOff: true,
      lastSqlstate: "57P01",
    };
    expect(queryEventSinkState()).toEqual(expected);
    expect(sentSink()).toEqual(expected);
    expect(SINK_SHAPE.safeParse(sentSink()).success).toBe(true);
    expect(Object.keys(sentSink() as object)).toEqual(Object.keys(MANIFEST.heartbeat.sink.schema.properties as object));
  });
});
