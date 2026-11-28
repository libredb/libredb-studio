/**
 * The session targets of the caller facades (src/lib/api/session-target.ts): what a facade of the provider host core
 * runs its calls on, a session, the environment each call is given, its statement timeout and the run marks of its
 * cache entry. A legacy provider's target is one bridged session of it, with no environment, its provider's statement
 * timeout and marks that count nothing; `markedCall` brackets one call with a target's marks.
 */
import { describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BATCH_MAX_BYTES,
  CallRefusalError,
  type Column,
  envReader,
  type ExecuteAnswer,
  type ExecuteRequest,
  PAGE_MAX_BYTES,
  rowsSource,
} from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";
import { encodeValue } from "@libredb/provider-sdk/values";
import { hostPorts } from "@/lib/api/editor-query";
import {
  entryConsoleTarget,
  entryMonitoringTarget,
  markedCall,
  packageMaintenanceOpening,
  providerConsoleTarget,
  providerMaintenanceTarget,
  providerComposedRead,
  providerMonitoringTarget,
  providerSampleRead,
  providerTreeTarget,
  type SessionTarget,
} from "@/lib/api/session-target";
import type { CachedSession } from "@/lib/db/factory";
import { StudioByteBudgetRefusal } from "@/lib/db/errors";
import { errorOutcome } from "@/lib/db/error-record";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import type { EngineConnection } from "@/lib/db/server-catalog";
import {
  DEFAULT_QUERY_TIMEOUT,
  type DatabaseProvider,
  type MaintenanceDeclaration,
  type PreparedQuery,
  type QueryPrepareOptions,
} from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { ConsoleSession, PageRecord } from "@/lib/provider-host/core/console";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { bridgedConsole, bridgedMaintenance } from "@/lib/provider-host/legacy-bridge";
import type { OpenedPackageSession } from "@/lib/provider-host/open-engine";
import { splitExecutionUnits } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

/** A declaration with vacuum on a row and whole, and analyze on a row. */
const DECLARED: Required<MaintenanceDeclaration> = {
  maintenanceOperations: ["vacuum", "analyze"],
  maintenanceOperationSpecs: {
    vacuum: { label: "Vacuum", perEntity: true, global: true },
    analyze: { label: "Analyze", perEntity: true, global: false },
  },
};

/** A mock PostgreSQL provider whose statement timeout is `queryTimeout`, connected as `DECLARED`. */
function providerOf(queryTimeout?: number): DatabaseProvider {
  return createMockProvider({
    config: { id: "c1", name: "Prod", type: "postgres", host: "db.internal", queryTimeout } as DatabaseConnection,
    capabilities: { supportsMaintenance: true, ...DECLARED },
  });
}

/** The mock behind a provider's member, for its recorded calls and its implementation. */
const mockOf = (fn: unknown) => fn as ReturnType<typeof mock>;

/** Marks that record each mark in `marks`. */
function recordedMarks(marks: string[]): Pick<SessionTarget<unknown>, "started" | "ended"> {
  return {
    started: () => {
      marks.push("started");
    },
    ended: (record) => {
      marks.push(`ended ${record?.kind}`);
    },
  };
}

