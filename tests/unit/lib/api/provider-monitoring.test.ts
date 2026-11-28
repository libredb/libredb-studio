/**
 * The monitoring caller facade (src/lib/api/provider-monitoring.ts; docs/providers/CONTRACT.md, clause C-74): each
 * panel read of the monitoring dashboard and each pool statistics read is one host core monitoring call on the session
 * of the target its caller hands it, a legacy provider's bridged session (`providerMonitoringTarget` in
 * src/lib/api/session-target.ts) or a provider package's, under a deadline of its own, the statement timeout plus ten
 * seconds from that read's start, and the caller's signal; the dashboard is the declared panels' one orchestration over
 * those calls, and every answer is the provider's own by reference.
 *
 * The real host core is installed for the file; a case that needs a record the real core would answer only at a real
 * deadline installs a core of its own around the real one and restores it. Every double signals when the call reaches
 * it, and no assertion follows a timer. `provider-monitoring-bounds.test.ts` holds a dashboard read whose panels never
 * answer, with a real deadline, in a bounded Node child, and a granted panel read and a granted health read the same.
 *
 * The granted reads, the agent's curated readings' facade (clause C-76), run under a deadline the caller was granted
 * and no signal of the caller's own; their cases build each grant here.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ANSWER_LIST_MAX,
  type CallContext,
  type HealthInfo,
  type MonitoringPanelRequest,
} from "@libredb/provider-sdk/calls";
import { contextOn, EXECUTE_SLACK_MS, executeDeadline } from "@/lib/api/editor-query";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import {
  type GrantedRead,
  monitoringOptionsRefusal,
  providerMonitoring,
  readGrantedHealth,
  readGrantedPanel,
  readSessionHealthWithin,
} from "@/lib/api/provider-monitoring";
import { type MonitoringTarget, providerMonitoringTarget } from "@/lib/api/session-target";
import { engineFacetsFor } from "@/lib/db/engine-facets";
import { MONITORING_PANELS, type MonitoringPanel } from "@/lib/db/engine-facets/types";
import { errorCode, errorOutcome } from "@/lib/db/error-record";
import { FacetNotOfferedError, QueryCancelledError, StudioTimeoutRefusal, waitedSeconds } from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { type EngineRecord, servedEngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX } from "@/lib/provider-host/access";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { HealthRecord, PanelRecord, PoolStatsRecord } from "@/lib/provider-host/core/monitoring";
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

/**
 * The monitoring facade of `provider` as a legacy route builds it: its bridged target, its engine's legacy record and
 * core's scrub of its connection.
 */
function monitoringOf(provider: DatabaseProvider, caller: AbortSignal, route: string, clock?: () => number) {
  return providerMonitoring(
    providerMonitoringTarget(provider),
    servedEngineRecord(provider.type),
    providerTextScrub(provider.config, "any"),
    caller,
    route,
    clock,
  );
}

/** Test Connection's health read of `provider`'s bridged session within the wait of `deadline` and `signal`. */
function healthWithin(provider: DatabaseProvider, deadline: number, signal: AbortSignal, route: string) {
  return readSessionHealthWithin(
    hostCore(),
    providerMonitoringTarget(provider).session,
    contextOn(deadline, signal),
    route,
  );
}

