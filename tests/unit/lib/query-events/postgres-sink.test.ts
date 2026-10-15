/**
 * The PostgreSQL side of the query event sink (spec 7.9): a batch goes in as the manifest's multi-row
 * `INSERT ... ON CONFLICT DO NOTHING` through the governance pool; a row the governance source refuses for good,
 * SQLSTATE class 22 or 23, is dropped alone and logged as one stdout line without statement text; and any other
 * failure keeps the batch, with its event ids, for a retry after a wait that doubles from 1 s to 30 s.
 *
 * `pg` is the fake of tests/helpers/governance/pg-fake.ts, so each statement and its parameters are seen, and the
 * events are recorded through `recordQueryEvent()`, as a route records them, on fake timers.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { grantedSnapshot } from "../../../helpers/governance/granted-snapshot";
import { type FakeClient, FakePool, fakePg, nodeError, pgError, settle } from "../../../helpers/governance/pg-fake";
import { queryEventInput, startInTheFuture } from "../../../helpers/governance/query-event-input";

const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: realPg.Client, types: realPg.types }));

const { queryEventSinkState, recordQueryEvent, resetQueryEventSink } = await import("@/lib/query-events/sink");
const { queryEventBackoffMs } = await import("@/lib/query-events/postgres-sink");
const { buildQueryEventInsert, QUERY_EVENT_COLUMNS } = await import("@/lib/governance/contract");
const { closeGovernancePool } = await import("@/lib/governance/db");
const { validateSettings } = await import("@/lib/governance/settings");
const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");
const { logger } = await import("@/lib/logger");

const ROOT = path.resolve(import.meta.dir, "../../../..");

interface Manifest {
  readonly statements: readonly { readonly id: string; readonly sql: string }[];
  readonly objects: readonly { readonly name: string; readonly columns: readonly { readonly name: string }[] }[];
}

const MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, "tests/fixtures/governance/contract-v1.json"), "utf8"),
) as Manifest;

const MANIFEST_INSERT = MANIFEST.statements.find((statement) => statement.id === "queryEvents.insert")?.sql as string;
const VIEW_COLUMNS = MANIFEST.objects
  .find((object) => object.name === "query_events_v1")
  ?.columns.map((column) => column.name);

/** A statement whose text no log line may carry. */
const STATEMENT = "SELECT card_number FROM payments WHERE note = 'example-only-statement-canary-9d2e'";
const STATEMENT_CANARY = "example-only-statement-canary-9d2e";

const ENV: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: "postgresql://libredb_studio@db.internal:5432/libredb?sslmode=verify-full",
  GOVERNANCE_INSTANCE_ID: "libredb-studio",
  GOVERNANCE_POSTGRES_SCHEMA: undefined,
};

let saved: Record<string, string | undefined> = {};
let stdout: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;
/** The event ids the fake governance source holds, in the order they landed. */
let landed: string[] = [];

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
  landed = [];
  fakePg.respond = holdRows;
  stdout = spyOn(console, "log").mockImplementation(() => {});
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  resetQueryEventSink();
  jest.useRealTimers();
  await closeGovernancePool();
  resetGovernanceState();
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  stdout.mockRestore();
  warn.mockRestore();
});

/** The rows one insert's parameters carry, by column. */
function rowsOf(values: readonly unknown[] | undefined): Record<string, unknown>[] {
  const width = QUERY_EVENT_COLUMNS.length;
  const all = values ?? [];
  return Array.from({ length: all.length / width }, (_, row) =>
    Object.fromEntries(QUERY_EVENT_COLUMNS.map((column, index) => [column, all[row * width + index]])),
  );
}

/** Every client the governance pool handed out, in order. */
const clients = (): FakeClient[] => FakePool.made.flatMap((pool) => pool.clients);

/** The event ids of `rows`, in order. */
const eventIds = (rows: readonly Record<string, unknown>[]): string[] => rows.map((row) => row.event_id as string);

/** Every insert sent so far, in order, with the rows it carried. */
function inserts(): { readonly sql: string; readonly rows: Record<string, unknown>[] }[] {
  return clients().flatMap((client) =>
    client.statements.map((sql, index) => ({ sql, rows: rowsOf(client.parameters[index]) })),
  );
}

/** The rows of the statement `client` is answering. */
const rowsAnswered = (client: FakeClient): Record<string, unknown>[] => rowsOf(client.parameters.at(-1));

/** Holds every row of the statement, as the governance source does, and remembers which landed. */
async function holdRows(_sql: string, client: FakeClient): Promise<{ rows: unknown[] }> {
  landed.push(...rowsAnswered(client).map((row) => row.event_id as string));
  return { rows: [] };
}