describe("the session targets of a legacy provider", () => {
  test("a provider's monitoring target is one bridged session with no environment and no marks under the provider's statement timeout, and its maintenance target reads the provider's narrowed maintenance when a call reads it, never when it is built", async () => {
    const provider = providerOf(4_000);
    const monitoring = providerMonitoringTarget(provider);
    expect(monitoring.session.calls.monitoring.panel).toBe("offered");
    expect(monitoring.session.panels).toBe(bridgedConsole(provider, {}).session.panels);
    expect(typeof monitoring.session.health).toBe("function");
    // No environment: the reader a legacy provider's tree target holds, which declares no variable.
    expect(monitoring.env).toBe(providerTreeTarget(provider).env);
    expect(() => monitoring.env.get(randomUUID())).toThrow();
    // The statement timeout is read when asked, so a later change of the connection's timeout is the one read.
    expect(monitoring.timeout()).toBe(4_000);
    provider.config.queryTimeout = 7_000;
    expect(monitoring.timeout()).toBe(7_000);
    expect(monitoring.started()).toBeUndefined();
    expect(monitoring.ended({ kind: "answered" })).toBeUndefined();

    // The maintenance target's session is the bridged one without its maintenance, which no builder reads.
    const capabilities = mockOf(provider.getCapabilities);
    capabilities.mockClear();
    const maintenance = providerMaintenanceTarget(provider, DECLARED);
    const builtReads = capabilities.mock.calls.length;
    expect(Object.hasOwn(maintenance.session, "maintenance")).toBe(false);
    expect(maintenance.session.calls.maintenance.run).toBe("offered");
    expect(maintenance.env).toBe(monitoring.env);
    expect(maintenance.timeout()).toBe(7_000);
    expect(maintenance.started()).toBeUndefined();
    expect(maintenance.ended(undefined)).toBeUndefined();
    // Read on each call: the declaration narrowed by what the connected provider accepts at that call.
    const first = maintenance.maintenance();
    expect(capabilities.mock.calls.length).toBe(builtReads + 1);
    expect(first).toEqual(bridgedMaintenance(provider, DECLARED));
    capabilities.mockImplementation(() => ({ supportsMaintenance: true, maintenanceOperations: ["vacuum"] }));
    const second = maintenance.maintenance();
    expect(second).not.toBe(first);
    expect(second).toEqual(bridgedMaintenance(provider, DECLARED));
    expect(second).not.toEqual(first);

    // A declaration the SDK refuses to narrow is refused by `maintenance()`, never by the builder.
    const refused = { ...DECLARED, maintenanceOperations: ["vacuum", "analyze", "shrink"] };
    const unreadable = {
      ...refused,
      maintenanceOperationSpecs: { ...DECLARED.maintenanceOperationSpecs, shrink: { label: "Shrink" } },
    } as unknown as MaintenanceDeclaration;
    const built = providerMaintenanceTarget(provider, unreadable);
    expect(() => built.maintenance()).toThrow(CallRefusalError);

    // The engine user is the provider's, read when asked: none for a provider that names none.
    expect(maintenance.engineUser()).toBeUndefined();
    const engineUser = `user-${randomUUID()}`;
    const named = providerMaintenanceTarget(
      { ...provider, engineUser: () => engineUser } as DatabaseProvider,
      DECLARED,
    );
    expect(named.engineUser()).toBe(engineUser);
  });

  test("markedCall marks a call started before it runs and ended as its record once it answered, and ended undefined for a call that threw, passing the error as the same object", async () => {
    const marks: string[] = [];
    const target = recordedMarks(marks);
    const answer = { kind: "answered" as const, answer: randomUUID() };
    const record = await markedCall(target, async () => {
      marks.push("called");
      return answer;
    });
    expect(record).toBe(answer);
    expect(marks).toEqual(["started", "called", "ended answered"]);

    marks.length = 0;
    const thrown = new Error(randomUUID());
    let caught: unknown;
    try {
      await markedCall(target, () => Promise.reject(thrown));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
    expect(marks).toEqual(["started", "ended undefined"]);
  });
});

describe("the monitoring target of a cache entry", () => {
  /** A provider package's session entry offering `maintenance.run` or not, with a full spec and a bare one. */
  function packageEntry(run: "offered" | "not-offered") {
    const session = {
      calls: { maintenance: { run, preview: "offered" } },
      maintenance: {
        maintenance: ["vacuum", "kill"],
        maintenanceSpecs: [
          {
            operation: "vacuum",
            label: "Vacuum",
            perEntity: true,
            global: false,
            title: "Vacuum the table",
            description: "Reclaims space.",
            confirmation: "typed-target",
            preview: true,
            kinds: ["table"],
          },
          {
            operation: "kill",
            label: "Kill",
            perEntity: false,
            global: false,
            title: null,
            description: null,
            confirmation: null,
            preview: false,
            kinds: null,
          },
        ],
      },
      marker: randomUUID(),
    };
    const env = { marker: randomUUID() };
    const entry = { opened: { form: "session", session, env }, running: 0, lastUsed: 0 } as unknown as CachedSession;
    return { entry, session, env };
  }
  const connection = { id: "p", name: "p", type: "acmemon", queryTimeout: 1234 } as unknown as EngineConnection;

  test("a package entry's monitoring target is its session under its declared environment and the connection's timeout, its calls marked on the entry, and its accepted maintenance the session's narrowed maintenance in Studio's form", async () => {
    const { entry, session, env } = packageEntry("offered");
    const target = entryMonitoringTarget(entry, connection);
    expect(target.session as unknown).toBe(session);
    expect(target.env as unknown).toBe(env);
    expect(target.timeout()).toBe(1234);
    expect(entryMonitoringTarget(entry, { ...connection, queryTimeout: undefined }).timeout()).toBe(
      DEFAULT_QUERY_TIMEOUT,
    );
    await markedCall(target, async () => {
      expect(entry.running).toBe(1);
      return { kind: "answered" as const };
    });
    expect([entry.running, entry.lastUsed > 0]).toEqual([0, true]);

    // Studio's form: each spec's absent card fields absent, and `preview` only where the spec states it true.
    const accepted = target.accepted();
    expect(accepted).toEqual({
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "kill"],
      maintenanceOperationSpecs: {
        vacuum: {
          label: "Vacuum",
          perEntity: true,
          global: false,
          title: "Vacuum the table",
          description: "Reclaims space.",
          confirmation: "typed-target",
          preview: true,
          kinds: ["table"],
        },
        kill: { label: "Kill", perEntity: false, global: false },
      },
    });
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.keys(accepted.maintenanceOperationSpecs?.kill ?? {})).toEqual(["label", "perEntity", "global"]);
    // A copy: what a caller reads cannot reach the session's own lists.
    expect(accepted.maintenanceOperations).not.toBe(session.maintenance.maintenance);
    expect(accepted.maintenanceOperationSpecs?.vacuum?.kinds).not.toBe(session.maintenance.maintenanceSpecs[0]?.kinds);

    // A session that does not offer `maintenance.run` accepts none, whatever its declaration lists.
    expect(entryMonitoringTarget(packageEntry("not-offered").entry, connection).accepted()).toEqual({
      supportsMaintenance: false,
      maintenanceOperations: [],
      maintenanceOperationSpecs: {},
    });
  });

  test("a provider entry's monitoring target is the provider's, whose accepted maintenance is the provider's capabilities read when asked", () => {
    const provider = providerOf(4_000);
    const entry = { opened: { form: "provider", provider }, running: 0 } as unknown as CachedSession;
    const capabilities = mockOf(provider.getCapabilities);
    capabilities.mockClear();
    // A legacy provider's target reads the provider's own statement timeout, never the connection's.
    const target = entryMonitoringTarget(entry, connection);
    expect(target.session.calls.monitoring.panel).toBe("offered");
    expect(target.timeout()).toBe(4_000);
    expect(target.env).toBe(providerMonitoringTarget(provider).env);
    target.started();
    target.ended({ kind: "answered" });
    expect(entry.running).toBe(0);

    const fresh = { supportsMaintenance: true, maintenanceOperations: ["analyze"] };
    capabilities.mockImplementation(() => fresh);
    const before = capabilities.mock.calls.length;
    expect(target.accepted()).toBe(fresh as never);
    expect(capabilities.mock.calls.length).toBe(before + 1);
    expect(providerMonitoringTarget(provider).accepted()).toBe(fresh as never);
  });
});

