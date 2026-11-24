/**
 * The legacy bridge (src/lib/provider-host/legacy-bridge.ts; docs/providers/CONTRACT.md, clause C-50): a legacy
 * `DatabaseProvider` served as a session of console execute, cancel, endScope and transaction, its declared calls, the
 * copies it hands the provider, today's provider steps, one source per result set, the measured form of a row and the
 * page's row limit.
 *
 * Every provider here is a fake the test builds; every marker is generated at run time and no timer runs.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BATCH_MAX_BYTES,
  type CallContext,
  checkMaintenanceFacet,
  checkMonitoringFacet,
  checkObjectsFacet,
  encodedRowBytes,
  envReader,
  type ExecuteAnswer,
  type ExecuteRequest,
  freezeData,
  type MonitoringPanelRequest,
  PAGE_MAX_BYTES,
  pumpPage,
  type ResultSource,
  type TreeContainersRequest,
  type TreeCountRequest,
  type TreeDescribeManyRequest,
  type TreeDescribeRequest,
  type TreeListRequest,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";
import {
  type BeginTransactionResult,
  type DatabaseProvider,
  isTransactionProvider,
  type MaintenanceDeclaration,
  narrowMaintenance,
  type PreparedQuery,
  type ProviderCapabilities,
  type QueryPrepareOptions,
} from "@/lib/db/types";
import type { ConsoleSession } from "@/lib/provider-host/core/console";
import { runEditorQuery } from "@/lib/api/editor-query";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { engineFacetsFor } from "@/lib/db/engine-facets";
import { appendedBoundNote } from "@/lib/db/utils/query-limiter";
import { bridgedConsole, bridgedMaintenance } from "@/lib/provider-host/legacy-bridge";
import type { QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";

// The editor query reads the process's host core (src/lib/provider-host/instance.ts), so this file composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const HOUR = 3_600_000;
const marker = (): string => randomUUID();

/** The limiter's rule as a SQL provider applies it: a bound of ours, unless the text carries its own LIMIT. */
function limiter(sql: string, options: QueryPrepareOptions = {}): PreparedQuery {
  const limit = options.limit ?? 500;
  const offset = options.offset ?? 0;
  if (options.unlimited === true || /\blimit\b/i.test(sql)) return { query: sql, wasLimited: false, limit, offset };
  return { query: `${sql} LIMIT ${limit} OFFSET ${offset}`, wasLimited: true, limit, offset };
}

const resultOf = (rows: Record<string, unknown>[], more: Partial<QueryResult> = {}): QueryResult => ({
  rows,
  fields: ["n"],
  rowCount: rows.length,
  executionTime: 3,
  ...more,
});
const rowsOf = (count: number) => Array.from({ length: count }, (_, n) => ({ n: n + 1 }));

function fake(answer: QueryResult | Error, extra: Record<string, unknown> = {}): DatabaseProvider {
  return Object.assign(
    createMockProvider(),
    {
      prepareQuery: mock(limiter),
      query: mock(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    },
    extra,
  );
}

const callsOf = (fn: unknown) => (fn as ReturnType<typeof mock>).mock.calls;

/**
 * A provider with the five transaction methods, over a session whose state the test sets through `open`: a begin opens
 * it, a COMMIT or ROLLBACK closes it, and `isInTransaction` reads it. A begin answers `begun` when given.
 */
function transactionalFake(begun?: BeginTransactionResult, extra: Record<string, unknown> = {}) {
  const fx = {
    open: false,
    provider: undefined as unknown as DatabaseProvider & {
      beginTransaction: ReturnType<typeof mock>;
      commitTransaction: ReturnType<typeof mock>;
      rollbackTransaction: ReturnType<typeof mock>;
      isInTransaction: ReturnType<typeof mock>;
      queryInTransaction: ReturnType<typeof mock>;
    },
  };
  fx.provider = Object.assign(fake(resultOf([])), {
    beginTransaction: mock(async () => {
      fx.open = true;
      return begun;
    }),
    commitTransaction: mock(async () => {
      fx.open = false;
    }),
    rollbackTransaction: mock(async () => {
      fx.open = false;
    }),
    isInTransaction: mock(() => fx.open),
    queryInTransaction: mock(async () => resultOf([])),
    ...extra,
  });
  return fx;
}

function contextOf(): CallContext {
  return { deadline: Date.now() + HOUR, signal: new AbortController().signal, env: envReader([], () => undefined) };
}

function requestOf(over: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return freezeData({ statement: "SELECT n FROM t", page: { limit: 2, offset: 0 }, ...over });
}

const PAGE = { maxRows: 1_000, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES } as const;

/** What `run` threw; a run that does not throw fails the case. */
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("The call was expected to fail, and it answered.");
}

