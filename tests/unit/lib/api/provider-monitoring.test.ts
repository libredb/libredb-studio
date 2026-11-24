/**
 * The monitoring caller facade (src/lib/api/provider-monitoring.ts; docs/providers/CONTRACT.md, clause C-74): each
 * panel read of the monitoring dashboard and each pool statistics read is one host core monitoring call on the legacy
 * bridge's session, under a deadline of its own, the statement timeout plus ten seconds from that read's start, and the
 * caller's signal; the dashboard is the declared panels' one orchestration over those calls, and every answer is the
 * provider's own by reference.
 *
 * The real host core is installed for the file; a case that needs a record the real core would answer only at a real
 * deadline installs a core of its own around the real one and restores it. Every double signals when the call reaches
 * it, and no assertion follows a timer. `provider-monitoring-bounds.test.ts` holds a dashboard read whose panels never
 * answer, with a real deadline, in a bounded Node child.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, MonitoringPanelRequest } from "@libredb/provider-sdk/calls";
import { EXECUTE_SLACK_MS, executeDeadline } from "@/lib/api/editor-query";
import { monitoringOptionsRefusal, providerMonitoring } from "@/lib/api/provider-monitoring";
import { MONITORING_PANELS, type MonitoringPanel } from "@/lib/db/engine-facets/types";
import { errorOutcome } from "@/lib/db/error-record";
import { QueryCancelledError, StudioTimeoutRefusal, waitedSeconds } from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX } from "@/lib/provider-host/access";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { PanelRecord, PoolStatsRecord } from "@/lib/provider-host/core/monitoring";
import { forgetHostCore, HostCoreBootOrderError, hostCore, installHostCore } from "@/lib/provider-host/instance";
import type { DatabaseConnection } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const ROUTE = "provider-monitoring-test";
const marker = (): string => randomUUID();

const MEMBER = {
  overview: "getOverview",
  performance: "getPerformanceMetrics",
  slowQueries: "getSlowQueries",
  activeSessions: "getActiveSessions",
  tables: "getTableStats",
  indexes: "getIndexStats",
  storage: "getStorageStats",
} as const satisfies Record<MonitoringPanel, keyof DatabaseProvider>;

const MEMBERS = Object.values(MEMBER);

/** A mock PostgreSQL provider, which offers every panel, whose statement timeout is `queryTimeout`. */
function providerOf(queryTimeout?: number, extra: Record<string, unknown> = {}): DatabaseProvider {
  const provider = createMockProvider({
    config: { id: "c1", name: "Prod", type: "postgres", host: "db.internal", queryTimeout } as DatabaseConnection,
  });
  return Object.assign(provider, extra);
}

/** The mock behind a provider's member, for its recorded calls and its implementation. */
const mockOf = (fn: unknown) => fn as ReturnType<typeof mock>;

/** Every panel member of `provider` answers what `answer` gives, resolving `reached` when the last one is called. */
function everyMember(provider: DatabaseProvider, answer: () => Promise<unknown>) {
  let calls = 0;
  const reached = Promise.withResolvers<void>();
  for (const member of MEMBERS) {
    mockOf(provider[member]).mockImplementation(() => {
      calls += 1;
      if (calls === MEMBERS.length) reached.resolve();
      return answer();
    });
  }
  return reached.promise;
}

/** Runs `body` with `core` installed in place of the real one, then puts the real one back. */
async function withCore<T>(make: (real: HostCore) => HostCore, body: () => Promise<T>): Promise<T> {
  const real = hostCore();
  forgetHostCore();
  installHostCore(make(real), "test");
  try {
    return await body();
  } finally {
    forgetHostCore();
    installHostCore(real, "test");
  }
}

/** What `run` threw; a run that does not throw fails the case. */
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("The call was expected to fail, and it answered.");
}

const TIMEOUT_REASON = () => new DOMException("The call's deadline has passed.", "TimeoutError");

/** The deadline sentence of a panel read or the pool statistics read on a provider whose timeout is `queryTimeout`. */
const deadlineSentence = (read: "A monitoring panel read" | "The pool statistics read", queryTimeout: number) =>
  `${read} did not answer within the statement timeout of ${waitedSeconds(queryTimeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`;

const pooled = () => ({ getPoolStats: mock(() => ({ total: 4, idle: 1, active: 3, waiting: 0 })) });