describe("the console target", () => {
  test("a provider's console target is one bridged session with no environment and no marks, and an entry's is its session by form, the package's counting each call on the entry", async () => {
    // A provider's: one bridged session, which offers the cancel exactly where the provider can cancel.
    const provider = providerOf(4_000);
    Object.assign(provider, { cancelQuery: mock(async () => true) });
    const target = providerConsoleTarget(provider);
    expect(target.session.calls.console.cancel).toBe("offered");
    expect(target.session.calls).toEqual(bridgedConsole(provider, {}).session.calls);
    expect(target.env).toBe(providerTreeTarget(provider).env);
    expect(target.timeout()).toBe(4_000);
    expect(target.started()).toBeUndefined();
    expect(target.ended({ kind: "answered" })).toBeUndefined();
    expect(providerConsoleTarget(providerOf()).session.calls.console.cancel).toBe("not-offered");

    // A provider entry's: the provider's console target, its statement timeout the provider's own.
    const providerEntry = { opened: { form: "provider", provider }, running: 0 } as unknown as CachedSession;
    const connection = { id: "p", name: "p", type: "acmecon", queryTimeout: 1234 } as unknown as EngineConnection;
    const fromProvider = entryConsoleTarget(providerEntry, connection);
    expect(fromProvider.session.calls).toEqual(target.session.calls);
    expect(fromProvider.env).toBe(target.env);
    expect(fromProvider.timeout()).toBe(4_000);
    fromProvider.started();
    fromProvider.ended({ kind: "answered" });
    expect(providerEntry.running).toBe(0);

    // A package entry's: its session, its declared environment, the connection's timeout or Studio's default, and
    // each call counted on the entry until it answered, or until the call a stop answered has settled.
    const session = { calls: { console: { cancel: "offered" } }, marker: randomUUID() };
    const env = { marker: randomUUID() };
    const entry = { opened: { form: "session", session, env }, running: 0, lastUsed: 0 } as unknown as CachedSession;
    const packaged = entryConsoleTarget(entry, connection);
    expect(packaged.session as unknown).toBe(session);
    expect(packaged.env as unknown).toBe(env);
    expect(packaged.timeout()).toBe(1234);
    expect(entryConsoleTarget(entry, { ...connection, queryTimeout: undefined }).timeout()).toBe(DEFAULT_QUERY_TIMEOUT);
    packaged.started();
    expect(entry.running).toBe(1);
    packaged.ended({ kind: "answered" });
    expect([entry.running, entry.lastUsed > 0]).toEqual([0, true]);
    const settled = Promise.withResolvers<void>();
    packaged.started();
    packaged.ended({ kind: "stopped", settled: settled.promise });
    expect(entry.running).toBe(1);
    settled.resolve();
    await settled.promise;
    await Promise.resolve();
    expect(entry.running).toBe(0);
  });
});

