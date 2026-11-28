/**
 * The host core's monitoring calls (src/lib/provider-host/core/monitoring.ts; docs/providers/CONTRACT.md, clause
 * C-73): a panel read or a pool statistics read is checked before it is made, its facet and, for a panel, its request
 * against the session's panels included, and refused as a record; it runs on a context and request frozen in place, is
 * waited for until the call's signal, and answers the session's own answer by reference, as the tree call answers its
 * own.
 *
 * Every session here is a fake whose `panel` and `poolStats` the test drives through promises it settles itself; no
 * assertion follows a timer. `monitoring-bounds.test.ts` holds a call that never settles, with a real deadline, in a
 * bounded Node child.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CallContext,
  envReader,
  type HealthInfo,
  type MonitoringPanelAnswer,
  type MonitoringPanelRequest,
  type PoolStats,
} from "@libredb/provider-sdk/calls";
import type { Calls, MonitoringPanels } from "@libredb/provider-sdk/manifest";
import type { HostCallPorts } from "@/lib/provider-host/core/console";
import {
  type HealthSession,
  healthCall,
  type MonitoringSession,
  type PanelRecord,
  type PoolStatsRecord,
  panelCall,
  poolStatsCall,
} from "@/lib/provider-host/core/monitoring";

const HOUR = 3_600_000;
const marker = (): string => randomUUID();

/** An overview panel's figures. */
const OVERVIEW = {
  version: "test",
  uptime: "0",
  maxConnections: 0,
  databaseSize: "0",
  tableCount: 0,
  indexCount: 0,
} as const;

/** A session's calls, with both monitoring facets offered unless told otherwise. */
function callsOf(panel = true, poolStats = true): Calls {
  return {
    console: {
      execute: { honours: [] },
      cancel: "not-offered",
      endScope: "not-offered",
      transaction: "not-offered",
    },
    objects: { tree: "not-offered", source: "not-offered" },
    maintenance: { run: "not-offered", preview: "not-offered" },
    monitoring: { panel: panel ? "offered" : "not-offered", poolStats: poolStats ? "offered" : "not-offered" },
  };
}

/** Panels with the overview and the slow queries offered, and the other five not. */
const PANELS: MonitoringPanels = {
  overview: "offered",
  performance: "not-offered",
  slowQueries: "offered",
  activeSessions: "not-offered",
  tables: "not-offered",
  indexes: "not-offered",
  storage: "not-offered",
};

function contextOf(controller = new AbortController(), deadline = Date.now() + HOUR): CallContext {
  return { deadline, signal: controller.signal, env: envReader([], () => undefined) };
}

/** Late ports that record each failure and resolve a promise with the first. */
function portsOf() {
  const late: unknown[] = [];
  const firstLate = Promise.withResolvers<unknown>();
  const ports: Pick<HostCallPorts, "late"> = {
    late: (error) => {
      late.push(error);
      firstLate.resolve(error);
    },
  };
  return { ports, late, firstLate: firstLate.promise };
}

interface Read {
  readonly request?: MonitoringPanelRequest;
  readonly ctx: CallContext;
}