/** An overview panel's figures, of the SDK's `DatabaseOverview`, its text generated at run time. */
function overviewOf(): Record<string, unknown> {
  return {
    version: marker(),
    uptime: marker(),
    maxConnections: 0,
    databaseSize: marker(),
    tableCount: 0,
    indexCount: 0,
  };
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
const deadlineSentence = (
  read: "A monitoring panel read" | "The pool statistics read" | "The health read",
  queryTimeout: number,
) =>
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
        const monitoring = monitoringOf(provider, new AbortController().signal, ROUTE, steppedClock);
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
    // Each member's answer of its panel's form, a fresh object each, so each is told apart by reference.
    const answers: Record<string, unknown> = {
      ...Object.fromEntries(MEMBERS.map((member) => [member, []])),
      getOverview: overviewOf(),
      getPerformanceMetrics: { cacheHitAdvice: marker() },
    };
    for (const member of MEMBERS) mockOf(provider[member]).mockImplementation(async () => answers[member]);
    const failed = new Error(marker());
    mockOf(provider.getActiveSessions).mockImplementation(async () => {
      throw failed;
    });
    const monitoring = monitoringOf(provider, new AbortController().signal, ROUTE);

    const data = await monitoring.readDashboard({ includeIndexes: false });
    const cassandra = await monitoringOf(
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
    expect(monitoringOf(providerOf(), new AbortController().signal, ROUTE).poolStatsOffered).toBe(false);
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
    const monitoring = monitoringOf(one, new AbortController().signal, ROUTE);
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
    const mapped = await failure(() => monitoringOf(several, new AbortController().signal, ROUTE).readDashboard({}));
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
      const monitoring = monitoringOf(provider, caller.signal, ROUTE);

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
      const reading = failure(() => monitoringOf(provider, caller.signal, ROUTE).readPoolStats());
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
    const monitoring = monitoringOf(provider, caller.signal, ROUTE);

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
    const late = monitoringOf(provider, new AbortController().signal, ROUTE, behind);
    const refusedDashboard = await failure(() => late.readDashboard({}));
    const refusedPool = await failure(() => late.readPoolStats());
    const refusedOverview = await failure(() => late.readOverview());
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
        const monitoring = monitoringOf(provider, new AbortController().signal, ROUTE);
        return [
          await failure(() => monitoring.readDashboard({})),
          await failure(() => monitoring.readPoolStats()),
          await failure(() => monitoring.readOverview()),
        ];
      },
    );

    for (const [error, read, outcome] of [
      [refusedDashboard, "A monitoring panel read", "not-sent"],
      [refusedPool, "The pool statistics read", "not-sent"],
      [refusedOverview, "A monitoring panel read", "not-sent"],
      [stopped[0], "A monitoring panel read", "unknown"],
      [stopped[1], "The pool statistics read", "unknown"],
      [stopped[2], "A monitoring panel read", "unknown"],
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
          // A rule none of the accessor's rows for a refusing package session reads (clause C-111).
          refusals: [{ rule: "request-field-empty", pointer: "/monitoring/poolStats", name: "monitoring.poolStats" }],
        }),
      }),
      async () => {
        const monitoring = monitoringOf(provider, new AbortController().signal, ROUTE);
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
      const monitoring = monitoringOf(provider, new AbortController().signal, ROUTE);
      caught = [
        await failure(() => monitoring.readDashboard({})),
        await failure(() => monitoring.readPoolStats()),
        await failure(() => monitoring.readHealth()),
        await failure(() => monitoring.readOverview()),
        await failure(() => healthWithin(provider, Date.now() + 60_000, new AbortController().signal, ROUTE)),
      ];
    } finally {
      installHostCore(real, "test");
    }

    expect(caught).toHaveLength(5);
    for (const error of caught) expect(error).toBeInstanceOf(HostCoreBootOrderError);
    for (const member of [...MEMBERS, "getPoolStats" as const, "getHealth" as const]) {
      expect(mockOf((provider as unknown as Record<string, unknown>)[member])).not.toHaveBeenCalled();
    }
  });
});

/** A health answer of the test's own, its size drawn at run time. */
function healthOf(): HealthInfo {
  return { activeConnections: 2, databaseSize: marker(), cacheHitRatio: "1", slowQueries: [], activeSessions: [] };
}

/** `provider`'s getHealth answers what `answer` gives, resolving the answered promise when it is called. */
function healthMember(provider: DatabaseProvider, answer: () => Promise<unknown>): Promise<void> {
  const reached = Promise.withResolvers<void>();
  mockOf(provider.getHealth).mockImplementation(() => {
    reached.resolve();
    return answer();
  });
  return reached.promise;
}

/** The warnings logged while `body` runs, `logger.warn` restored afterwards. */
async function warningsOf(body: () => Promise<void>): Promise<unknown[][]> {
  const warned: unknown[][] = [];
  const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
    warned.push(args);
  });
  try {
    await body();
  } finally {
    warn.mockRestore();
  }
  return warned;
}

/** The late log line of a health read whose failure arrived after the wait ended. */
const HEALTH_LATE = [
  "A monitoring read Studio stopped waiting for failed afterwards",
  { route: ROUTE, facet: "health", kind: "internal", code: "INTERNAL_ERROR" },
];