describe("the maintenance opening of a provider package's cache entry", () => {
  /** A session offering `maintenance.run` or not, its narrowed maintenance one vacuum spec. */
  function packageOpened(run: "offered" | "not-offered", engineUser?: string) {
    const maintenance = {
      maintenance: ["vacuum"],
      maintenanceSpecs: [
        {
          operation: "vacuum",
          label: "Vacuum",
          perEntity: false,
          global: true,
          title: null,
          description: null,
          confirmation: null,
          preview: false,
          kinds: null,
        },
      ],
    };
    const session = { calls: { maintenance: { run, preview: "not-offered" } }, maintenance, marker: randomUUID() };
    const env = { marker: randomUUID() };
    const opened = { session, env, ...(engineUser === undefined ? {} : { engineUser }) };
    const entry = { opened: { form: "session", ...opened }, running: 0, lastUsed: 0 } as unknown as CachedSession;
    return { entry, opened: opened as unknown as OpenedPackageSession, session, env, maintenance };
  }
  const connection = { id: "p", name: "p", type: "acmemaint", queryTimeout: 1234 } as unknown as EngineConnection;

  test("a package entry's maintenance opening accepts the session's narrowed maintenance and its target is the session under its environment and timeout, marked on the entry, with the engine user its open answered", async () => {
    const engineUser = `user-${randomUUID()}`;
    const { entry, opened, session, env, maintenance } = packageOpened("offered", engineUser);
    const opening = packageMaintenanceOpening(entry, opened, connection);
    expect(opening.accepted()).toEqual({
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum"],
      maintenanceOperationSpecs: { vacuum: { label: "Vacuum", perEntity: false, global: true } },
    });
    const target = await opening.target();
    expect(target.session as unknown).toBe(session);
    expect(target.env as unknown).toBe(env);
    expect(target.timeout()).toBe(1234);
    expect(target.maintenance() as unknown).toBe(maintenance);
    expect(target.engineUser()).toBe(engineUser);
    await markedCall(target, async () => {
      expect(entry.running).toBe(1);
      return { kind: "answered" as const };
    });
    expect([entry.running, entry.lastUsed > 0]).toEqual([0, true]);
    const untimed = await packageMaintenanceOpening(entry, opened, { ...connection, queryTimeout: undefined }).target();
    expect(untimed.timeout()).toBe(DEFAULT_QUERY_TIMEOUT);

    // An open that answered no engine user names none; a session that does not offer `maintenance.run` accepts none.
    const unnamed = packageOpened("not-offered");
    const refusing = packageMaintenanceOpening(unnamed.entry, unnamed.opened, connection);
    expect((await refusing.target()).engineUser()).toBeUndefined();
    expect(refusing.accepted()).toEqual({
      supportsMaintenance: false,
      maintenanceOperations: [],
      maintenanceOperationSpecs: {},
    });
  });
});

