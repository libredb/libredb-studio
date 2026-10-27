import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type CancellationToken, CancellationTokenSource, ErrorCodes, ResponseError } from "vscode-jsonrpc/node";
import type { Container, DatabaseObject, KindCount, ObjectDetail } from "@/lib/db/types";
import { ENABLED_PROVIDERS } from "../../src/host/channel";
import {
  type BackendErrorData,
  type CancelResult,
  type ConnectionParams,
  EXIT_NOTIFICATION,
  METHODS,
  type OpenResult,
  type QueryPage,
  type RunQueryParams,
  type TestConnectionResult,
  type WireConnection,
} from "../../src/protocol";
import { type BackendSession, openSession } from "../backend-session";
import { STABLE_RUNTIME } from "../vscode-floor";
import { type EngineService, psql, type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "./containers";
import { ENGINES, type EngineFixture, engineFixture } from "./engines";
import { type BackendRuntime, backendRuntime, forkBackend } from "./runtime";

const EXTENSION_ROOT = join(__dirname, "..", "..");
const POSTURE = { allowExternalFileAccess: false };
const LIFECYCLE_SESSIONS =
  "select count(*) from pg_stat_activity where datname = 'libredb_it_lifecycle' and backend_type = 'client backend'";

const params = (connection: WireConnection): ConnectionParams => ({ connection, posture: POSTURE });
/** The connection the shared child opens per engine in before, which runs the engine's setup. */
const mainId = (fixture: EngineFixture): string => `${fixture.service}-main`;

/** query/run with a fresh queryId, as the host mints one per run, the default bounds, and the caller's token. */
function runQuery(
  session: BackendSession,
  connectionId: string,
  statement: string,
  more: Partial<RunQueryParams> = {},
  token?: CancellationToken,
): Promise<QueryPage> {
  const request: RunQueryParams = { connectionId, queryId: randomUUID(), statement, limit: 500, offset: 0, ...more };
  return token === undefined
    ? session.connection.sendRequest<QueryPage>(METHODS.runQuery, request)
    : session.connection.sendRequest<QueryPage>(METHODS.runQuery, request, token);
}

/** The error answer of a request that must fail. */
async function errorOf(answer: Promise<unknown>): Promise<ResponseError<BackendErrorData | undefined>> {
  let value: unknown;
  try {
    value = await answer;
  } catch (error) {
    if (error instanceof ResponseError) return error;
    throw error;
  }
  assert.fail(`expected an error answer, got ${JSON.stringify(value)?.slice(0, 200)}`);
}

/** Polls read() until it answers expected, and fails once withinMs have passed. */
async function eventually(read: () => Promise<string>, expected: string, withinMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value === expected) return;
    if (Date.now() - started > withinMs) assert.fail(`still ${value}, not ${expected}, after ${withinMs} ms`);
    await delay(100);
  }
}

const occurrences = (text: string, line: string): number => text.split(line).length - 1;

/** Waits until the child's stdout holds line `count` times: the pipe and the IPC channel are not ordered. */
async function stdoutHolds(session: BackendSession, line: string, count: number): Promise<void> {
  const started = Date.now();
  while (occurrences(session.stdout(), line) < count) {
    if (Date.now() - started > 2000) assert.fail(`stdout holds ${line} fewer than ${count} times`);
    await delay(50);
  }
}

const running = (session: BackendSession): boolean =>
  session.child.exitCode === null && session.child.signalCode === null;

/** The exit code of a child that exits within ms of `from`, and the milliseconds it took. */
async function exitWithin(session: BackendSession, from: number, ms: number): Promise<number | null> {
  const [code] = (await once(session.child, "exit")) as [number | null];
  const took = Date.now() - from;
  assert.ok(took < ms, `the child exited ${took} ms after the step, not within ${ms} ms`);
  return code;
}