describe("bridgedConsole", () => {
  test("a bridged session honours params and offset, offers cancel only where the provider cancels, and endScope only where the provider ends its query path's transactions", () => {
    const cancelling = bridgedConsole(fake(resultOf([]), { cancelQuery: mock(async () => true) }), {});
    const plain = bridgedConsole(fake(resultOf([])), {});
    const ending = bridgedConsole(fake(resultOf([]), { endOpenQueryTransaction: mock(async () => "none") }), {});

    expect(cancelling.session.calls).toEqual({
      console: {
        execute: { honours: ["params", "offset"] },
        cancel: "offered",
        endScope: "not-offered",
        transaction: "not-offered",
      },
      objects: { tree: "offered" },
      maintenance: { run: "offered", preview: "not-offered" },
      monitoring: { panel: "offered", poolStats: "not-offered" },
    });
    expect(plain.session.calls.console.cancel).toBe("not-offered");
    expect(typeof cancelling.session.cancel).toBe("function");
    expect(plain.session.cancel).toBeUndefined();
    expect(plain.session.calls.console.endScope).toBe("not-offered");
    expect(plain.session.endScope).toBeUndefined();
    expect(cancelling.session.endScope).toBeUndefined();
    expect(ending.session.calls).toEqual({
      console: {
        execute: { honours: ["params", "offset"] },
        cancel: "not-offered",
        endScope: "offered",
        transaction: "not-offered",
      },
      objects: { tree: "offered" },
      maintenance: { run: "offered", preview: "not-offered" },
      monitoring: { panel: "offered", poolStats: "not-offered" },
    });
    expect(typeof ending.session.endScope).toBe("function");
    expect(Object.isFrozen(cancelling.session.calls)).toBe(true);
    expect(Object.isFrozen(cancelling.session.calls.console.execute.honours)).toBe(true);
  });

  test("a bridged session offers objects.tree for every provider", () => {
    const sessions = [
      bridgedConsole(fake(resultOf([])), {}),
      bridgedConsole(fake(resultOf([]), { cancelQuery: mock(async () => true) }), {}),
      bridgedConsole(fake(resultOf([]), { endOpenQueryTransaction: mock(async () => "none") }), {}),
      bridgedConsole(transactionalFake().provider, {}),
    ];

    for (const { session } of sessions) {
      expect(session.calls.objects).toEqual({ tree: "offered" });
      expect(Object.isFrozen(session.calls.objects)).toBe(true);
      expect(checkObjectsFacet(session.calls, "tree")).toEqual([]);
      expect(typeof session.tree).toBe("function");
    }
  });

  test("a bridged session offers maintenance.run for every provider and maintenance.preview exactly where the provider previews", () => {
    const milvusLike = Object.assign(fake(resultOf([])), {
      previewMaintenance: mock(async () => ({ summary: "", facts: [] })),
      engineUser: () => "root",
    });
    const cases = [
      { previews: false, bridged: bridgedConsole(fake(resultOf([])), {}) },
      { previews: true, bridged: bridgedConsole(milvusLike, {}) },
      { previews: false, bridged: bridgedConsole(transactionalFake().provider, {}) },
      { previews: false, bridged: bridgedConsole(fake(resultOf([]), { cancelQuery: mock(async () => true) }), {}) },
    ];

    for (const { previews, bridged } of cases) {
      const { session } = bridged;
      expect(session.calls.maintenance).toEqual({ run: "offered", preview: previews ? "offered" : "not-offered" });
      expect(Object.isFrozen(session.calls.maintenance)).toBe(true);
      expect(checkMaintenanceFacet(session.calls, "run")).toEqual([]);
      expect(checkMaintenanceFacet(session.calls, "preview")).toEqual(
        previews ? [] : [{ rule: "facet-not-offered", pointer: "/maintenance/preview", name: "maintenance.preview" }],
      );
      expect(typeof session.run).toBe("function");
      expect(session.preview === undefined).toBe(!previews);
    }
  });

  test("a bridged session offers monitoring.panel for every provider and monitoring.poolStats exactly where the provider reads its pool statistics", () => {
    const getPoolStats = mock(() => ({ total: 1, idle: 1, active: 0, waiting: 0 }));
    const own = fake(resultOf([]), { getPoolStats });
    const inherited = Object.setPrototypeOf(fake(resultOf([])), { getPoolStats }) as DatabaseProvider;
    const cases = [
      { pools: false, bridged: bridgedConsole(fake(resultOf([])), {}) },
      { pools: true, bridged: bridgedConsole(own, {}) },
      { pools: true, bridged: bridgedConsole(inherited, {}) },
      { pools: false, bridged: bridgedConsole(fake(resultOf([]), { getPoolStats: marker() }), {}) },
      { pools: false, bridged: bridgedConsole(transactionalFake().provider, {}) },
    ];

    for (const { pools, bridged } of cases) {
      const { session } = bridged;
      expect(session.calls.monitoring).toEqual({ panel: "offered", poolStats: pools ? "offered" : "not-offered" });
      expect(Object.isFrozen(session.calls.monitoring)).toBe(true);
      expect(checkMonitoringFacet(session.calls, "panel")).toEqual([]);
      expect(checkMonitoringFacet(session.calls, "poolStats")).toEqual(
        pools ? [] : [{ rule: "facet-not-offered", pointer: "/monitoring/poolStats", name: "monitoring.poolStats" }],
      );
      expect(typeof session.panel).toBe("function");
      expect(session.poolStats === undefined).toBe(!pools);
    }
    expect(getPoolStats).not.toHaveBeenCalled();
  });

  test("a bridged session's panels are its engine's row", () => {
    for (const type of ["postgres", "cassandra"] as const) {
      const { session } = bridgedConsole(createMockProvider({ type }), {});
      expect(session.panels).toBe(engineFacetsFor(type).monitoring);
    }
    expect(Object.values(engineFacetsFor("postgres").monitoring).every((offer) => offer === "offered")).toBe(true);
    expect(
      Object.values(engineFacetsFor("cassandra").monitoring).filter((offer) => offer === "not-offered"),
    ).toHaveLength(4);
  });

  test("a bridged panel call runs the panel's own member with today's argument and answers its answer by reference under the panel's key", async () => {
    const MEMBER = {
      overview: "getOverview",
      performance: "getPerformanceMetrics",
      slowQueries: "getSlowQueries",
      activeSessions: "getActiveSessions",
      tables: "getTableStats",
      indexes: "getIndexStats",
      storage: "getStorageStats",
    } as const;
    const schema = marker();
    const cases: readonly { request: MonitoringPanelRequest; args: unknown[] }[] = [
      { request: { panel: "overview" }, args: [] },
      { request: { panel: "performance" }, args: [] },
      { request: { panel: "slowQueries", limit: 7 }, args: [{ limit: 7 }] },
      { request: { panel: "activeSessions", limit: 13 }, args: [{ limit: 13 }] },
      { request: { panel: "tables" }, args: [{ schema: undefined }] },
      { request: { panel: "indexes", schema }, args: [{ schema }] },
      { request: { panel: "storage" }, args: [] },
    ];

    await Promise.all(
      cases.map(async ({ request, args }) => {
        const answer = { marker: marker() };
        const failed = new Error(marker());
        const members = Object.fromEntries(
          Object.values(MEMBER).map((member) => [member, mock(async () => answer)]),
        ) as Record<(typeof MEMBER)[keyof typeof MEMBER], ReturnType<typeof mock>>;
        const forCatalog = mock(async () => fake(resultOf([])));
        const provider = fake(resultOf([]), { ...members, forCatalog });
        const { session } = bridgedConsole(provider, {});
        const panel = session.panel as NonNullable<typeof session.panel>;

        const got = await panel(freezeData(request), contextOf());

        const member = MEMBER[request.panel];
        expect(Object.keys(got)).toEqual([request.panel]);
        expect((got as Record<string, unknown>)[request.panel]).toBe(answer);
        expect(callsOf(members[member])).toEqual([args]);
        for (const other of Object.values(MEMBER).filter((name) => name !== member)) {
          expect(members[other]).not.toHaveBeenCalled();
        }
        expect(forCatalog).not.toHaveBeenCalled();
        expect(provider.query).not.toHaveBeenCalled();

        members[member].mockImplementation(async () => {
          throw failed;
        });
        expect(await failure(() => panel(freezeData(request), contextOf()))).toBe(failed);
      }),
    );
  });

  test("a bridged pool statistics call answers the provider's own statistics by reference, and a throw as its rejection", async () => {
    const stats = { total: 4, idle: 1, active: 3, waiting: 2, max: 10 };
    const forCatalog = mock(async () => fake(resultOf([])));
    const getPoolStats = mock(() => stats);
    const provider = fake(resultOf([]), { getPoolStats, forCatalog });
    const { session } = bridgedConsole(provider, {});
    const poolStats = session.poolStats as NonNullable<typeof session.poolStats>;

    expect(await poolStats(contextOf())).toBe(stats);
    expect(callsOf(getPoolStats)).toEqual([[]]);
    expect(forCatalog).not.toHaveBeenCalled();
    expect(provider.getOverview).not.toHaveBeenCalled();

    const thrown = new Error(marker());
    getPoolStats.mockImplementation(() => {
      throw thrown;
    });
    const call = poolStats(contextOf());
    expect(call).toBeInstanceOf(Promise);
    expect(await failure(() => call)).toBe(thrown);
  });

  test("a bridged maintenance run calls runMaintenance with the operation, the target and the container, undefined where absent, and answers its result by reference", async () => {
    const results = [
      { success: true, executionTime: 2, message: marker() },
      { success: true, executionTime: 1, message: marker(), rows: [{ key: marker() }], fields: ["key"] },
      { success: false, executionTime: 0, message: marker() },
    ];
    const answers = [...results];
    const forCatalog = mock(async () => fake(resultOf([])));
    const provider = Object.assign(fake(resultOf([])), {
      runMaintenance: mock(async () => answers.shift()),
      forCatalog,
    });
    const { session } = bridgedConsole(provider, {});
    const run = session.run as NonNullable<typeof session.run>;

    const got = [];
    for (const request of [
      { operation: "vacuum", target: "users", container: "app" },
      { operation: "vacuum" },
      { operation: "kill", target: "4711" },
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time, so each answer is its own run's.
      got.push(await run(freezeData(request), contextOf()));
    }

    expect(callsOf(provider.runMaintenance)).toEqual([
      ["vacuum", "users", "app"],
      ["vacuum", undefined, undefined],
      ["kill", "4711", undefined],
    ]);
    for (const call of callsOf(provider.runMaintenance)) expect(call).toHaveLength(3);
    for (const [index, result] of results.entries()) expect(got[index]).toBe(result);
    expect(forCatalog).not.toHaveBeenCalled();
    expect(provider.query).not.toHaveBeenCalled();
  });

  test("a bridged maintenance preview calls previewMaintenance with a copy of the path and answers its preview by reference", async () => {
    const preview = { summary: marker(), facts: [{ label: marker(), value: marker() }] };
    const received: string[][] = [];
    const forCatalog = mock(async () => fake(resultOf([])));
    const provider = Object.assign(fake(resultOf([])), {
      previewMaintenance: mock(async (_operation: string, path: string[]) => {
        received.push(path);
        path.push(marker());
        return preview;
      }),
      forCatalog,
    });
    const { session } = bridgedConsole(provider, {});
    const previewCall = session.preview as NonNullable<typeof session.preview>;
    const request = freezeData({ operation: "release" as const, path: ["app", "orders"] });

    const got = await previewCall(request, contextOf());

    expect(got).toBe(preview);
    expect(callsOf(provider.previewMaintenance)).toHaveLength(1);
    expect(callsOf(provider.previewMaintenance)[0]?.[0]).toBe("release");
    expect(received[0]).not.toBe(request.path);
    expect(request.path).toEqual(["app", "orders"]);
    expect(callsOf(provider.previewMaintenance)[0]).toHaveLength(2);
    expect(forCatalog).not.toHaveBeenCalled();
    expect(provider.runMaintenance).not.toHaveBeenCalled();
  });

  test("a bridged maintenance call whose member throws passes the error by reference", async () => {
    const ranThrown = new Error(marker());
    const previewThrown = new Error(marker());
    const provider = Object.assign(fake(resultOf([])), {
      runMaintenance: mock(async () => {
        throw ranThrown;
      }),
      previewMaintenance: mock(async () => {
        throw previewThrown;
      }),
    });
    const { session } = bridgedConsole(provider, {});
    const run = session.run as NonNullable<typeof session.run>;
    const previewCall = session.preview as NonNullable<typeof session.preview>;

    const ran = await failure(() => run(freezeData({ operation: "analyze" as const }), contextOf()));
    const previewed = await failure(() =>
      previewCall(freezeData({ operation: "load" as const, path: ["c"] }), contextOf()),
    );

    expect(ran).toBe(ranThrown);
    expect(previewed).toBe(previewThrown);
  });

  test("a bridged tree call runs the provider's own member for each action with today's arguments, and answers its answer by reference", async () => {
    const containers = [{ path: ["app"], name: "app", level: 0 }];
    const counts = { table: { count: 2 } };
    const objects = [{ path: ["app", "orders"], name: "orders", kind: "table" }];
    const detail = { path: ["app", "orders"], columns: [], indexes: [], foreignKeys: [] };
    const batch = { details: [detail] };
    const provider = Object.assign(fake(resultOf([])), {
      listContainers: mock(async () => containers),
      countObjects: mock(async () => counts),
      listObjects: mock(async () => objects),
      describeObject: mock(async () => detail),
      describeObjects: mock(async () => batch),
    });
    const { session } = bridgedConsole(provider, {});
    const tree = session.tree as NonNullable<typeof session.tree>;
    const read = (request: TreeRequest) => tree(freezeData(request), contextOf());

    const below = await read({ action: "containers", parent: ["app"] });
    const top = await read({ action: "containers" });
    const counted = await read({ action: "count", container: ["app"] });
    const listed = await read({ action: "list", container: ["app"], kind: "table" });
    const described = await read({ action: "describe", path: ["app", "orders"], kind: "table" });
    const many = await read({ action: "describeMany", container: ["app"], kind: "table", limit: 3 });
    const manySql = await read({
      action: "describeMany",
      container: ["app"],
      kind: "table",
      limit: 3,
      defaultSql: true,
    });

    expect(callsOf(provider.listContainers)).toEqual([[["app"]], [undefined]]);
    expect(callsOf(provider.listContainers).map((args) => args.length)).toEqual([1, 1]);
    expect(callsOf(provider.countObjects)).toEqual([[["app"]]]);
    expect(callsOf(provider.countObjects)[0]).toHaveLength(1);
    expect(callsOf(provider.listObjects)).toEqual([[["app"], "table"]]);
    expect(callsOf(provider.listObjects)[0]).toHaveLength(2);
    expect(callsOf(provider.describeObject)).toEqual([[["app", "orders"], "table"]]);
    expect(callsOf(provider.describeObject)[0]).toHaveLength(2);
    expect(callsOf(provider.describeObjects)).toEqual([
      [["app"], "table", 3],
      [["app"], "table", 3, { defaultSql: true }],
    ]);
    expect(callsOf(provider.describeObjects).map((args) => args.length)).toEqual([3, 4]);
    expect((below as { containers: unknown }).containers).toBe(containers);
    expect((top as { containers: unknown }).containers).toBe(containers);
    expect((counted as { counts: unknown }).counts).toBe(counts);
    expect((listed as { objects: unknown }).objects).toBe(objects);
    expect((described as { detail: unknown }).detail).toBe(detail);
    expect(many).toBe(batch);
    expect(manySql).toBe(batch);
    expect(provider.query).not.toHaveBeenCalled();
    expect(provider.prepareQuery).not.toHaveBeenCalled();
  });

  test("a bridged tree call never calls forCatalog and passes no read allowance", async () => {
    const forCatalog = mock(async () => fake(resultOf([])));
    const provider = Object.assign(fake(resultOf([])), { forCatalog });
    const { session } = bridgedConsole(provider, {});
    const tree = session.tree as NonNullable<typeof session.tree>;

    await tree(freezeData({ action: "count", container: ["app"] }), contextOf());
    await tree(freezeData({ action: "list", container: ["app"], kind: "table" }), contextOf());
    await tree(freezeData({ action: "describeMany", container: ["app"], kind: "table", limit: 3 }), contextOf());

    expect(forCatalog).not.toHaveBeenCalled();
    // A read allowance would be the count's second argument, the listing's third or the batch's fourth.
    expect(callsOf(provider.countObjects)[0]).toHaveLength(1);
    expect(callsOf(provider.listObjects)[0]).toHaveLength(2);
    expect(callsOf(provider.describeObjects)[0]).toHaveLength(3);
  });

  test("a bridged tree call whose member throws passes the error by reference", async () => {
    const thrown = new Error(marker());
    const provider = Object.assign(fake(resultOf([])), {
      listObjects: mock(async () => {
        throw thrown;
      }),
    });
    const { session } = bridgedConsole(provider, {});
    const tree = session.tree as NonNullable<typeof session.tree>;

    const caught = await failure(() =>
      tree(freezeData({ action: "list", container: ["app"], kind: "table" }), contextOf()),
    );

    expect(caught).toBe(thrown);
  });

  test("a legacy tree member that writes the paths it receives changes nothing the host froze", async () => {
    const received: (readonly string[] | undefined)[] = [];
    const writes = (path: string[] | undefined) => {
      received.push(path);
      path?.push(marker());
      if (path !== undefined) path[0] = marker();
    };
    const provider = Object.assign(fake(resultOf([])), {
      listContainers: mock(async (parent?: string[]) => {
        writes(parent);
        return [];
      }),
      countObjects: mock(async (container: string[]) => {
        writes(container);
        return {};
      }),
      listObjects: mock(async (container: string[]) => {
        writes(container);
        return [];
      }),
      describeObject: mock(async (path: string[]) => {
        writes(path);
        return { path: [], columns: [], indexes: [], foreignKeys: [] };
      }),
      describeObjects: mock(async (container: string[]) => {
        writes(container);
        return { details: [] };
      }),
    });
    const { session } = bridgedConsole(provider, {});
    const tree = session.tree as NonNullable<typeof session.tree>;
    const requests: TreeRequest[] = [
      freezeData({ action: "containers", parent: ["app"] }),
      freezeData({ action: "count", container: ["app"] }),
      freezeData({ action: "list", container: ["app"], kind: "table" }),
      freezeData({ action: "describe", path: ["app", "orders"], kind: "table" }),
      freezeData({ action: "describeMany", container: ["app"], kind: "table" }),
    ];

    for (const request of requests) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time, so each member's received path is in order.
      await tree(request, contextOf());
    }

    expect(requests).toEqual([
      { action: "containers", parent: ["app"] },
      { action: "count", container: ["app"] },
      { action: "list", container: ["app"], kind: "table" },
      { action: "describe", path: ["app", "orders"], kind: "table" },
      { action: "describeMany", container: ["app"], kind: "table" },
    ]);
    expect(received).toHaveLength(5);
    expect(received[0]).not.toBe((requests[0] as TreeContainersRequest).parent);
    expect(received[1]).not.toBe((requests[1] as TreeCountRequest).container);
    expect(received[2]).not.toBe((requests[2] as TreeListRequest).container);
    expect(received[3]).not.toBe((requests[3] as TreeDescribeRequest).path);
    expect(received[4]).not.toBe((requests[4] as TreeDescribeManyRequest).container);
  });

  test("a bridged session offers the transaction facet exactly where the provider is a TransactionProvider", () => {
    const transactional = transactionalFake();
    const missingOne = fake(resultOf([]), {
      beginTransaction: mock(async () => {}),
      commitTransaction: mock(async () => {}),
      isInTransaction: mock(() => false),
    });

    const bridged = bridgedConsole(transactional.provider, {});
    expect(bridged.session.calls.console.transaction).toBe("offered");
    expect(typeof bridged.session.transaction).toBe("function");
    for (const provider of [missingOne, fake(resultOf([]))]) {
      const plain = bridgedConsole(provider, {});
      expect(plain.session.calls.console.transaction).toBe("not-offered");
      expect(Object.hasOwn(plain.session, "transaction")).toBe(false);
    }
    expect(isTransactionProvider(transactional.provider)).toBe(true);
    expect(isTransactionProvider(missingOne)).toBe(false);
    expect(isTransactionProvider(null)).toBe(false);
    expect(isTransactionProvider("provider")).toBe(false);
  });

  test("a bridged begin, COMMIT, ROLLBACK and state read call the provider's methods and answer its state after each", async () => {
    const fx = transactionalFake();
    const { session } = bridgedConsole(fx.provider, {});
    const transaction = session.transaction as NonNullable<typeof session.transaction>;

    const begin = await transaction({ action: "begin" }, contextOf());
    const state = await transaction({ action: "state" }, contextOf());
    const commit = await transaction({ action: "commit" }, contextOf());
    fx.open = true;
    const rollback = await transaction({ action: "rollback" }, contextOf());

    expect(begin).toEqual({ sessionState: "in-transaction" });
    expect(state).toEqual({ sessionState: "in-transaction" });
    expect(commit).toEqual({ sessionState: "not-in-transaction" });
    expect(rollback).toEqual({ sessionState: "not-in-transaction" });
    expect(callsOf(fx.provider.beginTransaction)).toHaveLength(1);
    expect(callsOf(fx.provider.commitTransaction)).toHaveLength(1);
    expect(callsOf(fx.provider.rollbackTransaction)).toHaveLength(1);
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(4);
    expect(callsOf(fx.provider.query)).toHaveLength(0);
    expect(callsOf(fx.provider.queryInTransaction)).toHaveLength(0);
  });

  test("a bridged begin hands the provider requireReportedState as the route always did, true only when asked", async () => {
    const reporting = transactionalFake({ stateReported: false });
    const silent = transactionalFake();
    const reportingTransaction = bridgedConsole(reporting.provider, {}).session.transaction as NonNullable<
      ConsoleSession["transaction"]
    >;
    const silentTransaction = bridgedConsole(silent.provider, {}).session.transaction as NonNullable<
      ConsoleSession["transaction"]
    >;

    const asked = await reportingTransaction({ action: "begin", requireReportedState: true }, contextOf());
    const plain = await silentTransaction({ action: "begin" }, contextOf());

    expect(callsOf(reporting.provider.beginTransaction)).toEqual([[{ requireReportedState: true }]]);
    expect(callsOf(silent.provider.beginTransaction)).toEqual([[{ requireReportedState: false }]]);
    expect(asked).toEqual({ sessionState: "in-transaction", stateReported: false });
    expect(plain).toEqual({ sessionState: "in-transaction" });
  });

  test("a bridged statement inside the transaction prepares, probes and runs queryInTransaction, with no run id, no scope and no ender, and answers the state after it", async () => {
    const endOpenQueryTransaction = mock(async () => "rolled-back");
    const fx = transactionalFake(undefined, { endOpenQueryTransaction, cancelQuery: mock(async () => true) });
    fx.open = true;
    fx.provider.queryInTransaction.mockImplementation(async () => {
      // The statement was a COMMIT the server ended the transaction with.
      fx.open = false;
      return resultOf(rowsOf(3));
    });
    const bridged = bridgedConsole(fx.provider, { limit: 2 });
    const value = marker();

    const answer = await bridged.session.execute(
      requestOf({ params: [value], runId: marker(), transaction: true }),
      contextOf(),
    );

    expect(callsOf(fx.provider.prepareQuery)).toEqual([
      ["SELECT n FROM t", { limit: 2 }],
      ["SELECT n FROM t", { limit: 3, unlimited: false }],
    ]);
    expect(callsOf(fx.provider.queryInTransaction)).toEqual([["SELECT n FROM t LIMIT 3 OFFSET 0", [value]]]);
    expect(callsOf(fx.provider.query)).toHaveLength(0);
    expect(callsOf(endOpenQueryTransaction)).toHaveLength(0);
    expect(answer.sessionState).toBe("not-in-transaction");
    expect(answer.pageApplied).toBe(true);
    expect(bridged.answered().result.rows).toEqual(rowsOf(3));
    expect(bridged.pumpLimits(answer).maxRows).toBe(3);

    const failing = new Error('syntax error at or near "LIMIT"');
    const thrower = transactionalFake();
    thrower.provider.queryInTransaction.mockImplementation(async () => {
      throw failing;
    });
    const caught = await failure(() =>
      bridgedConsole(thrower.provider, { limit: 2 }).session.execute(requestOf({ transaction: true }), contextOf()),
    );
    expect(caught).toBe(failing);
    expect(failing.message).toBe(`syntax error at or near "LIMIT" ${appendedBoundNote("LIMIT 3 OFFSET 0")}`);
    expect(callsOf(thrower.provider.queryInTransaction)[0]).toEqual(["SELECT n FROM t LIMIT 3 OFFSET 0", undefined]);

    // A provider that holds no transaction session is never sent a statement inside one: the host's check refuses it
    // before the call, so reaching the bridge with one is a defect of the host.
    const defect = await failure(() =>
      bridgedConsole(fake(resultOf([])), {}).session.execute(requestOf({ transaction: true }), contextOf()),
    );
    expect((defect as Error).message).toBe(
      "The bridge was sent a statement inside a transaction for a provider that holds no transaction session, a defect of the host.",
    );
  });

  test("a bridged transaction call whose provider throws passes the error by reference", async () => {
    const fx = transactionalFake();
    const thrown = new Error(marker());
    fx.provider.commitTransaction.mockImplementation(async () => {
      throw thrown;
    });
    const transaction = bridgedConsole(fx.provider, {}).session.transaction as NonNullable<
      ConsoleSession["transaction"]
    >;

    const caught = await failure(() => transaction({ action: "commit" }, contextOf()));

    expect(caught).toBe(thrown);
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(0);
  });

  test("a bridged session reads the provider's state on every call, and keeps none", async () => {
    const fx = transactionalFake();
    const transaction = bridgedConsole(fx.provider, {}).session.transaction as NonNullable<
      ConsoleSession["transaction"]
    >;

    fx.open = true;
    const first = await transaction({ action: "state" }, contextOf());
    // The provider ended the transaction on its own timer, with no call of the session behind it.
    fx.open = false;
    const second = await transaction({ action: "state" }, contextOf());

    expect([first, second]).toEqual([{ sessionState: "in-transaction" }, { sessionState: "not-in-transaction" }]);
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(2);
  });

  test("a legacy provider that writes what it receives changes nothing the host froze", async () => {
    const options: QueryPrepareOptions = { limit: 2 };
    const received: { options?: QueryPrepareOptions; params?: unknown[] } = {};
    const provider = fake(resultOf(rowsOf(1)), {
      prepareQuery: mock((sql: string, given: QueryPrepareOptions = {}) => {
        received.options ??= given;
        const prepared = limiter(sql, given);
        given.limit = 99;
        return prepared;
      }),
      query: mock(async (_sql: string, params?: unknown[]) => {
        received.params = params;
        params?.push(marker());
        return resultOf(rowsOf(1));
      }),
    });
    const value = marker();
    const request = requestOf({ params: [value], page: { limit: 5, offset: 0 } });

    await bridgedConsole(provider, options).session.execute(request, contextOf());

    expect(received.options).not.toBe(options);
    expect(received.options?.limit).toBe(99);
    expect(options).toEqual({ limit: 2 });
    expect(callsOf(provider.prepareQuery)[0]?.[1]).not.toBe(request.page);
    expect(received.params).toHaveLength(2);
    expect(received.params?.[0]).toBe(value);
    expect(request.params).toEqual([value]);
    expect(Object.isFrozen(request.params)).toBe(true);
  });

  test("the run prepares, probes and queries with the request's own scope, and ends nothing itself", async () => {
    const endOpenQueryTransaction = mock(async () => "rolled-back");
    const cancelQuery = mock(async () => true);
    const provider = fake(resultOf(rowsOf(3)), { endOpenQueryTransaction, cancelQuery });
    const bridged = bridgedConsole(provider, { limit: 2 });
    const scope = marker();

    const answer = await bridged.session.execute(requestOf({ params: ["a"], runId: "q-1", scope }), contextOf());

    expect(callsOf(provider.prepareQuery)).toEqual([
      ["SELECT n FROM t", { limit: 2 }],
      ["SELECT n FROM t", { limit: 3, unlimited: false }],
    ]);
    expect(callsOf(provider.query)).toEqual([["SELECT n FROM t LIMIT 3 OFFSET 0", ["a"], "q-1", scope]]);
    expect(callsOf(endOpenQueryTransaction)).toHaveLength(0);
    expect(bridged.run.prepared).toEqual({
      query: "SELECT n FROM t LIMIT 2 OFFSET 0",
      wasLimited: true,
      limit: 2,
      offset: 0,
    });
    expect(bridged.run.result?.rows).toEqual(rowsOf(3));
    expect(answer.pageApplied).toBe(true);
    expect(answer.executionTimeMs).toBe(3);

    const plain = fake(resultOf(rowsOf(1)));
    await bridgedConsole(plain, {}).session.execute(requestOf({ runId: "q-2" }), contextOf());
    // A request that carries no scope hands the provider none.
    expect(callsOf(plain.query)[0]?.slice(1)).toEqual([undefined, undefined, undefined]);

    const failing = new Error('syntax error at or near "LIMIT"');
    const ender = mock(async () => "rolled-back");
    const thrower = bridgedConsole(fake(failing, { endOpenQueryTransaction: ender }), { limit: 2 });
    const caught = await failure(() => thrower.session.execute(requestOf({ scope: marker() }), contextOf()));
    expect(caught).toBe(failing);
    expect(failing.message).toBe(`syntax error at or near "LIMIT" ${appendedBoundNote("LIMIT 3 OFFSET 0")}`);
    expect(callsOf(ender)).toHaveLength(0);
    expect(thrower.run.result).toBeUndefined();
  });

  test("a bridged endScope runs the provider's ender on the scope it is sent and answers its outcome, its failure by reference", async () => {
    const outcomes = ["rolled-back", "none"] as const;
    const endOpenQueryTransaction = mock(async () => outcomes[callsOf(endOpenQueryTransaction).length - 1]);
    const { session } = bridgedConsole(fake(resultOf([]), { endOpenQueryTransaction }), {});
    const first = marker();
    const second = marker();

    const rolledBack = await session.endScope?.({ scope: first }, contextOf());
    const none = await session.endScope?.({ scope: second }, contextOf());

    expect(rolledBack).toEqual({ openTransaction: "rolled-back" });
    expect(none).toEqual({ openTransaction: "none" });
    expect(callsOf(endOpenQueryTransaction)).toEqual([[first], [second]]);

    const failing = new Error(marker());
    const thrower = bridgedConsole(
      fake(resultOf([]), {
        endOpenQueryTransaction: mock(async () => {
          throw failing;
        }),
      }),
      {},
    );
    expect(await failure(async () => thrower.session.endScope?.({ scope: marker() }, contextOf()))).toBe(failing);
  });

  test("every result set is a source, the main rows first", async () => {
    const warning = { message: marker(), code: 42, severity: "NOTICE" };
    const plain = { message: marker() };
    const explainPlan = { plan: marker() };
    const provider = fake(
      resultOf([{ n: 1 }], {
        resultSets: [
          { rows: [{ n: 1 }], fields: ["n"] },
          { rows: [{ m: 2 }, { m: 3 }], fields: ["m"] },
        ],
        warnings: [warning, plain],
        explainPlan,
        pagination: { limit: 1, offset: 0, hasMore: false, totalReturned: 1, wasLimited: true },
      }),
    );

    const answer: ExecuteAnswer = await bridgedConsole(provider, {}).session.execute(
      requestOf({ statement: "SELECT n FROM t LIMIT 1" }),
      contextOf(),
    );

    expect(answer.results.map((source) => source.columns)).toEqual([[{ name: "n" }], [{ name: "m" }]]);
    expect(answer.results[0]?.rowCount).toBe(1);
    expect(Object.hasOwn(answer.results[1] as object, "rowCount")).toBe(false);
    const pages = await Promise.all(answer.results.map((source) => pumpPage(source, PAGE, contextOf())));
    expect(pages.map((page) => page.rows)).toEqual([[[1]], [[2], [3]]]);
    expect(answer.warnings).toEqual([warning, plain]);
    expect(answer.pageApplied).toBe(false);
    expect(answer.boundApplied).toBe(true);
    expect(answer.explainPlan).toBe(explainPlan);

    const single = await bridgedConsole(fake(resultOf([{ n: 1 }])), {}).session.execute(requestOf(), contextOf());
    expect(single.results).toHaveLength(1);
    expect(single.warnings).toEqual([]);
    expect(Object.hasOwn(single, "boundApplied")).toBe(false);
    expect(Object.hasOwn(single, "explainPlan")).toBe(false);
    const closed = single.results[0];
    await closed?.close();
    expect(
      await failure(async () => closed?.next({ maxRows: 1, maxBytes: 1, measure: encodedRowBytes })),
    ).toBeInstanceOf(Error);
  });

  test("a cell outside the value codec is measured in its JSON form and answered unchanged", async () => {
    class Point {
      constructor(readonly at: string) {}
      toJSON(): string {
        return this.at;
      }
    }
    const at = marker();
    const row = { a: undefined, b: new Point(at), c: new Map([[1, 2]]), d: 7 };
    const clean = { a: 1, b: "x", c: null, d: 7 };
    const provider = fake(resultOf([row, clean], { fields: ["a", "b", "c", "d"] }));
    const bridged = bridgedConsole(provider, {});

    const answer = await bridged.session.execute(requestOf({ statement: "SELECT * FROM t LIMIT 5" }), contextOf());
    const page = await pumpPage(answer.results[0] as never, PAGE, contextOf());

    expect(page.rows).toEqual([
      [null, at, {}, 7],
      [1, "x", null, 7],
    ]);
    expect(page.bytes).toBe(encodedRowBytes([null, at, {}, 7]) + encodedRowBytes([1, "x", null, 7]));
    expect(bridged.run.result?.rows[0]).toBe(row);
    expect(bridged.run.result?.rows[1]).toBe(clean);

    const { body } = await runEditorQuery(fake(resultOf([row, clean], { fields: ["a", "b", "c", "d"] })), {
      statement: "SELECT * FROM t LIMIT 5",
      options: {},
      signal: new AbortController().signal,
      route: "test",
      scrub: providerTextScrub({ id: "c", name: "c", type: "postgres", createdAt: new Date(0) }, "any"),
    });
    expect(JSON.stringify(body.rows)).toBe(JSON.stringify([row, clean]));
  });

  test("the bridge sizes every row it answers with the pull's measure, and answers that same array", async () => {
    const rows = Array.from({ length: 5 }, () => ({ n: marker() }));
    const answer = await bridgedConsole(fake(resultOf(rows)), {}).session.execute(requestOf(), contextOf());
    const inner = answer.results[0] as ResultSource;
    const measured: (readonly unknown[])[] = [];
    const recording: ResultSource = {
      columns: inner.columns,
      next: (limit) =>
        inner.next({
          maxRows: limit.maxRows,
          maxBytes: limit.maxBytes,
          measure: (row) => {
            measured.push(row);
            return limit.measure(row);
          },
        }),
      close: () => inner.close(),
    };

    // Each row is 40 bytes, so a 100-byte batch holds two and measures a third it does not answer.
    const page = await pumpPage(recording, { ...PAGE, batchMaxBytes: 100 }, contextOf());

    expect(page.end).toBe("done");
    expect(page.rows).toEqual(rows.map((row) => [row.n]));
    expect(page.bytes).toBe(rows.length * 40);
    expect(measured).toHaveLength(rows.length + 2);
    for (const row of page.rows) expect(measured.includes(row)).toBe(true);
  });

  test("a measuring error other than the codec's passes as the same object", async () => {
    const thrown = new Error(marker());
    const failing = {
      toJSON(): never {
        throw thrown;
      },
    };
    const provider = fake(resultOf([{ a: undefined, b: failing }], { fields: ["a", "b"] }));

    const answer = await bridgedConsole(provider, {}).session.execute(
      requestOf({ statement: "SELECT * FROM t LIMIT 5" }),
      contextOf(),
    );
    const caught = await failure(() => pumpPage(answer.results[0] as never, PAGE, contextOf()));

    expect(caught).toBe(thrown);
  });

  test("the page's row limit is the probe limit for a bound Studio wrote, and every returned row otherwise", async () => {
    const limited = bridgedConsole(fake(resultOf(rowsOf(3))), { limit: 2 });
    const unbound = bridgedConsole(fake(resultOf(rowsOf(7))), { limit: 2 });
    const empty = bridgedConsole(fake(resultOf([])), { limit: 2 });

    const limitedAnswer = await limited.session.execute(requestOf(), contextOf());
    const unboundAnswer = await unbound.session.execute(
      requestOf({ statement: "SELECT n FROM t LIMIT 9" }),
      contextOf(),
    );
    const emptyAnswer = await empty.session.execute(requestOf({ statement: "SELECT n FROM t LIMIT 9" }), contextOf());

    expect(limited.pumpLimits(limitedAnswer)).toEqual({
      maxRows: 3,
      maxBytes: PAGE_MAX_BYTES,
      batchMaxBytes: BATCH_MAX_BYTES,
    });
    expect(unbound.pumpLimits(unboundAnswer).maxRows).toBe(7);
    expect(empty.pumpLimits(emptyAnswer).maxRows).toBe(1);
    const early = bridgedConsole(fake(resultOf([])), {});
    expect(() => early.pumpLimits(emptyAnswer)).toThrow(
      "The bridge's run was read before its execute answered, a defect of the host.",
    );
    expect(() => early.answered()).toThrow(
      "The bridge's run was read before its execute answered, a defect of the host.",
    );
    const answered = limited.answered();
    expect(answered.prepared).toBe(limited.run.prepared as PreparedQuery);
    expect(answered.result).toBe(limited.run.result as QueryResult);
    expect(Object.keys(answered).sort()).toEqual(["prepared", "result"]);
  });

  test("a bridged cancel names the run and answers the provider's boolean", async () => {
    const cancelQuery = mock(async (id: string) => id === "known");
    const { session } = bridgedConsole(fake(resultOf([]), { cancelQuery }), {});

    const known = await session.cancel?.({ runId: "known" }, contextOf());
    const unknown = await session.cancel?.({ runId: marker() }, contextOf());

    expect(known).toEqual({ cancelled: true });
    expect(unknown).toEqual({ cancelled: false });
    expect(callsOf(cancelQuery)[0]).toEqual(["known"]);
  });
});