describe("the console target's run forms", () => {
  const core = createHostCore();
  const ROUTE = "session-target-test";
  const scrub = providerTextScrub(
    { id: "c1", name: "Prod", type: "postgres", host: "db.internal" } as DatabaseConnection,
    "any",
  );
  /** A context an hour out on a signal no one aborts, with no environment. */
  const contextOf = () => ({
    deadline: Date.now() + 3_600_000,
    signal: new AbortController().signal,
    env: envReader([], () => undefined),
  });

  /** The limiter's rule as a SQL provider applies it: a bound of ours on every statement. */
  function limited(sql: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const limit = options.limit ?? 500;
    const offset = options.offset ?? 0;
    return { query: `${sql} LIMIT ${limit} OFFSET ${offset}`, wasLimited: true, limit, offset };
  }

  const resultOf = (rows: Record<string, unknown>[]): QueryResult => ({
    rows,
    fields: ["n"],
    rowCount: rows.length,
    executionTime: 3,
  });

  /** A session's calls: execute honouring `offset`, and the transaction facet offered or not. */
  function callsOf(transaction: boolean): Calls {
    return {
      console: {
        execute: { honours: ["offset"] },
        cancel: "not-offered",
        endScope: "not-offered",
        transaction: transaction ? "offered" : "not-offered",
      },
      objects: { tree: "not-offered", source: "not-offered" },
      maintenance: { run: "not-offered", preview: "not-offered" },
      monitoring: { panel: "not-offered", poolStats: "not-offered" },
    };
  }

  /** A provider package's cache entry over a session whose execute answers `answer`, recording each request. */
  function packageEntryOf(
    answer: (request: ExecuteRequest) => ExecuteAnswer,
    ownWords: "scrubbed" | "code-only" = "scrubbed",
  ) {
    const requests: ExecuteRequest[] = [];
    const session: ConsoleSession = {
      calls: callsOf(true),
      readOnlyStatements: false,
      execute: async (request) => {
        requests.push(request);
        return answer(request);
      },
    };
    const env = envReader([], () => undefined);
    const entry = {
      opened: { form: "session", session, env },
      engine: { grants: { ownWords } },
      running: 0,
      lastUsed: 0,
    } as unknown as CachedSession;
    return { entry, session, requests, target: entryConsoleTarget(entry, connection) };
  }
  const connection = { id: "p", name: "p", type: "acmerun", queryTimeout: 1234 } as unknown as EngineConnection;
  const COLUMNS: readonly Column[] = [{ name: "n", type: "int8" }, { name: "label" }];

  test("a provider's console target runs each statement on a bridged session of its own built with the run's page options, and answers the body the editor builds from the legacy result", async () => {
    const query = mock(async (_sql: string) => resultOf([{ n: 1 }, { n: 2 }, { n: 3 }]));
    const provider = Object.assign(providerOf(), { prepareQuery: mock(limited), query });
    const target = providerConsoleTarget(provider);
    const run = { options: { limit: 2, offset: 4 }, scrub, route: ROUTE };

    const form = target.statement(run);
    // A session of its own per statement, so one run's legacy result is never another's.
    expect(target.statement(run).session).not.toBe(form.session);
    expect(form.page).toEqual({ limit: 2, offset: 4 });
    expect(target.statement({ ...run, options: { unlimited: true } }).page).toEqual({ unlimited: true });
    expect(form.cancelSent()).toBe(false);

    const record = await core.executeCall(
      form.session,
      { statement: "SELECT n FROM t", page: form.page },
      contextOf(),
      form.pumpLimits,
      hostPorts(ROUTE, form.cancelSent),
    );
    expect(record.kind).toBe("page");
    const { body, resultSetCount } = form.body(record as PageRecord);

    // The bridge adds the probe row in its prepare, and the body cuts it back off (#1440).
    expect(query.mock.calls.map((call) => call[0])).toEqual(["SELECT n FROM t LIMIT 3 OFFSET 4"]);
    expect(body.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(body.pagination).toEqual({ limit: 2, offset: 4, hasMore: true, totalReturned: 2, wasLimited: true });
    expect(resultSetCount).toBe(1);
  });

  test("a package entry's console target runs each statement on its session, asking one row past the page, and answers its page under the record's grant of its own words", async () => {
    const said = `notice ${randomUUID()}`;
    const answer = (): ExecuteAnswer => ({
      results: [
        rowsSource(
          COLUMNS,
          [
            [BigInt(1), "a"],
            [BigInt(2), "b"],
            [BigInt(3), "c"],
          ],
          3,
        ),
      ],
      warnings: [{ message: said }],
      executionTimeMs: 7,
      pageApplied: true,
    });
    const scrubbed = packageEntryOf(answer);
    const form = scrubbed.target.statement({ options: { limit: 2, offset: 4 }, scrub, route: ROUTE });
    expect(form.session).toBe(scrubbed.session);
    expect(form.page).toEqual({ limit: 3, offset: 4 });
    expect(form.cancelSent()).toBe(false);

    const record = await core.executeCall(
      form.session,
      { statement: "SELECT n, label FROM t", page: form.page },
      contextOf(),
      form.pumpLimits,
      hostPorts(ROUTE),
    );
    const limits = scrubbed.target.statement({ options: { limit: 2 }, scrub, route: ROUTE });
    expect(limits.pumpLimits({ results: [], warnings: [], executionTimeMs: 0, pageApplied: false })).toEqual({
      maxRows: 3,
      maxBytes: PAGE_MAX_BYTES,
      batchMaxBytes: BATCH_MAX_BYTES,
    });
    const { body } = form.body(record as PageRecord);
    expect(scrubbed.requests.map((request) => request.page)).toEqual([{ limit: 3, offset: 4 }]);
    expect(body).toEqual({
      rows: [
        { n: encodeValue(BigInt(1)), label: "a" },
        { n: encodeValue(BigInt(2)), label: "b" },
      ],
      fields: ["n", "label"],
      columnTypes: { n: "int8" },
      rowCount: 2,
      executionTime: 7,
      warnings: [{ message: said }],
      pagination: { limit: 2, offset: 4, hasMore: true, totalReturned: 2, wasLimited: true },
    });

    // A record that grants the package no words of its own answers Studio's sentence naming their count.
    const codeOnly = packageEntryOf(answer, "code-only");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const own = codeOnly.target.statement({ options: { limit: 2 }, scrub, route: ROUTE });
      const ownRecord = await core.executeCall(
        own.session,
        { statement: "SELECT n, label FROM t", page: own.page },
        contextOf(),
        own.pumpLimits,
        hostPorts(ROUTE),
      );
      expect(own.body(ownRecord as PageRecord).body.warnings).toEqual([
        { message: "The provider package returned 1 warning; the server's log holds their words." },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a provider's transaction script unit is the bridge's where the provider holds a transaction session, and its bridged console, which offers no transaction, where it does not", async () => {
    const [unit] = splitExecutionUnits("SELECT n FROM t", resolveSqlGrammar("postgres"));
    if (unit === undefined) throw new Error("the splitter answered no unit");
    const result = resultOf([{ n: 1 }]);
    const queryInTransaction = mock(async (_sql: string) => result);
    const transactional = Object.assign(providerOf(), {
      prepareQuery: mock(limited),
      beginTransaction: mock(async () => undefined),
      commitTransaction: mock(async () => undefined),
      rollbackTransaction: mock(async () => undefined),
      isInTransaction: mock(() => true),
      queryInTransaction,
    });

    const form = providerConsoleTarget(transactional).transactionScriptUnit({ unit, lastUnitOptions: { limit: 5 } });
    expect(form.session.calls.console.transaction).toBe("offered");
    const record = await core.executeCall(
      form.session,
      { statement: unit.sql, page: { limit: 5, offset: 0 }, transaction: true },
      contextOf(),
      form.pumpLimits,
      hostPorts(ROUTE),
    );
    expect(record.kind).toBe("page");
    // The legacy result by reference, the unit's text bounded by the provider's prepare and never probed.
    expect(form.answered(record as PageRecord)).toBe(result);
    expect(queryInTransaction.mock.calls.map((call) => call[0])).toEqual(["SELECT n FROM t LIMIT 5 OFFSET 0"]);
    (record as PageRecord).release();

    // A provider without a transaction session: its bridged console, which the host core refuses a unit before the call.
    const plain = Object.assign(providerOf(), { prepareQuery: mock(limited), query: mock(async () => result) });
    const bare = providerConsoleTarget(plain).transactionScriptUnit({ unit });
    expect(bare.session.calls.console.transaction).toBe("not-offered");
    const refused = await core.executeCall(
      bare.session,
      { statement: unit.sql, page: { unlimited: true }, transaction: true },
      contextOf(),
      bare.pumpLimits,
      hostPorts(ROUTE),
    );
    expect(refused).toMatchObject({ kind: "refused", called: false });
    expect(plain.query).not.toHaveBeenCalled();
  });

  test("a package entry's transaction script unit is its session, every row for a unit but the last and the request's limit for the last, its result the page's rows keyed by column name in the value codec's wire form", async () => {
    const [unit] = splitExecutionUnits("SELECT n, label FROM t", resolveSqlGrammar("postgres"));
    if (unit === undefined) throw new Error("the splitter answered no unit");
    const { target, session, requests } = packageEntryOf(() => ({
      results: [
        rowsSource(
          COLUMNS,
          [
            [BigInt(1), "a"],
            [BigInt(2), "b"],
            [BigInt(3), "c"],
          ],
          9,
        ),
      ],
      warnings: [],
      executionTimeMs: 4,
      pageApplied: false,
      sessionState: "in-transaction",
    }));
    const empty: ExecuteAnswer = { results: [], warnings: [], executionTimeMs: 0, pageApplied: false };

    const middle = target.transactionScriptUnit({ unit });
    expect(middle.session).toBe(session);
    expect(middle.pumpLimits(empty).maxRows).toBe(Number.MAX_SAFE_INTEGER);
    expect(target.transactionScriptUnit({ unit, lastUnitOptions: { unlimited: true } }).pumpLimits(empty)).toEqual({
      maxRows: Number.MAX_SAFE_INTEGER,
      maxBytes: PAGE_MAX_BYTES,
      batchMaxBytes: BATCH_MAX_BYTES,
    });

    // Every row of a unit but the last: the page holds them all, and the row count is the package's own.
    const whole = await core.executeCall(
      session,
      { statement: unit.sql, page: { unlimited: true }, transaction: true },
      contextOf(),
      middle.pumpLimits,
      hostPorts(ROUTE),
    );
    expect(middle.answered(whole as PageRecord)).toEqual({
      rows: [
        { n: encodeValue(BigInt(1)), label: "a" },
        { n: encodeValue(BigInt(2)), label: "b" },
        { n: encodeValue(BigInt(3)), label: "c" },
      ],
      fields: ["n", "label"],
      columnTypes: { n: "int8" },
      rowCount: 9,
      executionTime: 4,
    });
    (whole as PageRecord).release();

    // The last unit asks the request's page and no row past it: its row count is the rows answered.
    const last = target.transactionScriptUnit({ unit, lastUnitOptions: { limit: 2 } });
    const paged = await core.executeCall(
      session,
      { statement: unit.sql, page: { limit: 2, offset: 0 }, transaction: true },
      contextOf(),
      last.pumpLimits,
      hostPorts(ROUTE),
    );
    expect(last.answered(paged as PageRecord)).toMatchObject({ rowCount: 2, fields: ["n", "label"] });
    expect((last.answered(paged as PageRecord) as QueryResult).rows).toHaveLength(2);
    (paged as PageRecord).release();
    expect(requests.map((request) => request.page)).toEqual([{ unlimited: true }, { limit: 2, offset: 0 }]);
  });

  test("a package transaction script unit whose page the host cut by bytes is the unit's StudioByteBudgetRefusal, never a shorter result", () => {
    const value = randomUUID();
    const [unit] = splitExecutionUnits("SELECT n FROM t", resolveSqlGrammar("postgres"));
    if (unit === undefined) throw new Error("the splitter answered no unit");
    const { target } = packageEntryOf(() => {
      throw new Error("the form's answer reads the page record alone");
    });
    const form = target.transactionScriptUnit({ unit });
    form.pumpLimits({ results: [rowsSource(COLUMNS, [])], warnings: [], executionTimeMs: 0, pageApplied: false });
    const record = {
      kind: "page",
      page: { rows: [[BigInt(1), value]], bytes: PAGE_MAX_BYTES, end: "byte-limit" },
      resultCount: 1,
      pageApplied: false,
      executionTimeMs: 1,
      warnings: [],
      sessionState: "in-transaction",
      release: () => undefined,
    } as PageRecord;

    let caught: unknown;
    try {
      form.answered(record);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StudioByteBudgetRefusal);
    expect((caught as Error).message).toBe(
      `The unit's result is more than the ${PAGE_MAX_BYTES} bytes one page of a result may hold, and a script's answer has no field to say where a page ends, so Studio answers none of its rows.`,
    );
    expect(errorOutcome(caught)).toBe("unknown");
    expect((caught as Error).message).not.toContain(value);
  });

  test("a console target answers the plan its session supports, a provider's read from its capabilities when asked and none for a provider package's session", () => {
    const provider = providerOf();
    const capabilities = mockOf(provider.getCapabilities);
    capabilities.mockImplementation(() => ({ supportsExplain: true, explainFormat: "postgres-json" }));
    const target = providerConsoleTarget(provider);
    const built = capabilities.mock.calls.length;
    const support = target.explainSupport();
    expect(capabilities.mock.calls.length).toBe(built + 1);
    expect([support.supportsExplain, support.explainFormat]).toEqual([true, "postgres-json"]);

    const untouched = {
      calls: callsOf(false),
      readOnlyStatements: false,
      execute: () => {
        throw new Error("a plan read called the session");
      },
    };
    const entry = {
      opened: { form: "session", session: untouched, env: envReader([], () => undefined) },
      running: 0,
      lastUsed: 0,
    } as unknown as CachedSession;
    expect(entryConsoleTarget(entry, connection).explainSupport()).toEqual({ supportsExplain: false });
    expect(entry.running).toBe(0);
  });

  describe("the console target's script forms", () => {
    test("a provider's console target runs each unit of a script on the bridge's script unit session, its last unit bounded under the provider's type with the request's page options", async () => {
      const [unit] = splitExecutionUnits("SELECT n FROM t", resolveSqlGrammar("postgres"));
      if (unit === undefined) throw new Error("the splitter answered no unit");
      const result = resultOf([{ n: 1 }]);
      const query = mock(async (_sql: string) => result);
      const prepareQuery = mock(limited);
      const provider = Object.assign(providerOf(), { prepareQuery, query });
      const target = providerConsoleTarget(provider);

      // A unit but the last: a session of its own per unit, sent as written, the legacy result by reference.
      const middle = target.scriptUnit({ unit, scrub, route: ROUTE });
      expect(target.scriptUnit({ unit, scrub, route: ROUTE }).session).not.toBe(middle.session);
      expect(middle.session).not.toBe(target.session);
      expect(middle.session.calls.console.execute.honours).toEqual(["offset"]);
      expect(middle.cancelSent()).toBe(false);
      const whole = await core.executeCall(
        middle.session,
        { statement: unit.sql, page: { unlimited: true } },
        contextOf(),
        middle.pumpLimits,
        hostPorts(ROUTE, middle.cancelSent),
      );
      expect(whole.kind).toBe("page");
      expect(middle.answered(whole as PageRecord)).toBe(result);
      (whole as PageRecord).release();
      expect(prepareQuery).not.toHaveBeenCalled();

      // The last unit: its read bounded by the provider's prepare with the request's page options, never probed.
      const last = target.scriptUnit({ unit, lastUnitOptions: { limit: 5 }, scrub, route: ROUTE });
      const paged = await core.executeCall(
        last.session,
        { statement: unit.sql, page: { limit: 5, offset: 0 } },
        contextOf(),
        last.pumpLimits,
        hostPorts(ROUTE, last.cancelSent),
      );
      expect(last.answered(paged as PageRecord)).toBe(result);
      (paged as PageRecord).release();
      expect(prepareQuery.mock.calls).toEqual([["SELECT n FROM t", { limit: 5 }]]);
      expect(query.mock.calls.map((call) => call[0])).toEqual(["SELECT n FROM t", "SELECT n FROM t LIMIT 5 OFFSET 0"]);
    });

    test("a package entry's console target runs each unit of a script on its session, every row for a unit but the last and the request's limit for the last, its warnings answered by the record's grant of its own words", async () => {
      const [unit] = splitExecutionUnits("SELECT n, label FROM t", resolveSqlGrammar("postgres"));
      if (unit === undefined) throw new Error("the splitter answered no unit");
      const said = `notice ${randomUUID()}`;
      let warned = true;
      const answer = (): ExecuteAnswer => ({
        results: [
          rowsSource(
            COLUMNS,
            [
              [BigInt(1), "a"],
              [BigInt(2), "b"],
            ],
            2,
          ),
        ],
        warnings: warned ? [{ message: said }] : [],
        executionTimeMs: 5,
        pageApplied: false,
      });
      const empty: ExecuteAnswer = { results: [], warnings: [], executionTimeMs: 0, pageApplied: false };
      const scrubbed = packageEntryOf(answer);

      // A unit but the last: the session itself, every row, and its warnings scrubbed where the record grants words.
      const middle = scrubbed.target.scriptUnit({ unit, scrub, route: ROUTE });
      expect(middle.session).toBe(scrubbed.session);
      expect(middle.cancelSent()).toBe(false);
      expect(middle.pumpLimits(empty)).toEqual({
        maxRows: Number.MAX_SAFE_INTEGER,
        maxBytes: PAGE_MAX_BYTES,
        batchMaxBytes: BATCH_MAX_BYTES,
      });
      const whole = await core.executeCall(
        middle.session,
        { statement: unit.sql, page: { unlimited: true } },
        contextOf(),
        middle.pumpLimits,
        hostPorts(ROUTE),
      );
      expect(middle.answered(whole as PageRecord)).toEqual({
        rows: [
          { n: encodeValue(BigInt(1)), label: "a" },
          { n: encodeValue(BigInt(2)), label: "b" },
        ],
        fields: ["n", "label"],
        columnTypes: { n: "int8" },
        rowCount: 2,
        executionTime: 5,
        warnings: [{ message: said }],
      });
      (whole as PageRecord).release();

      // The last unit asks the request's limit and no row past it.
      const last = scrubbed.target.scriptUnit({ unit, lastUnitOptions: { limit: 1 }, scrub, route: ROUTE });
      expect(last.pumpLimits(empty).maxRows).toBe(1);
      const paged = await core.executeCall(
        last.session,
        { statement: unit.sql, page: { limit: 1, offset: 0 } },
        contextOf(),
        last.pumpLimits,
        hostPorts(ROUTE),
      );
      expect(last.answered(paged as PageRecord)).toMatchObject({ rowCount: 1, rows: [{ label: "a" }] });
      (paged as PageRecord).release();
      expect(scrubbed.requests.map((request) => request.page)).toEqual([{ unlimited: true }, { limit: 1, offset: 0 }]);

      // A record that grants the package no words of its own answers Studio's sentence naming their count, logged.
      const codeOnly = packageEntryOf(answer, "code-only");
      const logged: unknown[][] = [];
      const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      try {
        const own = codeOnly.target.scriptUnit({ unit, scrub, route: ROUTE });
        const ownRecord = await core.executeCall(
          own.session,
          { statement: unit.sql, page: { unlimited: true } },
          contextOf(),
          own.pumpLimits,
          hostPorts(ROUTE),
        );
        expect(own.answered(ownRecord as PageRecord).warnings).toEqual([
          { message: "The provider package returned 1 warning; the server's log holds their words." },
        ]);
        (ownRecord as PageRecord).release();
      } finally {
        warn.mockRestore();
      }
      expect(logged).toHaveLength(1);
      expect(JSON.stringify(logged[0]?.[1])).toContain(ROUTE);

      // A unit that reported no warning answers none, never an empty list.
      warned = false;
      const quiet = scrubbed.target.scriptUnit({ unit, scrub, route: ROUTE });
      const quietRecord = await core.executeCall(
        quiet.session,
        { statement: unit.sql, page: { unlimited: true } },
        contextOf(),
        quiet.pumpLimits,
        hostPorts(ROUTE),
      );
      expect(Object.hasOwn(quiet.answered(quietRecord as PageRecord), "warnings")).toBe(false);
      (quietRecord as PageRecord).release();
    });
  });

  describe("the reads built for the data profile and a composed statement", () => {
    test("the profile's sample and a composed read are each one bridged session of the provider, the sample built with its page of rows and the composed one sending the statement alone", async () => {
      const result = resultOf([{ n: 1 }, { n: 2 }, { n: 3 }]);
      const query = mock(async (..._args: unknown[]) => result);
      const prepareQuery = mock(limited);
      const provider = Object.assign(providerOf(), { prepareQuery, query });

      // The sample: a bridged console session of its own, bounded by the provider's prepare with the page of rows.
      const sample = providerSampleRead(provider, 2);
      expect(providerSampleRead(provider, 2).session).not.toBe(sample.session);
      const sampled = await core.executeCall(
        sample.session,
        { statement: "SELECT n FROM t", page: { limit: 2, offset: 0 } },
        contextOf(),
        sample.pumpLimits,
        hostPorts(ROUTE),
      );
      expect(sampled.kind).toBe("page");
      expect(sample.answered()).toBe(result);
      (sampled as PageRecord).release();
      // The bridge adds the probe row past the page in its prepare (#1440).
      expect(prepareQuery.mock.calls.map((call) => call[1])).toEqual([{ limit: 2 }, { limit: 3, unlimited: false }]);
      expect(query.mock.calls.map((call) => call[0])).toEqual(["SELECT n FROM t LIMIT 3 OFFSET 0"]);

      // The composed read: execute alone, honouring no field, the statement sent alone to the plain query.
      query.mockClear();
      const composed = providerComposedRead(provider);
      expect(providerComposedRead(provider).session).not.toBe(composed.session);
      expect(composed.session.calls.console.execute.honours).toEqual([]);
      const read = await core.executeCall(
        composed.session,
        { statement: "SELECT count(*) FROM t", page: { unlimited: true } },
        contextOf(),
        composed.pumpLimits,
        hostPorts(ROUTE),
      );
      expect(composed.answered()).toBe(result);
      (read as PageRecord).release();
      expect(query.mock.calls).toEqual([["SELECT count(*) FROM t"]]);
      expect(prepareQuery).toHaveBeenCalledTimes(2);
    });
  });
});