describe("the health and overview reads", () => {
  test("a health read is one host core health call on a deadline of the statement timeout plus ten seconds from its own start and the caller's signal, answering the provider's own health by reference", async () => {
    const provider = providerOf(2_000);
    const health = healthOf();
    void healthMember(provider, async () => health);
    const contexts: CallContext[] = [];
    const starts: number[] = [];
    const steppedClock = () => {
      const at = Date.now() + 7 + starts.length * 7;
      starts.push(at);
      return at;
    };
    const caller = new AbortController();
    const answered = await withCore(
      (real) => ({
        ...real,
        healthCall: (session, ctx, ports) => {
          contexts.push(ctx);
          return real.healthCall(session, ctx, ports);
        },
      }),
      () => monitoringOf(provider, caller.signal, ROUTE, steppedClock).readHealth(),
    );

    expect(answered).toBe(health);
    expect(mockOf(provider.getHealth).mock.calls).toEqual([[]]);
    expect(contexts).toHaveLength(1);
    expect(starts).toHaveLength(1);
    expect(contexts[0]?.deadline).toBe((starts[0] as number) + 2_000 + EXECUTE_SLACK_MS);
    expect(contexts[0]?.signal.aborted).toBe(false);
    caller.abort(new DOMException("The request went away.", "AbortError"));
    expect(contexts[0]?.signal.aborted).toBe(true);
  });

  test("a health read's provider error reaches the caller as the same object", async () => {
    const provider = providerOf();
    const thrown = new Error(marker());
    void healthMember(provider, async () => {
      throw thrown;
    });

    expect(await failure(() => monitoringOf(provider, new AbortController().signal, ROUTE).readHealth())).toBe(thrown);
  });

  test("a health read whose caller leaves is answered a stop at once, QueryCancelledError outcome unknown, and its later failure is logged by kind and code, never its text", async () => {
    const secret = marker();
    const warned = await warningsOf(async () => {
      const pending = Promise.withResolvers<never>();
      const provider = providerOf();
      const reached = healthMember(provider, () => pending.promise);
      const caller = new AbortController();
      const reading = failure(() => monitoringOf(provider, caller.signal, ROUTE).readHealth());
      await reached;
      caller.abort(new DOMException("The request went away.", "AbortError"));
      const left = await reading;
      expect(left).toBeInstanceOf(QueryCancelledError);
      expect(errorOutcome(left)).toBe("unknown");
      pending.reject(new Error(secret));
      await pending.promise.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(warned).toEqual([HEALTH_LATE]);
    expect(JSON.stringify(warned)).not.toContain(secret);
  });

  test("a health read whose caller is already gone sends nothing and is answered not-sent", async () => {
    const provider = providerOf();
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));

    const gone = await failure(() => monitoringOf(provider, caller.signal, ROUTE).readHealth());

    expect(gone).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(gone)).toBe("not-sent");
    expect(mockOf(provider.getHealth)).not.toHaveBeenCalled();
  });

  test("a health read past its deadline answers StudioTimeoutRefusal naming the health read, the statement timeout and the slack", async () => {
    const provider = providerOf();
    const stopped = await withCore(
      (real) => ({
        ...real,
        healthCall: async (): Promise<HealthRecord> => ({
          kind: "stopped",
          reason: TIMEOUT_REASON(),
          settled: Promise.resolve(),
        }),
      }),
      () => failure(() => monitoringOf(provider, new AbortController().signal, ROUTE).readHealth()),
    );
    const behind = () => Date.now() - 60_000 - EXECUTE_SLACK_MS - 1_000;
    const refused = await failure(() =>
      monitoringOf(provider, new AbortController().signal, ROUTE, behind).readHealth(),
    );

    expect(refused).toBeInstanceOf(StudioTimeoutRefusal);
    expect((refused as Error).message).toBe(deadlineSentence("The health read", 60_000));
    expect(errorOutcome(refused)).toBe("not-sent");
    expect(stopped).toBeInstanceOf(StudioTimeoutRefusal);
    expect((stopped as Error).message).toBe(
      "The health read did not answer within the statement timeout of 60 seconds and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
    );
    expect((stopped as Error).message).toBe(deadlineSentence("The health read", 60_000));
    expect(errorOutcome(stopped)).toBe("unknown");
    expect(mockOf(provider.getHealth)).not.toHaveBeenCalled();
  });

  test("an overview read is one host core panel call where the engine offers the overview, answering its figures by reference, and reads nothing where it does not", async () => {
    const provider = providerOf(2_000);
    const overview = overviewOf();
    mockOf(provider.getOverview).mockImplementation(async () => overview);
    const s3 = createMockProvider({ type: "s3" });
    const panels: { request: MonitoringPanelRequest; ctx: CallContext }[] = [];
    const starts: number[] = [];
    const steppedClock = () => {
      const at = Date.now() + 7 + starts.length * 7;
      starts.push(at);
      return at;
    };
    const caller = new AbortController();
    const [answered, none] = await withCore(
      (real) => ({
        ...real,
        panelCall: (session, request, ctx, ports) => {
          panels.push({ request, ctx });
          return real.panelCall(session, request, ctx, ports);
        },
      }),
      async () => [
        await monitoringOf(provider, caller.signal, ROUTE, steppedClock).readOverview(),
        await monitoringOf(s3, caller.signal, ROUTE, steppedClock).readOverview(),
      ],
    );

    expect(answered).toBe(overview as never);
    expect(none).toBeUndefined();
    expect(panels.map(({ request }) => request)).toEqual([{ panel: "overview" }]);
    expect(panels[0]?.ctx.deadline).toBe((starts[0] as number) + 2_000 + EXECUTE_SLACK_MS);
    expect(starts).toHaveLength(1);
    expect(mockOf(provider.getOverview).mock.calls).toEqual([[]]);
    expect(mockOf(s3.getOverview)).not.toHaveBeenCalled();
    caller.abort(new DOMException("The request went away.", "AbortError"));
    expect(panels[0]?.ctx.signal.aborted).toBe(true);
  });

  test("an overview answer whose form is not the overview panel's fails by name", async () => {
    const provider = providerOf();
    const wrong = await withCore(
      (real) => ({
        ...real,
        panelCall: async (): Promise<PanelRecord> => ({
          kind: "answered",
          answer: { performance: { marker: marker() } } as never,
        }),
      }),
      () => failure(() => monitoringOf(provider, new AbortController().signal, ROUTE).readOverview()),
    );

    expect((wrong as Error).constructor).toBe(Error);
    expect((wrong as Error).message).toBe(
      "The overview panel read answered a form other than the overview panel's, which is a defect of the session that answered it.",
    );
  });
});

