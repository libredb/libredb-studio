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
 * answer, with a real deadline, in a bounded Node child, and a granted panel read and a granted health read the same.
 *
 * The granted reads, the agent's curated readings' facade (clause C-76), run under a deadline the caller was granted
 * and no signal of the caller's own; their cases build each grant here.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, HealthInfo, MonitoringPanelRequest } from "@libredb/provider-sdk/calls";
import { EXECUTE_SLACK_MS, executeDeadline } from "@/lib/api/editor-query";
import {
  type GrantedRead,
  monitoringOptionsRefusal,
  providerMonitoring,
  readGrantedHealth,
  readGrantedPanel,
  readHealthWithin,
} from "@/lib/api/provider-monitoring";
import { engineFacetsFor } from "@/lib/db/engine-facets";
import { MONITORING_PANELS, type MonitoringPanel } from "@/lib/db/engine-facets/types";
import { errorOutcome } from "@/lib/db/error-record";
import { QueryCancelledError, StudioTimeoutRefusal, waitedSeconds } from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
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
        const monitoring = providerMonitoring(provider, new AbortController().signal, ROUTE);
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
      caught = [
        await failure(() => monitoring.readDashboard({})),
        await failure(() => monitoring.readPoolStats()),
        await failure(() => monitoring.readHealth()),
        await failure(() => monitoring.readOverview()),
        await failure(() => readHealthWithin(provider, Date.now() + 60_000, new AbortController().signal, ROUTE)),
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
      () => providerMonitoring(provider, caller.signal, ROUTE, steppedClock).readHealth(),
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

    expect(await failure(() => providerMonitoring(provider, new AbortController().signal, ROUTE).readHealth())).toBe(
      thrown,
    );
  });

  test("a health read whose caller leaves is answered a stop at once, QueryCancelledError outcome unknown, and its later failure is logged by kind and code, never its text", async () => {
    const secret = marker();
    const warned = await warningsOf(async () => {
      const pending = Promise.withResolvers<never>();
      const provider = providerOf();
      const reached = healthMember(provider, () => pending.promise);
      const caller = new AbortController();
      const reading = failure(() => providerMonitoring(provider, caller.signal, ROUTE).readHealth());
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

    const gone = await failure(() => providerMonitoring(provider, caller.signal, ROUTE).readHealth());

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
      () => failure(() => providerMonitoring(provider, new AbortController().signal, ROUTE).readHealth()),
    );
    const behind = () => Date.now() - 60_000 - EXECUTE_SLACK_MS - 1_000;
    const refused = await failure(() =>
      providerMonitoring(provider, new AbortController().signal, ROUTE, behind).readHealth(),
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
    const overview = { marker: marker() };
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
        await providerMonitoring(provider, caller.signal, ROUTE, steppedClock).readOverview(),
        await providerMonitoring(s3, caller.signal, ROUTE, steppedClock).readOverview(),
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
      () => failure(() => providerMonitoring(provider, new AbortController().signal, ROUTE).readOverview()),
    );

    expect((wrong as Error).constructor).toBe(Error);
    expect((wrong as Error).message).toBe(
      "The overview panel read answered a form other than the overview panel's, which is a defect of the session that answered it.",
    );
  });
});

describe("readHealthWithin", () => {
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
      () => readHealthWithin(provider, deadline, signal, ROUTE),
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
      expect(await readHealthWithin(before, Date.now() + 60_000, ended.signal, ROUTE)).toEqual({ kind: "ended" });

      const pending = Promise.withResolvers<never>();
      const reached = healthMember(pendingProvider, () => pending.promise);
      const wait = new AbortController();
      const reading = readHealthWithin(pendingProvider, Date.now() + 60_000, wait.signal, ROUTE);
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

    expect(
      await failure(() => readHealthWithin(provider, Date.now() + 60_000, new AbortController().signal, ROUTE)),
    ).toBe(thrown);
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
      () => readGrantedPanel(provider, request, grant),
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
    expect(await readGrantedPanel(cassandra, { panel: "storage" }, grant)).toEqual({ kind: "not-offered" });
    expect(await readGrantedPanel(lacking, { panel: "storage" }, grant)).toEqual({ kind: "not-offered" });
    expect(mockOf(cassandra.getStorageStats)).not.toHaveBeenCalled();
    expect(grant.held).toEqual([]);
  });

  test("a granted read whose deadline passed before it started is StudioTimeoutRefusal not-sent and reads nothing", async () => {
    const provider = providerOf();
    const grant = grantOf(Date.now() - 1);

    const panel = await failure(() => readGrantedPanel(provider, { panel: "storage" }, grant));
    const health = await failure(() => readGrantedHealth(provider, grant));

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
      const stopped = await failure(() => readGrantedPanel(provider, { panel: "activeSessions", limit: 5 }, grant));

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

    expect(await failure(() => readGrantedPanel(provider, { panel: "slowQueries", limit: 3 }, minuteGrant()))).toBe(
      thrown,
    );
    expect(await failure(() => readGrantedHealth(provider, minuteGrant()))).toBe(thrown);
  });

  test("a granted read before the host core is installed throws by name before any read", () => {
    const provider = providerOf();
    const grant = minuteGrant();
    const real = hostCore();
    forgetHostCore();
    try {
      expect(() => readGrantedPanel(provider, { panel: "storage" }, grant)).toThrow(HostCoreBootOrderError);
      expect(() => readGrantedHealth(provider, grant)).toThrow(HostCoreBootOrderError);
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
      () => readGrantedHealth(provider, grant),
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
      const stopped = await failure(() => readGrantedHealth(stalled, short));
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
