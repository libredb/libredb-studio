/**
 * The admission gate of query execution (docs/GOVERNANCE.md#query-events): with `queryLog.onSinkFailure` at `refuse`,
 * `admitQueryExecution()` refuses with 503 AUDIT_UNAVAILABLE while the query event sink backs off or its queue holds
 * at least 90% of its capacity; a row the governance source refused for good never trips it; and with `continue`, the
 * default, or with governance off, it never refuses.
 *
 * The sink is the real one, driven as a route drives it: events are recorded through `recordQueryEvent()` on fake
 * timers, and `pg` is the fake of tests/helpers/governance/pg-fake.ts, so a test decides how each insert goes.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { grantedSnapshot } from "../../../helpers/governance/granted-snapshot";
import { type FakeClient, FakePool, fakePg, pgError, settle } from "../../../helpers/governance/pg-fake";
import { queryEventInput } from "../../../helpers/governance/query-event-input";

const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: realPg.Client, types: realPg.types }));

const { admitQueryExecution } = await import("@/lib/query-events/admission");
const { QUERY_EVENT_QUEUE_CAPACITY, queryEventSinkState, recordQueryEvent, resetQueryEventSink } = await import(
  "@/lib/query-events/sink"
);
const { createErrorResponse } = await import("@/lib/api/errors");
const { API_CODES, QUERY_EVENT_COLUMNS } = await import("@/lib/governance/contract");
const { closeGovernancePool } = await import("@/lib/governance/db");
const { validateSettings } = await import("@/lib/governance/settings");
const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");
const { SeedConnectionError } = await import("@/lib/seed/resolve-connection");
const { logger } = await import("@/lib/logger");

const REFUSAL_MESSAGE = "Query execution is unavailable while this server cannot record query events";

const ENV: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: "postgresql://libredb_studio@db.internal:5432/libredb?sslmode=verify-full",
  GOVERNANCE_INSTANCE_ID: "libredb-studio",
  GOVERNANCE_POSTGRES_SCHEMA: undefined,
};

let saved: Record<string, string | undefined> = {};
let spies: ReturnType<typeof spyOn>[] = [];

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
  spies = [
    // The sink's rejection lines, and its warnings about failed inserts and a full queue; the refusal's own warning.
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(logger, "warn").mockImplementation(() => {}),
  ];
});

afterEach(async () => {
  resetQueryEventSink();
  jest.useRealTimers();
  await closeGovernancePool();
  resetGovernanceState();
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  for (const spy of spies) spy.mockRestore();
});

/** Swaps in a snapshot whose `settings_v1` holds `rows`, as a load of the governance source does. */
function settingsRows(...rows: { readonly key: string; readonly value: unknown }[]): void {
  recordGovernanceSnapshot({
    ...grantedSnapshot([], []),
    settings: validateSettings(
      rows.map(({ key, value }) => ({ key, value, updated_at: new Date() })),
      1,
    ),
  });
}

const onSinkFailure = (value: unknown): void => settingsRows({ key: "queryLog.onSinkFailure", value });