/** A PostgreSQL-shaped declaration in Studio's form: vacuum, analyze and reindex on a row and whole, kill on neither. */
const POSTGRES_DECLARED: Required<MaintenanceDeclaration> = {
  maintenanceOperations: ["vacuum", "analyze", "reindex", "kill"],
  maintenanceOperationSpecs: {
    vacuum: { label: "Vacuum", perEntity: true, global: true, description: "Reclaims space." },
    analyze: { label: "Analyze", perEntity: true, global: true },
    reindex: { label: "Reindex", perEntity: true, global: true, confirmation: "typed-target", kinds: ["table"] },
    kill: { label: "Terminate", perEntity: false, global: false },
  },
};

/** A provider whose connected capabilities hold `maintenance`, with `supportsMaintenance` as given. */
function connectedWith(maintenance: MaintenanceDeclaration, supportsMaintenance = true): DatabaseProvider {
  const provider = fake(resultOf([]));
  const capabilities = { ...provider.getCapabilities(), ...maintenance, supportsMaintenance } as ProviderCapabilities;
  return Object.assign(provider, { getCapabilities: () => capabilities });
}

/** Whether `value` and every object it holds are frozen. */
function deepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every((member) => deepFrozen(member));
}

/** Each spec of the PostgreSQL-shaped declaration in the declaration's form, as `buildMaintenanceSpecs` writes it. */
const POSTGRES_SPECS = {
  vacuum: {
    operation: "vacuum",
    label: "Vacuum",
    perEntity: true,
    global: true,
    title: null,
    description: "Reclaims space.",
    confirmation: null,
    preview: false,
    kinds: null,
  },
  analyze: {
    operation: "analyze",
    label: "Analyze",
    perEntity: true,
    global: true,
    title: null,
    description: null,
    confirmation: null,
    preview: false,
    kinds: null,
  },
  reindex: {
    operation: "reindex",
    label: "Reindex",
    perEntity: true,
    global: true,
    title: null,
    description: null,
    confirmation: "typed-target",
    preview: false,
    kinds: ["table"],
  },
  kill: {
    operation: "kill",
    label: "Terminate",
    perEntity: false,
    global: false,
    title: null,
    description: null,
    confirmation: null,
    preview: false,
    kinds: null,
  },
} as const;