const FUTURE_CHECK = "query_event_not_future";

/**
 * The error the governance source answers a row more than 5 minutes ahead with: the CHECK by name, and a detail that
 * quotes the row, statement and all, which no log line may repeat.
 */
const futureRefusal = (): Error =>
  Object.assign(pgError("23514", `new row for relation "query_event" violates check constraint "${FUTURE_CHECK}"`), {
    constraint: FUTURE_CHECK,
    detail: `Failing row contains (${STATEMENT}).`,
  });

/** Refuses any statement that carries a row more than 5 minutes ahead, as the CHECK does, and holds the others. */
async function refuseFutureRows(sql: string, client: FakeClient): Promise<{ rows: unknown[] }> {
  if (rowsAnswered(client).some((row) => Date.parse(row.started_at as string) > Date.now() + 5 * 60_000)) {
    throw futureRefusal();
  }
  return holdRows(sql, client);
}

/** The stdout lines written so far, parsed. */
const stdoutLines = (): unknown[] => stdout.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as unknown);

/** Records events whose correlation ids are `ids`, one each. */
function recordEach(...ids: string[]): void {
  for (const id of ids) recordQueryEvent(queryEventInput({ correlationId: id }));
}

/** Lets the timers move `ms` on, then lets every insert they started settle. */
async function elapse(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await settle();
}

describe("one batch", () => {
  test("500 queued events become one INSERT ON CONFLICT DO NOTHING with the manifest column list", async () => {
    jest.useFakeTimers();
    for (let unit = 0; unit < 499; unit += 1) recordQueryEvent(queryEventInput({ unitIndex: unit }));
    await settle();
    expect(inserts()).toEqual([]);

    // The 500th event flushes the queue at once, without waiting for the second to pass.
    recordQueryEvent(queryEventInput({ unitIndex: 499 }));
    await settle();

    const sent = inserts();
    expect(sent.map(({ sql }) => sql)).toEqual([buildQueryEventInsert("bridge", 500)]);
    expect(buildQueryEventInsert("bridge", 2)).toBe(MANIFEST_INSERT);
    const columnList = (sql: string) => /^INSERT INTO "bridge"\.query_events_v1 \(([^)]+)\) VALUES /.exec(sql)?.[1];
    expect(columnList(sent[0].sql)).toBe(columnList(MANIFEST_INSERT));
    expect(columnList(sent[0].sql)?.split(", ")).toEqual(VIEW_COLUMNS);
    expect(sent[0].sql.endsWith(") ON CONFLICT DO NOTHING")).toBe(true);
    expect(sent[0].rows.map((row) => row.unit_index)).toEqual(Array.from({ length: 500 }, (_, unit) => unit));
    expect(new Set(landed).size).toBe(500);
    // Through the governance pool, on one connection released once.
    expect(FakePool.made.map((pool) => pool.config.application_name)).toEqual(["libredb-studio-governance"]);
    expect(clients().map((client) => client.releases)).toEqual([1]);
    expect(queryEventSinkState()).toEqual({
      queued: 0,
      dropped: 0,
      rejected: 0,
      lastFlushAt: new Date().toISOString(),
      backingOff: false,
      lastSqlstate: null,
    });
  });

  test("a batch with one 23514 row inserts the other rows, logs one rejection line and counts one rejected", async () => {
    jest.useFakeTimers();
    // Capture full keeps the statement in each row, so the line is seen to leave it out.
    recordGovernanceSnapshot({
      ...grantedSnapshot([], []),
      settings: validateSettings([{ key: "queryLog.statementCapture", value: "full", updated_at: new Date() }], 1),
    });
    fakePg.respond = refuseFutureRows;
    recordQueryEvent(queryEventInput({ correlationId: "before", statement: STATEMENT }));
    recordQueryEvent(queryEventInput({ correlationId: "future", statement: STATEMENT, started: startInTheFuture() }));
    recordQueryEvent(queryEventInput({ correlationId: "after", statement: STATEMENT }));

    await elapse(1000);

    const [batch, ...oneByOne] = inserts();
    expect(batch.sql).toBe(buildQueryEventInsert("bridge", 3));
    expect(batch.rows.map((row) => row.statement)).toEqual([STATEMENT, STATEMENT, STATEMENT]);
    // Split: the rows go in one by one, in order, with the event ids of the batch.
    expect(oneByOne.map(({ sql }) => sql)).toEqual(Array(3).fill(buildQueryEventInsert("bridge", 1)));
    const ids = eventIds(batch.rows);
    expect(oneByOne.map(({ rows }) => rows[0].event_id)).toEqual(ids);
    expect(landed).toEqual([ids[0], ids[2]]);
    expect(stdoutLines()).toEqual([
      { type: "query_event_rejected", event_id: ids[1], sqlstate: "23514", constraint: FUTURE_CHECK },
    ]);
    expect(String(stdout.mock.calls[0][0])).not.toContain(STATEMENT_CANARY);
    expect(queryEventSinkState()).toEqual({
      queued: 0,
      dropped: 0,
      rejected: 1,
      lastFlushAt: new Date().toISOString(),
      backingOff: false,
      lastSqlstate: "23514",
    });
    // A refusal for good is no reason to wait: the next event goes in a second later.
    recordEach("next");
    await elapse(1000);
    expect(landed).toHaveLength(3);
  });

  test("a class 22 row is dropped the same way, with a null constraint when the server names none", async () => {
    jest.useFakeTimers();
    fakePg.respond = async (sql, client) => {
      if (rowsAnswered(client).some((row) => row.correlation_id === "bad")) {
        throw pgError("22P02", "invalid input syntax for type inet");
      }
      return holdRows(sql, client);
    };
    recordEach("good", "bad");

    await elapse(1000);

    const ids = eventIds(inserts()[0].rows);
    expect(landed).toEqual([ids[0]]);
    expect(stdoutLines()).toEqual([
      { type: "query_event_rejected", event_id: ids[1], sqlstate: "22P02", constraint: null },
    ]);
    expect(queryEventSinkState()).toMatchObject({ queued: 0, rejected: 1, backingOff: false, lastSqlstate: "22P02" });
  });
});