/** A session whose panel and pool statistics answer what `panel` and `poolStats` give, recording each call. */
function sessionOf(
  panel: (request: MonitoringPanelRequest, ctx: CallContext) => Promise<MonitoringPanelAnswer>,
  poolStats: (ctx: CallContext) => Promise<PoolStats>,
  calls = callsOf(),
) {
  const reads: Read[] = [];
  const called = Promise.withResolvers<void>();
  const session: MonitoringSession = {
    calls,
    panels: PANELS,
    panel: (request, ctx) => {
      reads.push({ request, ctx });
      called.resolve();
      return panel(request, ctx);
    },
    poolStats: (ctx) => {
      reads.push({ ctx });
      called.resolve();
      return poolStats(ctx);
    },
  };
  return { session, reads, called: called.promise };
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

/** Lets every callback already queued run: one turn of the event loop, never a timer an assertion waits on. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Facet = "panel" | "poolStats";

/** One call of `facet` on `session`, with a request the panels above offer. */
function callOf(
  facet: Facet,
  session: MonitoringSession,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<PanelRecord | PoolStatsRecord> {
  return facet === "panel"
    ? panelCall(session, { panel: "slowQueries", limit: 7 }, ctx, ports)
    : poolStatsCall(session, ctx, ports);
}

/** A session whose panel and pool statistics both answer `answer`. */
function answering(answer: () => Promise<never>, calls = callsOf()) {
  return sessionOf(answer, answer, calls);
}

const FACETS: readonly Facet[] = ["panel", "poolStats"];

describe("panelCall and poolStatsCall", () => {
  test("a monitoring call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called", async () => {
    for (const facet of FACETS) {
      const fx = answering(async () => {
        throw new Error("never called");
      });
      const { ports } = portsOf();
      const controller = new AbortController();
      const reason = new Error(marker());
      controller.abort(reason);

      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each record is its own call's.
      const aborted = await callOf(facet, fx.session, contextOf(controller), ports);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each record is its own call's.
      const late = await callOf(facet, fx.session, contextOf(new AbortController(), Date.now() - 1), ports);

      expect(aborted).toEqual({
        kind: "refused",
        called: false,
        refusals: [{ rule: "call-signal-aborted", pointer: "/signal" }],
        cause: reason,
      });
      expect((aborted as { cause?: unknown }).cause).toBe(reason);
      expect(late).toEqual({
        kind: "refused",
        called: false,
        refusals: [{ rule: "call-deadline-passed", pointer: "/deadline" }],
      });
      expect(fx.reads).toEqual([]);
    }
  });

  test("a monitoring call to a session without its facet is refused as a record before the call", async () => {
    for (const facet of FACETS) {
      const fx = answering(
        async () => {
          throw new Error("never called");
        },
        callsOf(facet !== "panel", facet !== "poolStats"),
      );
      const { ports } = portsOf();

      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each record is its own call's.
      const record = await callOf(facet, fx.session, contextOf(), ports);

      expect(record).toEqual({
        kind: "refused",
        called: false,
        refusals: [{ rule: "facet-not-offered", pointer: `/monitoring/${facet}`, name: `monitoring.${facet}` }],
      });
      expect(fx.reads).toEqual([]);
    }
  });

  test("a panel request for a panel the session's engine does not offer is refused as a record before the call", async () => {
    const fx = answering(async () => {
      throw new Error("never called");
    });
    const { ports } = portsOf();

    const withheld = await panelCall(fx.session, { panel: "storage" }, contextOf(), ports);
    const inherited = await panelCall(fx.session, { panel: "__proto__" } as never, contextOf(), ports);

    for (const record of [withheld, inherited]) {
      expect(record).toEqual({
        kind: "refused",
        called: false,
        refusals: [{ rule: "request-panel-not-offered", pointer: "/panel" }],
      });
    }
    expect(fx.reads).toEqual([]);
  });

  test("a monitoring call answers the session's own answer, with the request and context frozen", async () => {
    const panelAnswer: MonitoringPanelAnswer = { overview: OVERVIEW };
    const poolAnswer: PoolStats = { total: 3, idle: 1, active: 2, waiting: 0 };
    const fx = sessionOf(
      async () => panelAnswer,
      async () => poolAnswer,
    );
    const { ports, late } = portsOf();
    const request: MonitoringPanelRequest = { panel: "overview" };
    const panelContext = contextOf();
    const poolContext = contextOf();

    const read = await panelCall(fx.session, request, panelContext, ports);
    const pooled = await poolStatsCall(fx.session, poolContext, ports);

    if (read.kind !== "answered" || pooled.kind !== "answered") throw new Error("Answers were expected.");
    expect(read.answer).toBe(panelAnswer);
    expect(pooled.answer).toBe(poolAnswer);
    expect(fx.reads[0]?.request).toBe(request);
    expect(fx.reads[0]?.ctx).toBe(panelContext);
    expect(fx.reads[1]).toEqual({ ctx: poolContext });
    expect(fx.reads[1]?.ctx).toBe(poolContext);
    for (const frozen of [request, panelContext, poolContext]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    expect(late).toEqual([]);
  });

  test("an error the provider throws reaches the caller as the same object", async () => {
    for (const facet of FACETS) {
      const rejected = new Error(marker());
      const thrownNow = new Error(marker());
      const { ports, late } = portsOf();

      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each error is its own call's.
      const later = await failure(() =>
        callOf(
          facet,
          answering(async () => {
            throw rejected;
          }).session,
          contextOf(),
          ports,
        ),
      );
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each error is its own call's.
      const now = await failure(() =>
        callOf(
          facet,
          answering(() => {
            throw thrownNow;
          }).session,
          contextOf(),
          ports,
        ),
      );

      expect(later).toBe(rejected);
      expect(now).toBe(thrownNow);
      expect(late).toEqual([]);
    }
  });

  test("a monitoring call the caller stops waiting for answers a stop at once, and its later failure reaches the late handler once", async () => {
    for (const facet of FACETS) {
      const pending = Promise.withResolvers<never>();
      const fx = answering(() => pending.promise);
      const { ports, late, firstLate } = portsOf();
      const controller = new AbortController();
      const reason = new Error(marker());

      const running = callOf(facet, fx.session, contextOf(controller), ports);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await fx.called;
      controller.abort(reason);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      const record = await running;
      if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
      let settled = false;
      const watched = record.settled.then(() => {
        settled = true;
      });
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await turn();
      expect(settled).toBe(false);
      const thrown = new Error(marker());
      pending.reject(thrown);

      expect(record).toEqual({ kind: "stopped", reason, settled: expect.any(Promise) });
      expect(record.reason).toBe(reason);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      expect(await firstLate).toBe(thrown);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await watched;
      expect(settled).toBe(true);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await turn();
      expect(late).toEqual([thrown]);
    }
  });

  test("a monitoring answer that arrives after the stop is dropped, and settled resolves", async () => {
    for (const facet of FACETS) {
      const answered = Promise.withResolvers<never>();
      const fx = answering(() => answered.promise);
      const { ports, late } = portsOf();
      const controller = new AbortController();
      const reason = new Error(marker());

      const stopped = callOf(facet, fx.session, contextOf(controller), ports);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await fx.called;
      controller.abort(reason);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      const record = await stopped;
      if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
      answered.resolve({ total: 1, idle: 1, active: 0, waiting: 0, overview: OVERVIEW } as never);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await record.settled;
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await turn();

      expect(record).toEqual({ kind: "stopped", reason, settled: expect.any(Promise) });
      expect(late).toEqual([]);
    }
  });

  test("a session that throws its own signal's reason is answered as a stop", async () => {
    for (const facet of FACETS) {
      const { ports, late } = portsOf();
      const controller = new AbortController();
      const reason = new Error(marker());
      const own = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      const fx = sessionOf(
        (_request, ctx) => own(ctx.signal),
        (ctx) => own(ctx.signal),
      );

      const running = callOf(facet, fx.session, contextOf(controller), ports);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await fx.called;
      controller.abort(reason);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      const record = await running;
      if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await record.settled;
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await turn();

      expect(record.reason).toBe(reason);
      expect(late).toEqual([]);
    }
  });

  test("a session that offers a monitoring facet with no function is a host defect, named", async () => {
    const { ports } = portsOf();
    const missing: MonitoringSession = { calls: callsOf(), panels: PANELS };

    const panel = await failure(() => callOf("panel", missing, contextOf(), ports));
    const poolStats = await failure(() => callOf("poolStats", missing, contextOf(), ports));

    expect(panel).toBeInstanceOf(Error);
    expect((panel as Error).message).toBe(
      "The session offers monitoring.panel and has no panel function, a defect of the host's session.",
    );
    expect((poolStats as Error).message).toBe(
      "The session offers monitoring.poolStats and has no poolStats function, a defect of the host's session.",
    );
  });
});

/** A health session whose `health` answers what `health` gives, recording each call's arguments. */
function healthSessionOf(health: (ctx: CallContext) => Promise<HealthInfo>) {
  const reads: unknown[][] = [];
  const called = Promise.withResolvers<void>();
  const session: HealthSession = {
    health: (...args: [CallContext]) => {
      reads.push(args);
      called.resolve();
      return health(...args);
    },
  };
  return { session, reads, called: called.promise };
}

/** A health answer with nothing in its lists. */
function healthOf(): HealthInfo {
  return { activeConnections: 1, databaseSize: marker(), cacheHitRatio: "0", slowQueries: [], activeSessions: [] };
}

describe("healthCall", () => {
  test("a health call whose signal aborted or whose deadline passed is refused as a record, and the session's health is never called", async () => {
    const fx = healthSessionOf(async () => {
      throw new Error("never called");
    });
    const { ports } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());
    controller.abort(reason);

    const aborted = await healthCall(fx.session, contextOf(controller), ports);
    const late = await healthCall(fx.session, contextOf(new AbortController(), Date.now() - 1), ports);

    expect(aborted).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-signal-aborted", pointer: "/signal" }],
      cause: reason,
    });
    expect((aborted as { cause?: unknown }).cause).toBe(reason);
    expect(late).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-deadline-passed", pointer: "/deadline" }],
    });
    expect(fx.reads).toEqual([]);
  });

  test("a health call reads no facet and answers the session's own health, its context frozen", async () => {
    const health = healthOf();
    // The session holds no `calls`: the health call is mandatory, so no facet is read.
    const fx = healthSessionOf(async () => health);
    const { ports, late } = portsOf();
    const ctx = contextOf();

    const record = await healthCall(fx.session, ctx, ports);

    if (record.kind !== "answered") throw new Error(`An answer was expected, not ${record.kind}.`);
    expect(record.answer).toBe(health);
    expect(fx.reads).toHaveLength(1);
    expect(fx.reads[0]).toHaveLength(1);
    expect(fx.reads[0]?.[0]).toBe(ctx);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(late).toEqual([]);
  });

  test("a health error the session raises reaches the caller as the same object, a synchronous throw as the call's rejection", async () => {
    const rejected = new Error(marker());
    const thrownNow = new Error(marker());
    const { ports, late } = portsOf();

    const later = await failure(() =>
      healthCall(
        healthSessionOf(async () => {
          throw rejected;
        }).session,
        contextOf(),
        ports,
      ),
    );
    const now = await failure(() =>
      healthCall(
        healthSessionOf(() => {
          throw thrownNow;
        }).session,
        contextOf(),
        ports,
      ),
    );

    expect(later).toBe(rejected);
    expect(now).toBe(thrownNow);
    expect(late).toEqual([]);
  });

  test("a health call the caller stops waiting for answers a stop at once, its later failure reaches the late handler once, and a later answer is dropped", async () => {
    const failing = Promise.withResolvers<never>();
    const failed = healthSessionOf(() => failing.promise);
    const answering = Promise.withResolvers<HealthInfo>();
    const answered = healthSessionOf(() => answering.promise);
    const failedPorts = portsOf();
    const answeredPorts = portsOf();
    const failedController = new AbortController();
    const answeredController = new AbortController();
    const reason = new Error(marker());

    const failedRun = healthCall(failed.session, contextOf(failedController), failedPorts.ports);
    const answeredRun = healthCall(answered.session, contextOf(answeredController), answeredPorts.ports);
    await Promise.all([failed.called, answered.called]);
    failedController.abort(reason);
    answeredController.abort(reason);
    const [failedRecord, answeredRecord] = await Promise.all([failedRun, answeredRun]);
    if (failedRecord.kind !== "stopped" || answeredRecord.kind !== "stopped") throw new Error("Stops were expected.");
    let settled = false;
    const watched = failedRecord.settled.then(() => {
      settled = true;
    });
    await turn();
    expect(settled).toBe(false);
    const thrown = new Error(marker());
    failing.reject(thrown);
    answering.resolve(healthOf());

    expect(failedRecord).toEqual({ kind: "stopped", reason, settled: expect.any(Promise) });
    expect(failedRecord.reason).toBe(reason);
    expect(await failedPorts.firstLate).toBe(thrown);
    await watched;
    await answeredRecord.settled;
    await turn();
    expect(settled).toBe(true);
    expect(failedPorts.late).toEqual([thrown]);
    expect(answeredPorts.late).toEqual([]);
  });

  test("a session that throws its health call's own signal reason is answered as a stop", async () => {
    const { ports, late } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());
    const fx = healthSessionOf(
      (ctx) =>
        new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        }),
    );

    const running = healthCall(fx.session, contextOf(controller), ports);
    await fx.called;
    controller.abort(reason);
    const record = await running;
    if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
    await record.settled;
    await turn();

    expect(record.reason).toBe(reason);
    expect(late).toEqual([]);
  });
});