describe("bridgedMaintenance", () => {
  test("a bridged session's maintenance is the provider's declaration, narrowed through sessionMaintenance by what the connected provider still accepts", () => {
    const unchanged = bridgedMaintenance(connectedWith(POSTGRES_DECLARED), POSTGRES_DECLARED);
    const cockroachLike = narrowMaintenance(POSTGRES_DECLARED, {
      vacuum: { perEntity: false, global: true },
      reindex: { perEntity: false, global: false },
    });
    const narrowed = bridgedMaintenance(connectedWith(cockroachLike), POSTGRES_DECLARED);
    const killWithdrawn = bridgedMaintenance(
      connectedWith({ ...POSTGRES_DECLARED, maintenanceOperations: ["vacuum", "analyze", "reindex"] }),
      POSTGRES_DECLARED,
    );
    const notSupported = bridgedMaintenance(connectedWith(POSTGRES_DECLARED, false), POSTGRES_DECLARED);

    expect(unchanged).toEqual({
      maintenance: ["vacuum", "analyze", "reindex", "kill"],
      maintenanceSpecs: [POSTGRES_SPECS.vacuum, POSTGRES_SPECS.analyze, POSTGRES_SPECS.reindex, POSTGRES_SPECS.kill],
    });
    expect(deepFrozen(unchanged)).toBe(true);
    expect(narrowed).toEqual({
      maintenance: ["vacuum", "analyze", "kill"],
      maintenanceSpecs: [{ ...POSTGRES_SPECS.vacuum, perEntity: false }, POSTGRES_SPECS.analyze, POSTGRES_SPECS.kill],
    });
    expect(deepFrozen(narrowed)).toBe(true);
    expect(killWithdrawn.maintenance).toEqual(["vacuum", "analyze", "reindex"]);
    expect(notSupported).toEqual({ maintenance: [], maintenanceSpecs: [] });
    expect(POSTGRES_DECLARED.maintenanceOperations).toEqual(["vacuum", "analyze", "reindex", "kill"]);
  });

  test("a bridged session's maintenance never offers more than the declaration", () => {
    const declared: Required<MaintenanceDeclaration> = {
      maintenanceOperations: ["vacuum", "kill"],
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum", perEntity: false, global: true },
        kill: { label: "Terminate", perEntity: false, global: false },
      },
    };
    const wider = connectedWith({
      maintenanceOperations: ["vacuum", "kill", "optimize"],
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum", perEntity: true, global: true },
        kill: { label: "Terminate", perEntity: true, global: true },
        optimize: { label: "Optimize", perEntity: true, global: true },
      },
    });

    const maintenance = bridgedMaintenance(wider, declared);

    expect(maintenance).toEqual({
      maintenance: ["vacuum", "kill"],
      maintenanceSpecs: [{ ...POSTGRES_SPECS.vacuum, description: null, perEntity: false }, POSTGRES_SPECS.kill],
    });
  });
});

describe("the one ender", () => {
  const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");

  /** Every tracked `.ts` and `.tsx` source of Studio and the VS Code extension outside the providers, repository-relative. */
  function trackedSources(): string[] {
    return execFileSync("git", ["ls-files", "--", "src", "vscode-extension/src"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((file) => /\.tsx?$/.test(file) && !file.startsWith("src/lib/db/providers/"));
  }

  test("only the legacy bridge calls a provider's endOpenQueryTransaction, so a run's open transaction ends through console.endScope alone", () => {
    const callers = trackedSources().filter((file) =>
      /\.endOpenQueryTransaction\s*\(/.test(readFileSync(path.join(ROOT, file), "utf8")),
    );

    expect(callers).toEqual(["src/lib/provider-host/legacy-bridge.ts"]);
  });
});