describe("a failure that is not for good", () => {
  test("57P01 keeps the batch and backs off from 1 s to 30 s", async () => {
    jest.useFakeTimers();
    fakePg.respond = async () => {
      throw pgError("57P01", "terminating connection due to administrator command", "FATAL");
    };
    recordEach("a", "b");

    await elapse(1000);
    expect(inserts()).toHaveLength(1);
    expect(queryEventSinkState()).toEqual({
      queued: 2,
      dropped: 0,
      rejected: 0,
      lastFlushAt: null,
      backingOff: true,
      lastSqlstate: "57P01",
    });
    const ids = eventIds(inserts()[0].rows);

    const waits = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    expect(waits.map((_, failed) => queryEventBackoffMs(failed + 1))).toEqual(waits);
    for (const [retry, waitMs] of waits.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- each retry is due only after the one before it failed.
      await elapse(waitMs - 1);
      expect(inserts()).toHaveLength(retry + 1);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await elapse(1);
      expect(inserts()).toHaveLength(retry + 2);
      // The retry carries the same rows with the same event ids, so a batch that did land adds nothing.
      expect(eventIds(inserts()[retry + 1].rows)).toEqual(ids);
    }
    // An event recorded while the sink backs off waits for the retry, not for a second.
    recordEach("c");
    await elapse(1000);
    expect(inserts()).toHaveLength(waits.length + 1);
    expect(warn).toHaveBeenCalledWith("Query event insert failed", {
      route: "query-events",
      reason: "SQLSTATE 57P01",
      queued: 2,
    });

    fakePg.respond = holdRows;
    await elapse(29_000);
    expect(landed).toEqual([...ids, ...eventIds(inserts().at(-1)?.rows.slice(2) ?? [])]);
    expect(queryEventSinkState()).toEqual({
      queued: 0,
      dropped: 0,
      rejected: 0,
      lastFlushAt: new Date().toISOString(),
      backingOff: false,
      lastSqlstate: "57P01",
    });

    // Once an insert succeeds, the next event waits a second again.
    recordEach("d");
    await elapse(1000);
    expect(landed).toHaveLength(4);
  });

  test("any other SQLSTATE is transient too and shown in the sink state", async () => {
    jest.useFakeTimers();
    fakePg.respond = async () => {
      throw pgError("42501", "permission denied for view query_events_v1");
    };
    recordEach("a");

    await elapse(1000);

    expect(queryEventSinkState()).toMatchObject({ queued: 1, rejected: 0, backingOff: true, lastSqlstate: "42501" });
    expect(stdout).not.toHaveBeenCalled();
    // A server's message can quote a value of the row, so the log line names the SQLSTATE only.
    expect(warn).toHaveBeenCalledWith("Query event insert failed", {
      route: "query-events",
      reason: "SQLSTATE 42501",
      queued: 1,
    });
  });

  test("a failure without a SQLSTATE backs off with a null lastSqlstate, and a five-letter Node code is not one", async () => {
    jest.useFakeTimers();
    let refusal = nodeError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:5432");
    fakePg.connecting = async () => {
      throw refusal;
    };
    recordEach("a");

    await elapse(1000);
    expect(queryEventSinkState()).toMatchObject({ queued: 1, backingOff: true, lastSqlstate: null });
    expect(warn).toHaveBeenLastCalledWith("Query event insert failed", {
      route: "query-events",
      reason: "connect ECONNREFUSED 10.0.0.5:5432",
      queued: 1,
    });

    refusal = nodeError("EPIPE", "write EPIPE");
    await elapse(1000);
    expect(queryEventSinkState()).toMatchObject({ queued: 1, backingOff: true, lastSqlstate: null });
    expect(warn).toHaveBeenLastCalledWith("Query event insert failed", {
      route: "query-events",
      reason: "write EPIPE",
      queued: 1,
    });
  });

  test("a failure mid-split keeps the rows not yet settled and drops none of them", async () => {
    jest.useFakeTimers();
    let lostConnection = true;
    fakePg.respond = async (sql, client) => {
      const rows = rowsAnswered(client);
      if (rows.some((row) => row.correlation_id === "future")) throw futureRefusal();
      if (lostConnection && rows.length === 1 && rows[0].correlation_id === "lost") {
        throw pgError("08006", "connection failure", "FATAL");
      }
      return holdRows(sql, client);
    };
    recordQueryEvent(queryEventInput({ correlationId: "first" }));
    recordQueryEvent(queryEventInput({ correlationId: "future", started: startInTheFuture() }));
    recordQueryEvent(queryEventInput({ correlationId: "lost" }));
    recordQueryEvent(queryEventInput({ correlationId: "last" }));

    await elapse(1000);

    const ids = eventIds(inserts()[0].rows);
    // The first row landed and the future one was refused before the connection broke on the third.
    expect(landed).toEqual([ids[0]]);
    expect(stdoutLines()).toHaveLength(1);
    expect(queryEventSinkState()).toMatchObject({ queued: 2, rejected: 1, backingOff: true, lastSqlstate: "08006" });

    lostConnection = false;
    await elapse(1000);

    // The retry sends only the two rows left, and refuses nothing again.
    expect(eventIds(inserts().at(-1)?.rows ?? [])).toEqual([ids[2], ids[3]]);
    expect(landed).toEqual([ids[0], ids[2], ids[3]]);
    expect(stdoutLines()).toHaveLength(1);
    expect(queryEventSinkState()).toMatchObject({ queued: 0, rejected: 1, backingOff: false, lastSqlstate: "08006" });
  });

  test("an insert that outlives its 10 s deadline is abandoned and its batch kept", async () => {
    jest.useFakeTimers();
    fakePg.respond = () => new Promise(() => {});
    recordEach("a");

    await elapse(1000);
    await elapse(9999);
    expect(queryEventSinkState()).toMatchObject({ queued: 1, backingOff: false });
    await elapse(1);

    expect(clients()[0].releasedWith).toBeInstanceOf(Error);
    expect(queryEventSinkState()).toMatchObject({ queued: 1, backingOff: true, lastSqlstate: null });
    expect(warn).toHaveBeenCalledWith("Query event insert failed", {
      route: "query-events",
      reason: "The query event insert did not finish within 10000 ms",
      queued: 1,
    });
  });

  test("what a row's insert answers after the deadline is not counted, and the row is sent again", async () => {
    jest.useFakeTimers();
    let refuseLate: () => void = () => {};
    fakePg.respond = async (sql, client) => {
      const rows = rowsAnswered(client);
      if (rows.length > 1) throw futureRefusal();
      if (rows[0].correlation_id !== "slow") return holdRows(sql, client);
      // The future row's own insert answers only once the deadline has passed.
      return new Promise((_, refuse) => {
        refuseLate = () => refuse(futureRefusal());
      });
    };
    recordQueryEvent(queryEventInput({ correlationId: "first" }));
    recordQueryEvent(queryEventInput({ correlationId: "slow", started: startInTheFuture() }));
    recordQueryEvent(queryEventInput({ correlationId: "last" }));

    await elapse(1000);
    await elapse(10_000);
    refuseLate();
    await settle();

    // Only the first row settled before the deadline; the late refusal is neither logged nor counted.
    expect(landed).toHaveLength(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(queryEventSinkState()).toMatchObject({ queued: 2, rejected: 0, backingOff: true, lastSqlstate: null });
    // Nothing more went over the abandoned connection.
    expect(clients()[0].statements).toHaveLength(3);

    fakePg.respond = refuseFutureRows;
    await elapse(1000);
    expect(stdoutLines()).toHaveLength(1);
    expect(queryEventSinkState()).toMatchObject({ queued: 0, rejected: 1, backingOff: false });
  });
});