describe("readSessionHealthWithin", () => {
  test("a health read within a wait the caller holds runs on that deadline and that signal itself, and answers the provider's health by reference", async () => {
    const provider = providerOf();
    const health = healthOf();
    void healthMember(provider, async () => health);
    const contexts: CallContext[] = [];
    const deadline = Date.now() + 5_000 + 7;
    const signal = new AbortController().signal;
    const within = await withCore(
      (real) => ({
        ...real,
        healthCall: (session, ctx, ports) => {
          contexts.push(ctx);
          return real.healthCall(session, ctx, ports);
        },
      }),
      () => healthWithin(provider, deadline, signal, ROUTE),
    );

    expect(within).toEqual({ kind: "answered", health });
    expect(within.kind === "answered" && within.health).toBe(health);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.deadline).toBe(deadline);
    expect(contexts[0]?.signal).toBe(signal);
    expect(mockOf(provider.getHealth).mock.calls).toEqual([[]]);
  });

  test("a health read within a wait that ended answers that it ended, before the call or while it was pending, and a later failure is logged by kind and code", async () => {
    const secret = marker();
    const before = providerOf();
    const pendingProvider = providerOf();
    const warned = await warningsOf(async () => {
      const ended = new AbortController();
      ended.abort(new DOMException("The test's deadline has passed.", "TimeoutError"));
      expect(await healthWithin(before, Date.now() + 60_000, ended.signal, ROUTE)).toEqual({ kind: "ended" });

      const pending = Promise.withResolvers<never>();
      const reached = healthMember(pendingProvider, () => pending.promise);
      const wait = new AbortController();
      const reading = healthWithin(pendingProvider, Date.now() + 60_000, wait.signal, ROUTE);
      await reached;
      wait.abort(new DOMException("The test's deadline has passed.", "TimeoutError"));
      expect(await reading).toEqual({ kind: "ended" });
      pending.reject(new Error(secret));
      await pending.promise.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(mockOf(before.getHealth)).not.toHaveBeenCalled();
    expect(mockOf(pendingProvider.getHealth).mock.calls).toEqual([[]]);
    expect(warned).toEqual([HEALTH_LATE]);
    expect(JSON.stringify(warned)).not.toContain(secret);
  });

  test("a health read within a wait passes the provider's error as the same object", async () => {
    const provider = providerOf();
    const thrown = new Error(marker());
    void healthMember(provider, async () => {
      throw thrown;
    });

    expect(await failure(() => healthWithin(provider, Date.now() + 60_000, new AbortController().signal, ROUTE))).toBe(
      thrown,
    );
  });
});

/** A grant of `deadline`, its sentence drawn at run time, and a hold that records what it is handed. */
function grantOf(deadline: number): GrantedRead & { readonly held: Promise<unknown>[] } {
  const held: Promise<unknown>[] = [];
  return {
    deadline,
    deadlineSentence: `The reading did not answer within ${marker()}.`,
    route: ROUTE,
    holdUntilSettled: (settled) => {
      held.push(settled);
    },
    held,
  };
}

/** A grant a minute ahead. */
const minuteGrant = () => grantOf(Date.now() + 60_000);

describe("granted reads", () => {
  test("a granted panel read answers the panel's member through one host core panel call, on a fresh request and a context of deadline, signal and env alone", async () => {
    const provider = providerOf();
    const tables = [
      {
        schemaName: marker(),
        tableName: marker(),
        tableSize: "1 MB",
        tableSizeBytes: 1,
        totalSize: "1 MB",
        totalSizeBytes: 1,
      },
    ];
    mockOf(provider.getTableStats).mockImplementation(async () => tables);
    const calls: { request: MonitoringPanelRequest; ctx: CallContext }[] = [];
    const request = { panel: "tables", schema: marker() } as const;
    const grant = minuteGrant();
    const read = await withCore(
      (real) => ({
        ...real,
        panelCall: (session, sent, ctx, ports) => {
          calls.push({ request: sent, ctx });
          return real.panelCall(session, sent, ctx, ports);
        },
      }),
      () => readGrantedPanel(providerMonitoringTarget(provider), request, grant),
    );

    expect(read).toEqual({ kind: "answered", member: tables });
    expect(read.kind === "answered" && read.member).toBe(tables);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual(request);
    expect(calls[0]?.request).not.toBe(request);
    expect(Object.isFrozen(calls[0]?.request)).toBe(true);
    expect(Object.isFrozen(request)).toBe(false);
    expect(Reflect.ownKeys(calls[0]?.ctx ?? {}).sort()).toEqual(["deadline", "env", "signal"]);
    expect(calls[0]?.ctx.deadline).toBe(grant.deadline);
    expect(calls[0]?.ctx.signal.aborted).toBe(false);
    expect(mockOf(provider.getTableStats).mock.calls).toEqual([[{ schema: request.schema }]]);
    expect(grant.held).toEqual([]);
  });

  test("a granted panel read of a panel the session does not offer answers not-offered and reads nothing", async () => {
    const row = engineFacetsFor("cassandra").monitoring;
    const unoffered = MONITORING_PANELS.filter((panel) => row[panel] === "not-offered");
    const cassandra = createMockProvider({ type: "cassandra" });
    const lacking = Object.assign(providerOf(), { getStorageStats: undefined });
    const grant = minuteGrant();

    expect(unoffered).toContain("storage");
    expect(await readGrantedPanel(providerMonitoringTarget(cassandra), { panel: "storage" }, grant)).toEqual({
      kind: "not-offered",
    });
    expect(await readGrantedPanel(providerMonitoringTarget(lacking), { panel: "storage" }, grant)).toEqual({
      kind: "not-offered",
    });
    expect(mockOf(cassandra.getStorageStats)).not.toHaveBeenCalled();
    expect(grant.held).toEqual([]);
  });

  test("a granted read whose deadline passed before it started is StudioTimeoutRefusal not-sent and reads nothing", async () => {
    const provider = providerOf();
    const grant = grantOf(Date.now() - 1);

    const panel = await failure(() =>
      readGrantedPanel(providerMonitoringTarget(provider), { panel: "storage" }, grant),
    );
    const health = await failure(() => readGrantedHealth(providerMonitoringTarget(provider), grant));

    for (const error of [panel, health]) {
      expect(error).toBeInstanceOf(StudioTimeoutRefusal);
      expect((error as Error).message).toBe(grant.deadlineSentence);
      expect(errorOutcome(error)).toBe("not-sent");
    }
    expect(mockOf(provider.getStorageStats)).not.toHaveBeenCalled();
    expect(mockOf(provider.getHealth)).not.toHaveBeenCalled();
    expect(grant.held).toEqual([]);
  });

  test("a granted read its deadline stopped is StudioTimeoutRefusal, hands its caller the stopped call's settlement and logs a later failure by kind and code only", async () => {
    const secret = marker();
    const provider = providerOf();
    const pending = Promise.withResolvers<never>();
    mockOf(provider.getActiveSessions).mockImplementation(() => pending.promise);
    const grant = grantOf(Date.now() + 30);
    let settledSeen = false;
    const warned = await warningsOf(async () => {
      const stopped = await failure(() =>
        readGrantedPanel(providerMonitoringTarget(provider), { panel: "activeSessions", limit: 5 }, grant),
      );

      expect(stopped).toBeInstanceOf(StudioTimeoutRefusal);
      expect((stopped as Error).message).toBe(grant.deadlineSentence);
      expect(errorOutcome(stopped)).toBe("unknown");
      expect(grant.held).toHaveLength(1);
      const held = grant.held[0]?.then(() => {
        settledSeen = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settledSeen).toBe(false);
      pending.reject(new Error(secret));
      await held;
      expect(settledSeen).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(mockOf(provider.getActiveSessions).mock.calls).toEqual([[{ limit: 5 }]]);
    expect(warned).toEqual([
      [
        "A monitoring read Studio stopped waiting for failed afterwards",
        { route: ROUTE, facet: "panel", panel: "activeSessions", kind: "internal", code: "INTERNAL_ERROR" },
      ],
    ]);
    expect(JSON.stringify(warned)).not.toContain(secret);
  });

  test("a granted read passes the provider's error as the same object", async () => {
    const provider = providerOf();
    const thrown = new Error(marker());
    mockOf(provider.getSlowQueries).mockImplementation(async () => {
      throw thrown;
    });
    void healthMember(provider, async () => {
      throw thrown;
    });

    expect(
      await failure(() =>
        readGrantedPanel(providerMonitoringTarget(provider), { panel: "slowQueries", limit: 3 }, minuteGrant()),
      ),
    ).toBe(thrown);
    expect(await failure(() => readGrantedHealth(providerMonitoringTarget(provider), minuteGrant()))).toBe(thrown);
  });

  test("a granted read before the host core is installed throws by name before any read", () => {
    const provider = providerOf();
    const grant = minuteGrant();
    const real = hostCore();
    forgetHostCore();
    try {
      expect(() => readGrantedPanel(providerMonitoringTarget(provider), { panel: "storage" }, grant)).toThrow(
        HostCoreBootOrderError,
      );
      expect(() => readGrantedHealth(providerMonitoringTarget(provider), grant)).toThrow(HostCoreBootOrderError);
    } finally {
      installHostCore(real, "test");
    }

    expect(mockOf(provider.getStorageStats)).not.toHaveBeenCalled();
    expect(mockOf(provider.getHealth)).not.toHaveBeenCalled();
  });

  test("a granted health read follows the same rules over the host core's health call", async () => {
    const secret = marker();
    const provider = providerOf();
    const health = healthOf();
    void healthMember(provider, async () => health);
    const contexts: CallContext[] = [];
    const grant = minuteGrant();
    const answered = await withCore(
      (real) => ({
        ...real,
        healthCall: (session, ctx, ports) => {
          contexts.push(ctx);
          return real.healthCall(session, ctx, ports);
        },
      }),
      () => readGrantedHealth(providerMonitoringTarget(provider), grant),
    );

    expect(answered).toBe(health);
    expect(contexts).toHaveLength(1);
    expect(Reflect.ownKeys(contexts[0] ?? {}).sort()).toEqual(["deadline", "env", "signal"]);
    expect(contexts[0]?.deadline).toBe(grant.deadline);

    const stalled = providerOf();
    const pending = Promise.withResolvers<never>();
    void healthMember(stalled, () => pending.promise);
    const short = grantOf(Date.now() + 30);
    const warned = await warningsOf(async () => {
      const stopped = await failure(() => readGrantedHealth(providerMonitoringTarget(stalled), short));
      expect(stopped).toBeInstanceOf(StudioTimeoutRefusal);
      expect((stopped as Error).message).toBe(short.deadlineSentence);
      expect(errorOutcome(stopped)).toBe("unknown");
      expect(short.held).toHaveLength(1);
      pending.reject(new Error(secret));
      await short.held[0];
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(warned).toEqual([HEALTH_LATE]);
    expect(JSON.stringify(warned)).not.toContain(secret);
    expect(grant.held).toEqual([]);
  });
});

describe("monitoringOptionsRefusal", () => {
  test("the monitoring options are refused by name when a limit is not a whole number from 1 to its list's answer bound or the schema is not text that names one", () => {
    const schema = marker();
    expect(monitoringOptionsRefusal({})).toBeUndefined();
    expect(
      monitoringOptionsRefusal({
        slowQueryLimit: ANSWER_LIST_MAX.slowQueries,
        sessionLimit: ANSWER_LIST_MAX.activeSessions,
        schemaFilter: schema,
      }),
    ).toBeUndefined();
    expect(
      monitoringOptionsRefusal({ includeTables: false, includeIndexes: true, includeStorage: false }),
    ).toBeUndefined();

    const limit = (name: "slowQueryLimit" | "sessionLimit") =>
      `options.${name} must be a whole number from 1 to ${ANSWER_LIST_MAX[name === "slowQueryLimit" ? "slowQueries" : "activeSessions"]}`;
    expect(monitoringOptionsRefusal({ slowQueryLimit: 1, sessionLimit: 1 })).toBeUndefined();
    const schemaSentence = "options.schemaFilter must name a schema, as text that is not empty";
    const badLimits: readonly unknown[] = [0, -1, 1.5, "10", Number.NaN, Number.POSITIVE_INFINITY, 1e300, true, null];
    for (const bad of [...badLimits, Number.MAX_SAFE_INTEGER, ANSWER_LIST_MAX.slowQueries + 1]) {
      expect(monitoringOptionsRefusal({ slowQueryLimit: bad })).toBe(limit("slowQueryLimit"));
    }
    for (const bad of [...badLimits, Number.MAX_SAFE_INTEGER, ANSWER_LIST_MAX.activeSessions + 1]) {
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

/** An engine record holding only what `packageFailureAnswer` reads: whether it offers a legacy provider, and its grant. */
function engineOf(legacyProvider: boolean, ownWords: "scrubbed" | "code-only"): EngineRecord {
  return { id: randomUUID(), offers: { legacyProvider }, grants: { ownWords } } as unknown as EngineRecord;
}

/** Core's scrub of a package connection's providers. */
const packageScrub = () =>
  providerTextScrub({ id: "c2", name: "Pkg", type: "postgres", host: "pkg.internal" } as DatabaseConnection, "any");

/** A session's calls with `monitoring.panel` offered or not, pool statistics offered and every other call not. */
function monitoringCalls(panel: "offered" | "not-offered") {
  return {
    console: {
      execute: { honours: [] },
      cancel: "not-offered",
      endScope: "not-offered",
      transaction: "not-offered",
    },
    objects: { tree: "not-offered" },
    maintenance: { run: "not-offered", preview: "not-offered" },
    monitoring: { panel, poolStats: "offered" },
  } as unknown as MonitoringTarget["session"]["calls"];
}

/** The panels of the package session below: the overview and the tables, and no other. */
const PACKAGE_PANELS = Object.freeze(
  Object.fromEntries(
    MONITORING_PANELS.map((panel) => [panel, panel === "overview" || panel === "tables" ? "offered" : "not-offered"]),
  ),
) as unknown as MonitoringTarget["session"]["panels"];

/**
 * A target of a session of the package form: a panel, pool statistics and health function recording each call's facet
 * and context and answering an answer of its form, the overview and the tables offered, an environment of its own and
 * run marks counted.
 */
function packageMonitoringTarget(panel: "offered" | "not-offered" = "offered", timeout = 2_000) {
  const calls: { facet: string; ctx: CallContext }[] = [];
  const marks: string[] = [];
  const env = { get: () => undefined } as unknown as MonitoringTarget["env"];
  const target: MonitoringTarget = {
    session: {
      calls: monitoringCalls(panel),
      panels: PACKAGE_PANELS,
      panel: async (request, ctx) => {
        calls.push({ facet: request.panel, ctx });
        return (request.panel === "overview" ? { overview: overviewOf() } : { tables: [] }) as never;
      },
      poolStats: async (ctx) => {
        calls.push({ facet: "poolStats", ctx });
        return { total: 4, idle: 1, active: 3, waiting: 0 };
      },
      health: async (ctx) => {
        calls.push({ facet: "health", ctx });
        return healthOf();
      },
    },
    env,
    timeout: () => timeout,
    started: () => {
      marks.push("started");
    },
    ended: (record) => {
      marks.push(`ended ${record?.kind}`);
    },
  };
  return { target, calls, marks, env };
}

/** The errors logged while `body` runs, `logger.error` restored afterwards. */
async function errorsOf(body: () => Promise<void>): Promise<unknown[][]> {
  const logged: unknown[][] = [];
  const error = spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  try {
    await body();
  } finally {
    error.mockRestore();
  }
  return logged;
}

describe("the monitoring facades on a session target", () => {
  test("the monitoring facades read any session the target states, a package's and the bridge's alike, under its environment and timeout, counting each call on the entry", async () => {
    const { target, calls, marks, env } = packageMonitoringTarget("offered", 2_000);
    const start = Date.now();
    const engine = engineOf(false, "code-only");
    const monitoring = providerMonitoring(
      target,
      engine,
      packageScrub(),
      new AbortController().signal,
      ROUTE,
      () => start,
    );
    expect(monitoring.poolStatsOffered).toBe(true);
    const dashboard = await monitoring.readDashboard({});
    expect(dashboard.tables).toEqual([]);
    expect(dashboard.notOffered).toEqual(MONITORING_PANELS.filter((panel) => PACKAGE_PANELS[panel] === "not-offered"));
    await monitoring.readPoolStats();
    await monitoring.readHealth();
    expect(await monitoring.readOverview()).toEqual(expect.objectContaining({ tableCount: 0 }));
    expect(calls.map(({ facet }) => facet)).toEqual(["overview", "tables", "poolStats", "health", "overview"]);
    for (const { ctx } of calls) {
      expect(ctx.env).toBe(env);
      expect(ctx.deadline).toBe(start + 2_000 + EXECUTE_SLACK_MS);
    }
    expect(marks).toEqual([
      "started",
      "started",
      "ended answered",
      "ended answered",
      ...["poolStats", "health", "overview"].flatMap(() => ["started", "ended answered"]),
    ]);

    // The granted reads run on the target's session under its environment and the grant's deadline, each marked.
    calls.length = 0;
    marks.length = 0;
    const grant = minuteGrant();
    expect(await readGrantedPanel(target, { panel: "tables" }, grant)).toEqual({ kind: "answered", member: [] });
    await readGrantedHealth(target, grant);
    expect(calls.map(({ facet }) => facet)).toEqual(["tables", "health"]);
    for (const { ctx } of calls) {
      expect(ctx.env).toBe(env);
      expect(ctx.deadline).toBe(grant.deadline);
    }
    expect(marks).toEqual(["started", "ended answered", "started", "ended answered"]);

    // A call the session rejects ends its mark too, the granted read passing the failure as the same object.
    const failed = packageMonitoringTarget();
    const thrown = new Error(marker());
    Object.assign(failed.target.session, { health: () => Promise.reject(thrown) });
    expect(await failure(() => readGrantedHealth(failed.target, minuteGrant()))).toBe(thrown);
    expect(failed.marks).toEqual(["started", "ended undefined"]);

    // The bridge's session of a legacy provider is read the same way, under the provider's own statement timeout.
    const provider = providerOf(4_000, pooled());
    const bridged = providerMonitoringTarget(provider);
    expect(bridged.timeout()).toBe(4_000);
    const legacy = providerMonitoring(
      bridged,
      servedEngineRecord("postgres"),
      providerTextScrub(provider.config, "any"),
      new AbortController().signal,
      ROUTE,
    );
    await legacy.readDashboard({});
    await legacy.readPoolStats();
    await legacy.readHealth();
    for (const member of [...MEMBERS, "getPoolStats" as const, "getHealth" as const]) {
      expect(mockOf((provider as unknown as Record<string, unknown>)[member])).toHaveBeenCalledTimes(1);
    }
  });

  test("a package's failure of a panel, pool statistics or health read reaches the caller as packageFailureAnswer answers it, a dashboard's failed panel holding Studio's sentence where the package's words are code-only, and a legacy record's failure as the same object", async () => {
    const codeOnly = engineOf(false, "code-only");
    const thrown = new Error(marker());
    const sentence = (call: string) =>
      `The provider package's ${call} failed (${errorCode(thrown)}); the server's log holds its words.`;
    const failing = packageMonitoringTarget();
    Object.assign(failing.target.session, {
      panel: async (request: MonitoringPanelRequest) => {
        if (request.panel === "tables") throw thrown;
        return { overview: overviewOf() };
      },
      poolStats: () => Promise.reject(thrown),
      health: () => Promise.reject(thrown),
    });
    const caught: unknown[] = [];
    const logged = await errorsOf(async () => {
      const monitoring = providerMonitoring(
        failing.target,
        codeOnly,
        packageScrub(),
        new AbortController().signal,
        ROUTE,
      );
      const dashboard = await monitoring.readDashboard({});
      expect(dashboard.errors).toEqual({ tables: sentence("panel read") });
      caught.push(await failure(() => monitoring.readPoolStats()), await failure(() => monitoring.readHealth()));
    });
    expect((caught[0] as Error).message).toBe(sentence("pool statistics read"));
    expect((caught[1] as Error).message).toBe(sentence("health"));
    expect(logged.map(([message]) => message)).toEqual([
      "A provider package's panel read failed",
      "A provider package's pool statistics read failed",
      "A provider package's health failed",
    ]);

    // A health answer the core refused is the package's defect, named by its rule.
    const unreadable = packageMonitoringTarget();
    Object.assign(unreadable.target.session, { health: async () => ({ activeConnections: marker() }) });
    let defect: unknown;
    const defectLogged = await errorsOf(async () => {
      defect = await failure(() =>
        providerMonitoring(
          unreadable.target,
          codeOnly,
          packageScrub(),
          new AbortController().signal,
          ROUTE,
        ).readHealth(),
      );
    });
    expect((defect as Error).message).toBe(
      `${PACKAGE_DEFECT_PREFIX} it broke the rule health-answer-unreadable; the server's log names where.`,
    );
    expect(defectLogged).toHaveLength(1);

    // A granted record's failure is answered as raised, logged once; several distinct sentences are joined unmapped.
    const scrubbed = engineOf(false, "scrubbed");
    const words = [`permission denied ${marker()}`, `permission denied ${marker()}`];
    const several = packageMonitoringTarget();
    Object.assign(several.target.session, {
      panel: async (request: MonitoringPanelRequest) => {
        throw new Error(request.panel === "overview" ? words[0] : words[1]);
      },
      health: () => Promise.reject(thrown),
    });
    let joined: unknown;
    let raised: unknown;
    const grantedLogged = await errorsOf(async () => {
      const monitoring = providerMonitoring(
        several.target,
        scrubbed,
        packageScrub(),
        new AbortController().signal,
        ROUTE,
      );
      joined = await failure(() => monitoring.readDashboard({}));
      raised = await failure(() => monitoring.readHealth());
    });
    expect((joined as Error).constructor).toBe(Error);
    expect((joined as Error).message).toBe(words.join("; "));
    expect(raised).toBe(thrown);
    expect(grantedLogged).toHaveLength(3);

    // A legacy record's failure, and Studio's own failure on a package record, pass as the same object, logged nowhere.
    const legacy = packageMonitoringTarget();
    Object.assign(legacy.target.session, { health: () => Promise.reject(thrown) });
    const gone = new AbortController();
    gone.abort(new DOMException("The request went away.", "AbortError"));
    let left: unknown;
    let unbooted: unknown;
    const studioLogged = await errorsOf(async () => {
      const legacyRecord = { ...engineOf(true, "code-only") };
      expect(
        await failure(() =>
          providerMonitoring(
            legacy.target,
            legacyRecord,
            packageScrub(),
            new AbortController().signal,
            ROUTE,
          ).readHealth(),
        ),
      ).toBe(thrown);
      left = await failure(() =>
        providerMonitoring(packageMonitoringTarget().target, codeOnly, packageScrub(), gone.signal, ROUTE).readHealth(),
      );
      const real = hostCore();
      forgetHostCore();
      try {
        unbooted = await failure(() =>
          providerMonitoring(
            packageMonitoringTarget().target,
            codeOnly,
            packageScrub(),
            new AbortController().signal,
            ROUTE,
          ).readPoolStats(),
        );
      } finally {
        installHostCore(real, "test");
      }
    });
    expect(left).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(left)).toBe("not-sent");
    expect(unbooted).toBeInstanceOf(HostCoreBootOrderError);
    expect(studioLogged).toEqual([]);
  });

  test("a target whose session does not offer monitoring.panel is refused the dashboard by name before any call, not-sent, while its health is still read", async () => {
    const { target, calls, marks } = packageMonitoringTarget("not-offered");
    const monitoring = providerMonitoring(
      target,
      engineOf(false, "code-only"),
      packageScrub(),
      new AbortController().signal,
      ROUTE,
    );

    const refused = await failure(() => monitoring.readDashboard({}));
    expect(refused).toBeInstanceOf(FacetNotOfferedError);
    expect((refused as FacetNotOfferedError).message).toBe(
      "This connection's provider package does not offer monitoring.panel, so Studio did not call it.",
    );
    expect([(refused as FacetNotOfferedError).facet, (refused as FacetNotOfferedError).operation]).toEqual([
      "monitoring",
      "panel",
    ]);
    expect(errorOutcome(refused)).toBe("not-sent");
    expect(calls).toEqual([]);
    expect(marks).toEqual([]);

    await monitoring.readHealth();
    expect(calls.map(({ facet }) => facet)).toEqual(["health"]);
    expect(marks).toEqual(["started", "ended answered"]);
  });
});