/** What `admitQueryExecution()` threw, or undefined when it admitted the execution. */
function refusal(): unknown {
  try {
    admitQueryExecution();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Lets the timers move `ms` on, then lets every insert they started settle. */
async function elapse(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await settle();
}

/** A governance source that went away: every insert ends with 57P01, a failure that is not for good. */
async function terminated(): Promise<never> {
  throw pgError("57P01", "terminating connection due to administrator command", "FATAL");
}

/** The correlation ids of the rows of the statement `client` is answering. */
function correlationIds(client: FakeClient): unknown[] {
  const values = client.parameters.at(-1) ?? [];
  const width = QUERY_EVENT_COLUMNS.length;
  const offset = QUERY_EVENT_COLUMNS.indexOf("correlation_id");
  return Array.from({ length: values.length / width }, (_, row) => values[row * width + offset]);
}

/** Records events until the queue holds `queued` of them, and lets what they started settle. */
async function queueUpTo(queued: number): Promise<void> {
  for (let held = queryEventSinkState().queued; held < queued; held += 1) recordQueryEvent(queryEventInput());
  await settle();
}

describe("admitQueryExecution", () => {
  test("refuse mode throws 503 AUDIT_UNAVAILABLE while the sink backs off", async () => {
    jest.useFakeTimers();
    onSinkFailure("refuse");
    fakePg.respond = terminated;
    recordQueryEvent(queryEventInput());
    // The insert is due in a second, so nothing has failed yet.
    expect(refusal()).toBeUndefined();

    await elapse(1000);
    expect(queryEventSinkState()).toMatchObject({ queued: 1, backingOff: true, lastSqlstate: "57P01" });

    const error = refusal();
    expect(error).toBeInstanceOf(SeedConnectionError);
    expect(error).toMatchObject({ message: REFUSAL_MESSAGE, statusCode: 503, code: "AUDIT_UNAVAILABLE" });
    // A route answers it as every refusal before execution, with the status and code contract v1 publishes for it.
    const response = createErrorResponse(error, { route: "POST /api/db/query" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: REFUSAL_MESSAGE, code: "AUDIT_UNAVAILABLE", statusCode: 503 });
    const published: readonly { code: string; httpStatus: number }[] = API_CODES;
    expect(published).toContainEqual({ code: "AUDIT_UNAVAILABLE", httpStatus: response.status });

    // Once an insert settles its whole batch the sink stops backing off, and executions are admitted again.
    fakePg.respond = async () => ({ rows: [] });
    await elapse(1000);
    expect(queryEventSinkState()).toMatchObject({ queued: 0, backingOff: false });
    expect(refusal()).toBeUndefined();
  });

  test("refuse mode throws 503 AUDIT_UNAVAILABLE from 9000 queued events, 90% of the queue", async () => {
    jest.useFakeTimers();
    onSinkFailure("refuse");
    // The governance source accepts no connection: the first insert waits for one and would fail only at its 10 s
    // deadline, which these timers never reach, so the sink does not back off and the queue only grows.
    fakePg.connecting = () => new Promise(() => {});
    expect(QUERY_EVENT_QUEUE_CAPACITY).toBe(10_000);

    await queueUpTo(8999);
    expect(queryEventSinkState()).toMatchObject({ queued: 8999, backingOff: false });
    expect(refusal()).toBeUndefined();

    await queueUpTo(9000);
    expect(queryEventSinkState()).toMatchObject({ queued: 9000, backingOff: false });
    expect(refusal()).toMatchObject({ message: REFUSAL_MESSAGE, statusCode: 503, code: "AUDIT_UNAVAILABLE" });
  });

  test("refuse mode admits when only permanent rejections occurred", async () => {
    jest.useFakeTimers();
    onSinkFailure("refuse");
    // A batch with a refused row fails whole, so the sink sends its rows one by one and drops only the refused ones.
    fakePg.respond = async (_sql, client) => {
      const ids = correlationIds(client);
      if (ids.includes("integrity")) {
        throw pgError("23514", 'new row for relation "query_event" violates check constraint "query_event_not_future"');
      }
      if (ids.includes("data")) throw pgError("22P02", "invalid input syntax for type inet");
      return { rows: [] };
    };
    for (const correlationId of ["kept", "integrity", "data"]) recordQueryEvent(queryEventInput({ correlationId }));

    await elapse(1000);

    // Both refusals for good were dropped and counted, and the sink does not back off after them.
    expect(queryEventSinkState()).toMatchObject({ queued: 0, rejected: 2, backingOff: false, lastSqlstate: "22P02" });
    expect(refusal()).toBeUndefined();
  });

  test("continue mode never refuses", async () => {
    jest.useFakeTimers();
    fakePg.respond = terminated;
    recordQueryEvent(queryEventInput());
    await elapse(1000);
    // The sink backs off, and the events recorded while it waits fill its queue past 90% and up to the cap.
    await queueUpTo(QUERY_EVENT_QUEUE_CAPACITY);
    recordQueryEvent(queryEventInput());
    expect(queryEventSinkState()).toMatchObject({ queued: 10_000, dropped: 1, backingOff: true });
    onSinkFailure("refuse");
    expect(refusal()).toMatchObject({ statusCode: 503, code: "AUDIT_UNAVAILABLE" });

    onSinkFailure("continue");
    expect(refusal()).toBeUndefined();
    // No value, and a value outside the setting's domain, which is ignored, leave the default: continue.
    settingsRows();
    expect(refusal()).toBeUndefined();
    onSinkFailure("stop");
    expect(refusal()).toBeUndefined();
    // So does a governance source not loaded yet.
    resetGovernanceState();
    expect(refusal()).toBeUndefined();
  });

  test("with governance off it never refuses, whatever the sink and the last snapshot say", async () => {
    jest.useFakeTimers();
    onSinkFailure("refuse");
    fakePg.respond = terminated;
    recordQueryEvent(queryEventInput());
    await elapse(1000);
    expect(refusal()).toMatchObject({ statusCode: 503, code: "AUDIT_UNAVAILABLE" });

    delete process.env.GOVERNANCE_SOURCE;

    expect(refusal()).toBeUndefined();
  });
});