describe("providerMonitoring", () => {
  test("each panel read and each pool statistics read is one host core call with a fresh request, on a deadline of the statement timeout plus ten seconds from its own start", async () => {
    const provider = providerOf(2_000, pooled());
    const panels: { request: MonitoringPanelRequest; ctx: CallContext }[] = [];
    const pools: CallContext[] = [];
    const starts: number[] = [];
    // A clock the test steps, seven milliseconds further on each call, so each read's start is its own.
    const steppedClock = () => {
      const at = Date.now() + starts.length * 7;
      starts.push(at);
      return at;
    };
    await withCore(
      (real) => ({
        ...real,
        panelCall: (session, request, ctx, ports) => {
          panels.push({ request, ctx });
          return real.panelCall(session, request, ctx, ports);
        },
        poolStatsCall: (session, ctx, ports) => {
          pools.push(ctx);
          return real.poolStatsCall(session, ctx, ports);
        },
      }),
      async () => {
        const monitoring = providerMonitoring(provider, new AbortController().signal, ROUTE, steppedClock);
        await monitoring.readDashboard({ includeStorage: false, slowQueryLimit: 3 });
        await monitoring.readPoolStats();
      },
    );

    expect(panels.map(({ request }) => request)).toEqual([
      { panel: "overview" },
      { panel: "performance" },
      { panel: "slowQueries", limit: 3 },
      { panel: "activeSessions", limit: 50 },
      { panel: "tables" },
      { panel: "indexes" },
    ]);
    expect(new Set(panels.map(({ request }) => request)).size).toBe(6);
    expect(new Set(panels.map(({ ctx }) => ctx)).size).toBe(6);
    const deadlines = [...panels.map(({ ctx }) => ctx.deadline), ...pools.map((ctx) => ctx.deadline)];
    expect(deadlines).toEqual(starts.map((start) => executeDeadline(provider, start)));
    expect(new Set(starts).size).toBe(7);
    expect(executeDeadline(provider, starts[0] as number)).toBe((starts[0] as number) + 2_000 + EXECUTE_SLACK_MS);
    expect(mockOf(provider.getStorageStats)).not.toHaveBeenCalled();
    expect(mockOf(provider.getSlowQueries).mock.calls).toEqual([[{ limit: 3 }]]);
  });

  test("a dashboard read answers each panel's own answer by reference in the orchestration's four states, and a pool statistics read the provider's own", async () => {
    const stats = { total: 4, idle: 1, active: 3, waiting: 0, max: 10 };
    const provider = providerOf(undefined, { getPoolStats: mock(() => stats) });
    const answers = Object.fromEntries(MEMBERS.map((member) => [member, [{ marker: marker() }]]));
    for (const member of MEMBERS) mockOf(provider[member]).mockImplementation(async () => answers[member]);
    const failed = new Error(marker());
    mockOf(provider.getActiveSessions).mockImplementation(async () => {
      throw failed;
    });
    const monitoring = providerMonitoring(provider, new AbortController().signal, ROUTE);

    const data = await monitoring.readDashboard({ includeIndexes: false });
    const cassandra = await providerMonitoring(
      createMockProvider({ type: "cassandra" }),
      new AbortController().signal,
      ROUTE,
    ).readDashboard({});

    for (const panel of ["overview", "performance", "slowQueries", "tables", "storage"] as const) {
      expect(data[panel]).toBe(answers[MEMBER[panel]] as never);
    }
    expect(data.activeSessions).toBeUndefined();
    expect(data.indexes).toBeUndefined();
    expect(data.errors).toEqual({ activeSessions: failed.message });
    expect(data.notOffered).toEqual([]);
    expect(data.timestamp).toBeInstanceOf(Date);
    expect(cassandra.notOffered).toHaveLength(4);
    expect(await monitoring.readPoolStats()).toBe(stats);
    expect(monitoring.poolStatsOffered).toBe(true);
    expect(providerMonitoring(providerOf(), new AbortController().signal, ROUTE).poolStatsOffered).toBe(false);
  });

  test("an error the provider raises reaches the caller as the same object, and several sentences answer the engine's mapping of them", async () => {
    const thrown = new Error(marker());
    const one = providerOf(undefined, {
      getPoolStats: mock(() => {
        throw thrown;
      }),
    });
    void everyMember(one, async () => {
      throw thrown;
    });
    const monitoring = providerMonitoring(one, new AbortController().signal, ROUTE);
    expect(await failure(() => monitoring.readPoolStats())).toBe(thrown);
    expect(await failure(() => monitoring.readDashboard({}))).toBe(thrown);

    const several = providerOf();
    const sentences = MONITORING_PANELS.map(() => `permission denied ${marker()}`);
    let at = 0;
    void everyMember(several, async () => {
      const sentence = sentences[at];
      at += 1;
      throw new Error(sentence);
    });
    const mapped = await failure(() =>
      providerMonitoring(several, new AbortController().signal, ROUTE).readDashboard({}),
    );
    const expected = mapDatabaseError(new Error(sentences.join("; ")), "postgres");
    expect((mapped as Error).constructor).toBe(expected.constructor);
    expect((mapped as Error).message).toBe(expected.message);
  });

  test("a caller that leaves while the reads are pending is answered a stop at once, QueryCancelledError outcome unknown, and each later failure is logged by kind and code, never its text", async () => {
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const secret = marker();
    try {
      const pending = Promise.withResolvers<never>();
      const provider = providerOf();
      const reached = everyMember(provider, () => pending.promise);
      const caller = new AbortController();
      const monitoring = providerMonitoring(provider, caller.signal, ROUTE);

      const reading = failure(() => monitoring.readDashboard({}));
      await reached;
      caller.abort(new DOMException("The request went away.", "AbortError"));
      const left = await reading;
      expect(left).toBeInstanceOf(QueryCancelledError);
      expect(errorOutcome(left)).toBe("unknown");
      pending.reject(new Error(secret));
      await pending.promise.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));

      expect(warned).toEqual(
        MONITORING_PANELS.map((panel) => [
          "A monitoring read Studio stopped waiting for failed afterwards",
          { route: ROUTE, facet: "panel", panel, kind: "internal", code: "INTERNAL_ERROR" },
        ]),
      );
      expect(JSON.stringify(warned)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("a pool statistics read whose caller leaves is answered a stop at once, and its later failure is logged by kind and code, never its text", async () => {
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const secret = marker();
    try {
      const pending = Promise.withResolvers<never>();
      const reached = Promise.withResolvers<void>();
      const provider = providerOf(undefined, {
        getPoolStats: mock(() => {
          reached.resolve();
          return pending.promise;
        }),
      });
      const caller = new AbortController();
      const reading = failure(() => providerMonitoring(provider, caller.signal, ROUTE).readPoolStats());
      await reached.promise;
      caller.abort(new DOMException("The request went away.", "AbortError"));
      const left = await reading;
      expect(left).toBeInstanceOf(QueryCancelledError);
      expect(errorOutcome(left)).toBe("unknown");
      pending.reject(new Error(secret));
      await pending.promise.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));

      expect(warned).toEqual([
        [
          "A monitoring read Studio stopped waiting for failed afterwards",
          { route: ROUTE, facet: "poolStats", kind: "internal", code: "INTERNAL_ERROR" },
        ],
      ]);
      expect(JSON.stringify(warned)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("a caller already gone sends nothing and is answered not-sent", async () => {
    const provider = providerOf(undefined, pooled());
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));
    const monitoring = providerMonitoring(provider, caller.signal, ROUTE);

    const dashboard = await failure(() => monitoring.readDashboard({}));
    const pool = await failure(() => monitoring.readPoolStats());

    for (const error of [dashboard, pool]) {
      expect(error).toBeInstanceOf(QueryCancelledError);
      expect(errorOutcome(error)).toBe("not-sent");
    }
    for (const member of [...MEMBERS, "getPoolStats" as const]) {
      expect(mockOf((provider as unknown as Record<string, unknown>)[member])).not.toHaveBeenCalled();
    }
  });

  test("a monitoring read past its deadline answers StudioTimeoutRefusal naming the panel read or the pool statistics read, the statement timeout and the slack", async () => {
    const queryTimeout = 2_000;
    const provider = providerOf(queryTimeout, pooled());
    const behind = () => Date.now() - queryTimeout - EXECUTE_SLACK_MS - 1_000;
    const late = providerMonitoring(provider, new AbortController().signal, ROUTE, behind);
    const refusedDashboard = await failure(() => late.readDashboard({}));
    const refusedPool = await failure(() => late.readPoolStats());
    const stopped = await withCore(
      (real) => ({
        ...real,
        panelCall: async (): Promise<PanelRecord> => ({
          kind: "stopped",
          reason: TIMEOUT_REASON(),
          settled: Promise.resolve(),
        }),
        poolStatsCall: async (): Promise<PoolStatsRecord> => ({
          kind: "stopped",
          reason: TIMEOUT_REASON(),
          settled: Promise.resolve(),
        }),
      }),
      async () => {
        const monitoring = providerMonitoring(provider, new AbortController().signal, ROUTE);
        return [await failure(() => monitoring.readDashboard({})), await failure(() => monitoring.readPoolStats())];
      },
    );

    for (const [error, read, outcome] of [
      [refusedDashboard, "A monitoring panel read", "not-sent"],
      [refusedPool, "The pool statistics read", "not-sent"],
      [stopped[0], "A monitoring panel read", "unknown"],
      [stopped[1], "The pool statistics read", "unknown"],
    ] as const) {
      expect(error).toBeInstanceOf(StudioTimeoutRefusal);
      expect((error as Error).message).toBe(deadlineSentence(read, queryTimeout));
      expect(errorOutcome(error)).toBe(outcome);
    }
    for (const member of [...MEMBERS, "getPoolStats" as const]) {
      expect(mockOf((provider as unknown as Record<string, unknown>)[member])).not.toHaveBeenCalled();
    }
  });

  test("a monitoring read refused for any other reason is answered as a defect of Studio's bridge, named by its rule", async () => {
    const provider = providerOf(undefined, pooled());
    const caught = await withCore(
      (real) => ({
        ...real,
        panelCall: async (): Promise<PanelRecord> => ({
          kind: "refused",
          called: false,
          refusals: [{ rule: "request-panel-not-offered", pointer: "/panel" }],
        }),
        poolStatsCall: async (): Promise<PoolStatsRecord> => ({
          kind: "refused",
          called: false,
          refusals: [{ rule: "facet-not-offered", pointer: "/monitoring/poolStats", name: "monitoring.poolStats" }],
        }),
      }),
      async () => {
        const monitoring = providerMonitoring(provider, new AbortController().signal, ROUTE);
        return [await failure(() => monitoring.readDashboard({})), await failure(() => monitoring.readPoolStats())];
      },
    );

    for (const error of caught) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(QueryCancelledError);
      expect(error).not.toBeInstanceOf(StudioTimeoutRefusal);
      expect((error as Error).message.startsWith(HOST_DEFECT_PREFIX)).toBe(true);
    }
    expect((caught[0] as Error).message).toContain('"/panel"');
    expect((caught[1] as Error).message).toContain("monitoring.poolStats");
  });

  test("a monitoring read before the host core is installed fails by name and reaches no provider", async () => {
    const provider = providerOf(undefined, pooled());
    const real = hostCore();
    forgetHostCore();
    let caught: unknown[];
    try {
      const monitoring = providerMonitoring(provider, new AbortController().signal, ROUTE);
      caught = [await failure(() => monitoring.readDashboard({})), await failure(() => monitoring.readPoolStats())];
    } finally {
      installHostCore(real, "test");
    }

    for (const error of caught) expect(error).toBeInstanceOf(HostCoreBootOrderError);
    for (const member of [...MEMBERS, "getPoolStats" as const]) {
      expect(mockOf((provider as unknown as Record<string, unknown>)[member])).not.toHaveBeenCalled();
    }
  });
});

describe("monitoringOptionsRefusal", () => {
  test("the monitoring options are refused by name when a limit is not a whole number of at least 1 or the schema is not text that names one", () => {
    const schema = marker();
    expect(monitoringOptionsRefusal({})).toBeUndefined();
    expect(
      monitoringOptionsRefusal({ slowQueryLimit: 1, sessionLimit: 9007199254740991, schemaFilter: schema }),
    ).toBeUndefined();
    expect(
      monitoringOptionsRefusal({ includeTables: false, includeIndexes: true, includeStorage: false }),
    ).toBeUndefined();

    const limit = (name: string) => `options.${name} must be a whole number of at least 1`;
    const schemaSentence = "options.schemaFilter must name a schema, as text that is not empty";
    const badLimits: readonly unknown[] = [0, -1, 1.5, "10", Number.NaN, Number.POSITIVE_INFINITY, 1e300, true, null];
    for (const bad of badLimits) {
      expect(monitoringOptionsRefusal({ slowQueryLimit: bad })).toBe(limit("slowQueryLimit"));
      expect(monitoringOptionsRefusal({ sessionLimit: bad })).toBe(limit("sessionLimit"));
    }
    for (const bad of ["", 7, null, []] as const) {
      expect(monitoringOptionsRefusal({ schemaFilter: bad })).toBe(schemaSentence);
    }
    expect(monitoringOptionsRefusal({ schemaFilter: "", sessionLimit: 0, slowQueryLimit: 0 })).toBe(
      limit("slowQueryLimit"),
    );
    expect(monitoringOptionsRefusal({ schemaFilter: "", sessionLimit: 0 })).toBe(limit("sessionLimit"));
    const secret = marker();
    expect(monitoringOptionsRefusal({ schemaFilter: [secret] })).not.toContain(secret);
  });
});