describe("the backend child against PostgreSQL, SQL Server, MySQL and MongoDB", () => {
  let runtime: BackendRuntime;
  let shared: BackendSession | undefined;
  const engines = new Map<EngineService, RunningEngine>();
  const fresh: BackendSession[] = [];

  const sharedChild = (): BackendSession => {
    assert.ok(shared, "the shared child did not start");
    return shared;
  };
  const engineOf = (service: EngineService): RunningEngine => {
    const engine = engines.get(service);
    assert.ok(engine, `${service} is not running`);
    return engine;
  };
  /** A child of its own, forked with the supervisor's options and ended after the case. */
  const freshChild = (): BackendSession => {
    const session = openSession(forkBackend(runtime));
    fresh.push(session);
    return session;
  };

  /** connection/test through the shared child, once a second, until one succeeds within START_DEADLINE_MS. */
  async function waitForLogin(fixture: EngineFixture): Promise<void> {
    const started = Date.now();
    const connection = fixture.connection(engineOf(fixture.service), `${fixture.service}-ready`);
    for (;;) {
      try {
        await sharedChild().connection.sendRequest<TestConnectionResult>(METHODS.testConnection, params(connection));
        console.log(`${fixture.service}: connection/test succeeded after ${Date.now() - started} ms`);
        return;
      } catch (error) {
        if (Date.now() - started > START_DEADLINE_MS) {
          throw new Error(
            `${fixture.service} refused every login for ${START_DEADLINE_MS} ms; the last answer: ${error}`,
            { cause: error },
          );
        }
      }
      await delay(1000);
    }
  }

  before(async function () {
    this.timeout(900_000);
    runtime = await backendRuntime();
    console.log(`runtime ${runtime.name}: ${runtime.execPath}`);
    const runId = `${process.pid}-${Date.now()}`;
    const outcomes = await Promise.allSettled(
      ENGINES.map((fixture) => startEngine(fixture.service, runId, EXTENSION_ROOT)),
    );
    for (const outcome of outcomes)
      if (outcome.status === "fulfilled") engines.set(outcome.value.service, outcome.value);
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    shared = openSession(forkBackend(runtime));
    await shared.initialize();
    await Promise.all(ENGINES.map((fixture) => waitForLogin(fixture)));
    for (const fixture of ENGINES) {
      const connection = fixture.connection(engineOf(fixture.service), mainId(fixture));
      await shared.connection.sendRequest<OpenResult>(METHODS.openConnection, params(connection));
      for (const statement of fixture.setup) await runQuery(shared, mainId(fixture), statement);
    }
  });

  afterEach(async () => {
    for (const session of fresh.splice(0)) {
      if (running(session)) {
        const exited = once(session.child, "exit");
        session.child.kill("SIGKILL");
        await exited;
      }
      session.connection.dispose();
    }
  });

  after(async function () {
    this.timeout(120_000);
    try {
      if (shared !== undefined && running(shared)) {
        const exited = once(shared.child, "exit");
        assert.equal(await shared.connection.sendRequest(METHODS.shutdown), null);
        await shared.connection.sendNotification(EXIT_NOTIFICATION);
        await exited;
        shared.connection.dispose();
      }
    } finally {
      await Promise.all([...engines.values()].map((engine) => stopEngine(engine)));
      engines.clear();
    }
  });

  it("answers initialize with protocol version 1, the enabled providers and the runtime it runs on", async () => {
    const answer = await freshChild().initialize();
    console.log(`initialize answered ${JSON.stringify(answer)}`);
    assert.equal(answer.protocolVersion, 1);
    assert.deepEqual(answer.enabledProviders, ENABLED_PROVIDERS);
    if (runtime.name === "node") {
      assert.equal(answer.runtime.electron, null);
      assert.equal(answer.runtime.node, process.versions.node);
      return;
    }
    assert.match(answer.runtime.electron ?? "", /^\d+\.\d+\.\d+$/);
    if (process.env.LIBREDB_VSCODE_VERSION === undefined) {
      assert.deepEqual(answer.runtime, { ...STABLE_RUNTIME, platform: process.platform, arch: process.arch });
    }
  });

  it("refuses a request before initialize, and an initialize with another protocol version", async () => {
    const session = freshChild();
    const early = await errorOf(runQuery(session, "postgres-main", "select 1"));
    assert.equal(early.code, ErrorCodes.ServerNotInitialized);
    const mismatch = await errorOf(session.initialize(2));
    assert.equal(mismatch.code, 500);
    assert.equal(
      mismatch.message,
      "The LibreDB backend speaks protocol version 1, but the extension sent version 2. Reinstall the LibreDB extension.",
    );
    assert.deepEqual(mismatch.data, { code: "PROTOCOL_MISMATCH" });
  });

  for (const fixture of ENGINES) {
    it(`answers every method on ${fixture.service} with the provider's answers`, async () => {
      const child = sharedChild();
      const id = `${fixture.service}-methods`;
      const connection = fixture.connection(engineOf(fixture.service), id);
      const tested = await child.connection.sendRequest<TestConnectionResult>(
        METHODS.testConnection,
        params(connection),
      );
      assert.equal(tested.success, true);
      assert.equal(typeof (tested as { latency?: unknown }).latency, "number", JSON.stringify(tested));

      // stdout stays a log beside the JSON-RPC stream: connection/test wrote this line once already.
      const created = `[DB] Creating ${connection.type} provider for "${connection.name}"`;
      const seen = occurrences(child.stdout(), created);
      const { description } = await child.connection.sendRequest<OpenResult>(
        METHODS.openConnection,
        params(connection),
      );
      assert.equal(typeof description.capabilities.supportsQueryCancel, "boolean");
      assert.ok(typeof description.labels === "object" && description.labels !== null);
      await stdoutHolds(child, created, seen + 1);

      const containers = await child.connection.sendRequest<Container[]>(METHODS.listContainers, { connectionId: id });
      assert.ok(Array.isArray(containers));
      console.log(`${fixture.service}: objects/containers answered ${JSON.stringify(containers.map((c) => c.path))}`);
      const counts = await child.connection.sendRequest<Record<string, KindCount>>(METHODS.countObjects, {
        connectionId: id,
        container: fixture.tableContainer,
      });
      const counted = Object.entries(counts)
        .filter(([, count]) => "count" in count && count.count >= 1)
        .map(([kind]) => kind);
      assert.ok(counted.length > 0, `no kind counted at least 1 in ${JSON.stringify(counts)}`);
      let table: DatabaseObject | undefined;
      for (const kind of counted) {
        const objects = await child.connection.sendRequest<DatabaseObject[]>(METHODS.listObjects, {
          connectionId: id,
          container: fixture.tableContainer,
          kind,
        });
        table = objects.find((object) => object.name === fixture.tableName);
        if (table !== undefined) break;
      }
      assert.ok(table, `no kind counted in ${JSON.stringify(counts)} lists ${fixture.tableName}`);
      const detail = await child.connection.sendRequest<ObjectDetail>(METHODS.describeObject, {
        connectionId: id,
        path: table.path,
        kind: table.kind,
      });
      assert.ok(
        detail.columns.some((column) => column.name === "n"),
        JSON.stringify(detail.columns),
      );

      // A provider that limits a statement from outside answers the bound; MongoDB's command is its own bound
      // (docs/providers/mongodb.md section 3.4), so the case reads the description, never the type.
      const page = await runQuery(child, id, fixture.selectFour, { limit: 2 });
      const four = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
      assert.deepEqual(page.rows, description.capabilities.supportsExternalQueryLimiting ? four.slice(0, 2) : four);

      // MongoDB declares no cancelQuery: the case reads the description, never the type.
      const cancel = child.connection.sendRequest<CancelResult>(METHODS.cancelQuery, {
        connectionId: id,
        queryId: randomUUID(),
      });
      if (description.capabilities.supportsQueryCancel) {
        assert.deepEqual(await cancel, { cancelled: false });
      } else {
        const unsupported = await errorOf(cancel);
        assert.equal(unsupported.code, 400);
        assert.deepEqual(unsupported.data, { code: "CANCEL_UNSUPPORTED" });
      }

      assert.equal(await child.connection.sendRequest(METHODS.closeConnection, { connectionId: id }), null);
      assert.equal(await child.connection.sendRequest(METHODS.closeConnection, { connectionId: id }), null);
      const closed = await errorOf(runQuery(child, id, fixture.selectFour));
      assert.equal(closed.code, 404);
      assert.deepEqual(closed.data, { code: "CONNECTION_NOT_OPEN" });

      const textLimit = await errorOf(
        child.connection.sendRequest(METHODS.runQuery, {
          connectionId: mainId(fixture),
          queryId: randomUUID(),
          statement: fixture.selectFour,
          limit: "2",
          offset: 0,
        }),
      );
      assert.equal(textLimit.code, ErrorCodes.InvalidParams);
      assert.equal(textLimit.message, "options.limit must be a non-negative integer");
      const kindless = await errorOf(
        child.connection.sendRequest(METHODS.listObjects, {
          connectionId: mainId(fixture),
          container: fixture.tableContainer,
        }),
      );
      assert.equal(kindless.code, ErrorCodes.InvalidParams);
      assert.equal(kindless.message, "kind must be a string");
    });
  }

  it("pages it_four on PostgreSQL two rows at a time", async () => {
    const postgres = engineFixture("postgres");
    const first = await runQuery(sharedChild(), mainId(postgres), postgres.selectFour, { limit: 2, offset: 0 });
    assert.deepEqual(first.rows, [{ n: 1 }, { n: 2 }]);
    assert.equal(first.pagination.hasMore, true);
    const second = await runQuery(sharedChild(), mainId(postgres), postgres.selectFour, { limit: 2, offset: 2 });
    assert.deepEqual(second.rows, [{ n: 3 }, { n: 4 }]);
    assert.equal(second.pagination.hasMore, false);
  });

  it("caps a 100,000-row read at its limit, reads the next page, and carries a 10 MB cell", async () => {
    const child = sharedChild();
    const connectionId = mainId(engineFixture("postgres"));
    await runQuery(child, connectionId, "create table it_big as select g as n from generate_series(1, 100000) g");
    const page = await runQuery(child, connectionId, "select n from it_big order by n", { limit: 500 });
    assert.equal(page.rows.length, 500);
    assert.equal(page.rowCount, 500);
    assert.equal(page.pagination.hasMore, true);
    assert.equal(page.pagination.wasLimited, true);
    const next = await runQuery(child, connectionId, "select n from it_big order by n", { limit: 500, offset: 500 });
    assert.deepEqual(next.rows[0], { n: 501 });

    const started = Date.now();
    const big = await runQuery(child, connectionId, "select repeat('x', 10485760) as big");
    const took = Date.now() - started;
    console.log(`a 10,485,760-character cell answered in ${took} ms`);
    assert.equal(big.rows.length, 1);
    assert.equal(String(big.rows[0].big).length, 10_485_760);
    assert.ok(took < 10_000, `${took} ms`);
  });

  it("cancels select pg_sleep(30) through query/cancel, and through the request's token alone", async () => {
    const child = sharedChild();
    const connectionId = mainId(engineFixture("postgres"));
    const cancelled = (error: ResponseError<BackendErrorData | undefined>, started: number): void => {
      const took = Date.now() - started;
      assert.equal(error.code, 499, error.message);
      assert.equal(error.data?.code, "QUERY_CANCELLED");
      assert.ok(took < 5000, `the run ended ${took} ms after it started`);
    };

    const queryId = randomUUID();
    let started = Date.now();
    const byCancel = errorOf(runQuery(child, connectionId, "select pg_sleep(30)", { queryId }));
    await delay(500);
    assert.deepEqual(await child.connection.sendRequest(METHODS.cancelQuery, { connectionId, queryId }), {
      cancelled: true,
    });
    cancelled(await byCancel, started);

    const source = new CancellationTokenSource();
    started = Date.now();
    const byToken = errorOf(runQuery(child, connectionId, "select pg_sleep(30)", {}, source.token));
    await delay(500);
    source.cancel();
    cancelled(await byToken, started);
    assert.equal(
      await psql(
        engineOf("postgres"),
        "select count(*) from pg_stat_activity where state = 'active' and query like 'select pg_sleep(30)%'",
      ),
      "0",
    );
  });

  it("rolls back a lone BEGIN, so the next run on the connection commits outside a transaction", async () => {
    const connectionId = mainId(engineFixture("postgres"));
    const begun = await runQuery(sharedChild(), connectionId, "begin");
    assert.equal(begun.openTransaction, "rolled-back");
    await runQuery(sharedChild(), connectionId, "create table it_after_begin (n int)");
    assert.equal(await psql(engineOf("postgres"), "select to_regclass('public.it_after_begin') is not null"), "t");
  });

  it("refuses the held-back engines before their provider module or driver loads", async () => {
    const session = freshChild();
    await session.initialize();
    const createdAt = new Date(0).toISOString();
    const outside: WireConnection[] = [
      { id: "gate-duckdb", name: "it gate duckdb", type: "duckdb", host: "127.0.0.1", port: 1, createdAt },
      { id: "gate-db2", name: "it gate db2", type: "db2", host: "127.0.0.1", port: 1, createdAt },
      { id: "gate-oracle", name: "it gate oracle", type: "oracle", host: "127.0.0.1", port: 1, createdAt },
    ];
    for (const connection of outside) {
      const refused = await errorOf(session.connection.sendRequest(METHODS.testConnection, params(connection)));
      assert.equal(refused.code, 400);
      assert.equal(
        refused.message,
        `The ${connection.type} provider is not available in this distribution of LibreDB Studio.`,
      );
      assert.deepEqual(refused.data, { code: "CONFIG_ERROR" });
    }
    assert.doesNotMatch(session.stdout(), /\[DB\] Creating (duckdb|db2|oracle) provider/);
    assert.doesNotMatch(session.stderr(), /Cannot find module/);
  });

  it("ends connection/test against a listener that never answers, and keeps serving other connections", async () => {
    const child = sharedChild();
    const held: Socket[] = [];
    const silent = createServer((socket) => {
      held.push(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const tests = ENGINES.map(async (fixture) => {
        const started = Date.now();
        const connection = fixture.connection({ ...engineOf(fixture.service), port }, `silent-${fixture.service}`);
        const error = await errorOf(child.connection.sendRequest(METHODS.testConnection, params(connection)));
        return { service: fixture.service, took: Date.now() - started, error };
      });
      const selectStarted = Date.now();
      await runQuery(child, mainId(engineFixture("postgres")), "select 1");
      const selectTook = Date.now() - selectStarted;
      const answers = await Promise.all(tests);
      for (const { service, took, error } of answers) {
        console.log(
          `${service} against a silent listener: ${error.code} ${JSON.stringify(error.data)} after ${took} ms`,
        );
      }
      console.log(`select 1 on the open PostgreSQL connection meanwhile: ${selectTook} ms`);
      for (const { service, took, error } of answers) {
        assert.equal(error.code, 503, `${service}: ${error.message}`);
        assert.equal(error.data?.code, "CONNECTION_ERROR", service);
        assert.equal(error.data?.retryable, true, service);
        assert.ok(took < 12_000, `${service} answered after ${took} ms`);
      }
      assert.ok(selectTook < 2000, `select 1 took ${selectTook} ms`);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("ends a PostgreSQL run at the queryTimeout its connection names", async () => {
    const postgres = engineFixture("postgres");
    const child = sharedChild();
    const connection = postgres.connection(engineOf("postgres"), "pg-short", { queryTimeout: 2000 });
    await child.connection.sendRequest<OpenResult>(METHODS.openConnection, params(connection));
    const started = Date.now();
    const error = await errorOf(runQuery(child, "pg-short", "select pg_sleep(30)"));
    const took = Date.now() - started;
    console.log(`pg-short: ${error.code} ${JSON.stringify(error.data)} "${error.message}" after ${took} ms`);
    assert.ok(took < 4000, `the run ended after ${took} ms`);
    // Measured 2026-10-20 on postgres:18: the pool's statement_timeout ends the statement with SQLSTATE 57014, which
    // the error mapping of src/lib/db/errors.ts reads as a TimeoutError, answered 504 TIMEOUT_ERROR.
    assert.equal(error.code, 504);
    assert.deepEqual(error.data, { code: "TIMEOUT_ERROR", retryable: true });
  });

  /** A fresh child with a PostgreSQL session open in libredb_it_lifecycle, which psql sees. */
  async function lifecycleChild(): Promise<BackendSession> {
    const session = freshChild();
    await session.initialize();
    const postgres = engineFixture("postgres");
    const connection = postgres.connection(engineOf("postgres"), "pg-lifecycle", { database: "libredb_it_lifecycle" });
    await session.connection.sendRequest<OpenResult>(METHODS.openConnection, params(connection));
    await runQuery(session, "pg-lifecycle", "select 1");
    assert.ok(Number(await psql(engineOf("postgres"), LIFECYCLE_SESSIONS)) >= 1);
    return session;
  }

  it("closes its pools on shutdown and exits 0 on exit", async () => {
    const session = await lifecycleChild();
    const started = Date.now();
    const exited = exitWithin(session, started, 4000);
    assert.equal(await session.connection.sendRequest(METHODS.shutdown), null);
    await session.connection.sendNotification(EXIT_NOTIFICATION);
    assert.equal(await exited, 0);
    await eventually(() => psql(engineOf("postgres"), LIFECYCLE_SESSIONS), "0", 2000);
  });

  it("closes its pools and exits 0 when its host closes the channel", async () => {
    const session = await lifecycleChild();
    const started = Date.now();
    const exited = exitWithin(session, started, 3000);
    session.connection.dispose();
    session.child.disconnect();
    assert.equal(await exited, 0);
    await eventually(() => psql(engineOf("postgres"), LIFECYCLE_SESSIONS), "0", 2000);
  });

  it("closes its pools and exits 0 on SIGTERM", async function () {
    if (process.platform === "win32") this.skip();
    const session = await lifecycleChild();
    const started = Date.now();
    const exited = exitWithin(session, started, 3000);
    session.child.kill("SIGTERM");
    assert.equal(await exited, 0);
    await eventually(() => psql(engineOf("postgres"), LIFECYCLE_SESSIONS), "0", 3000 - (Date.now() - started));
  });
});
