/**
 * The open of a session on an admitted provider package (src/lib/provider-host/core/contract-session.ts;
 * docs/providers/CONTRACT.md, clauses C-109 and C-111): the answer becomes a session whose members are the calls it
 * offers, its refinement narrows it or is refused with the handle closed, an answer the host cannot read throws by
 * name, a late answer is closed and never admitted, and the host core's own calls run on the session unchanged.
 *
 * The implementation is written here by hand and records every call; no timer is awaited, and every wait settles on a
 * promise a case resolves itself.
 */
// oxlint-disable no-await-in-loop -- each open of a case runs after the one before, so its log reads one open.
import { describe, expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CallContext,
  CLEANUP_DEADLINE_MS,
  deadlineSignal,
  type EngineMaintenance,
  envReader,
  type ExecuteRequest,
  type HealthInfo,
  type MonitoringPanelAnswer,
  type OpenContext,
  PAGE_MAX_BYTES,
  BATCH_MAX_BYTES,
  type ProviderImpl,
  rowsSource,
  type SourceRequest,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";
import type { Calls, MonitoringPanels, ObjectModel } from "@libredb/provider-sdk/manifest";
import { type ContractSession, openContractSession } from "@/lib/provider-host/core/contract-session";
import { createHostCore } from "@/lib/provider-host/core/host-core";

const NOT = "not-offered" as const;
const OFFERED = "offered" as const;

/** Calls offering exactly `offered`, by their contract names, and honouring `honours`. */
function callsOf(offered: readonly string[] = [], honours: readonly string[] = []): Calls {
  const offer = (name: string) => (offered.includes(name) ? OFFERED : NOT);
  return {
    console: {
      execute: { honours: honours as Calls["console"]["execute"]["honours"] },
      cancel: offer("console.cancel"),
      endScope: offer("console.endScope"),
      transaction: offer("console.transaction"),
    },
    objects: { tree: offer("objects.tree"), source: offer("objects.source") },
    maintenance: { run: offer("maintenance.run"), preview: offer("maintenance.preview") },
    monitoring: { panel: offer("monitoring.panel"), poolStats: offer("monitoring.poolStats") },
  };
}

const MAINTENANCE: EngineMaintenance = { maintenance: [], maintenanceSpecs: [] };
const PANELS: MonitoringPanels = {
  overview: OFFERED,
  performance: NOT,
  slowQueries: NOT,
  activeSessions: NOT,
  tables: NOT,
  indexes: NOT,
  storage: NOT,
};
/** A panel answer of its panel's form, which the host core reads once and then passes by reference. */
const OVERVIEW: MonitoringPanelAnswer = {
  overview: { version: "1", uptime: "0", maxConnections: 0, databaseSize: "0", tableCount: 0, indexCount: 0 },
};
const HEALTH: HealthInfo = { databaseSize: "1 MB", cacheHitRatio: "99%", slowQueries: [], activeSessions: [] };
const NO_ENV = envReader([], () => undefined);

/** One recorded call: its name, whether `this` was the object holding the function, and its arguments. */
interface Recorded {
  readonly name: string;
  readonly self: boolean;
  readonly args: readonly unknown[];
}

/** A hand-built implementation whose open answers `answer()`, recording every call into `log`. */
function implOf(
  answer: () => Promise<unknown>,
  log: Recorded[],
  execute?: ProviderImpl<unknown>["console"]["execute"],
  close?: () => Promise<void>,
) {
  const record = (name: string, holder: () => object) =>
    function (this: unknown, ...args: unknown[]) {
      log.push({ name, self: this === holder(), args });
      return Promise.resolve(name === "health" ? HEALTH : name === "cancel" ? { cancelled: true } : {});
    };
  const impl: ProviderImpl<unknown> = {
    open(this: unknown, ctx: OpenContext) {
      log.push({ name: "open", self: this === impl, args: [ctx] });
      return answer() as Promise<never>;
    },
    close: function (this: unknown, ...args: unknown[]) {
      log.push({ name: "close", self: this === impl, args });
      return close === undefined ? Promise.resolve() : close();
    },
    health: record("health", () => impl) as unknown as ProviderImpl<unknown>["health"],
    console: {
      execute:
        execute ??
        function (this: unknown, ...args: unknown[]) {
          log.push({ name: "execute", self: this === impl.console, args });
          return Promise.resolve({
            results: [
              rowsSource(
                [{ name: "k" }, { name: "v" }],
                [
                  ["a", 1],
                  ["b", 2],
                  ["c", 3],
                ],
              ),
            ],
            warnings: [],
            executionTimeMs: 4,
            pageApplied: false,
          });
        },
      cancel: record("cancel", () => impl.console) as never,
      transaction: function (this: unknown, ...args: unknown[]) {
        log.push({ name: "transaction", self: this === impl.console, args });
        return Promise.resolve({ sessionState: "unknown" });
      } as never,
      endScope: function (this: unknown, ...args: unknown[]) {
        log.push({ name: "endScope", self: this === impl.console, args });
        return Promise.resolve({ openTransaction: "none" });
      } as never,
    },
    objects: {
      // An empty answer of the form each request's action answers, which the host core holds it to (clause C-62).
      tree: function (this: unknown, ...args: unknown[]) {
        log.push({ name: "tree", self: this === impl.objects, args });
        const { action } = args[1] as TreeRequest;
        return Promise.resolve(action === "containers" ? { containers: [] } : { objects: [] });
      } as never,
      // The request's own path and kind with one readable part, the closed document the host core holds it to (C-115).
      source: function (this: unknown, ...args: unknown[]) {
        log.push({ name: "source", self: this === impl.objects, args });
        const { path, kind } = args[1] as SourceRequest;
        const part = { id: "body", label: "Body", text: "body", language: "sql", form: "complete", origin: "stored" };
        return Promise.resolve({ path, kind, parts: [part] });
      } as never,
    },
    maintenance: {
      run: record("run", () => impl.maintenance as object) as never,
      preview: record("preview", () => impl.maintenance as object) as never,
    },
    monitoring: {
      panel: function (this: unknown, ...args: unknown[]) {
        log.push({ name: "panel", self: this === impl.monitoring, args });
        return Promise.resolve(OVERVIEW);
      } as never,
      poolStats: function (this: unknown, ...args: unknown[]) {
        log.push({ name: "poolStats", self: this === impl.monitoring, args });
        return Promise.resolve({ total: 1, idle: 1, active: 0, waiting: 0 });
      } as never,
    },
  };
  return impl;
}

/** An open context of its own, with a deadline a minute ahead unless a case passes a signal. */
function contextOf(signal?: AbortSignal): OpenContext {
  const deadline = Date.now() + 60_000;
  return {
    engine: "acmecs",
    connectionId: "conn-cs",
    connection: {},
    egress: { blocksPrivateHosts: true, source: "default" },
    trust: { certificates: [] },
    policy: {
      readOnly: false,
      sendsStatements: false,
      allowExternalFileAccess: false,
      refuseWrites: false,
      managed: false,
      literalSeedFile: false,
    },
    deadline,
    signal: signal ?? deadlineSignal(deadline),
    env: NO_ENV,
  };
}

/** A fresh call context a minute ahead. */
function callContext(signal?: AbortSignal): CallContext {
  const deadline = Date.now() + 60_000;
  return { deadline, signal: signal ?? deadlineSignal(deadline), env: NO_ENV };
}

/** The engine's object model: one container level, addressed exactly, holding the one kind `item`. */
const MODEL: ObjectModel = {
  containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
  containerPathShapes: "exact",
  containerNameSpelling: null,
  objectKinds: [
    {
      id: "item",
      role: "relation",
      label: "Item",
      labelPlural: "Items",
      hasSource: false,
      sourceLanguage: null,
      hasColumns: true,
      acceptsSourceEdits: false,
      childKinds: [],
      attachedTo: null,
      acceptsRowWrites: false,
      enumeratedBy: null,
      countIsListing: false,
      machineNames: null,
      group: null,
    },
  ],
  rowActions: [],
  containersNameKinds: false,
  tablesNeedContainer: false,
  tablesAreDerivedGroupings: false,
  agentWalkScope: null,
  schemaDiffScope: null,
  maskedNameKinds: [],
};

const declared = (calls: Calls) => ({ calls, maintenance: MAINTENANCE, panels: PANELS, objectModel: MODEL });
const late: unknown[] = [];
const onLate = (error: unknown) => late.push(error);

/** The session an open of `impl` answered. */
async function sessionOf(impl: ProviderImpl<unknown>, calls: Calls): Promise<ContractSession> {
  const record = await openContractSession(impl, contextOf(), declared(calls), onLate);
  if (record.kind !== "opened") throw new Error(`the open answered ${record.kind}`);
  return record.session;
}

describe("a session opened on a provider package", () => {
  test("an open answer becomes a session whose members are exactly the calls it offers, each calling the package with its handle first", async () => {
    const handle = { session: randomUUID() };
    const log: Recorded[] = [];
    const impl = implOf(async () => ({ handle, serverVersion: "9.1", engineUser: "reader" }), log);
    const ctx = contextOf();
    const record = await openContractSession(impl, ctx, declared(callsOf(["console.cancel", "objects.tree"])), onLate);

    expect(record.kind).toBe("opened");
    if (record.kind !== "opened") return;
    expect([record.serverVersion, record.engineUser]).toEqual(["9.1", "reader"]);
    const { session } = record;
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(log[0]).toEqual({ name: "open", self: true, args: [ctx] });
    for (const member of ["execute", "cancel", "tree", "health", "close"]) {
      expect(typeof (session as unknown as Record<string, unknown>)[member]).toBe("function");
    }
    for (const member of ["endScope", "transaction", "run", "preview", "panel", "poolStats"]) {
      expect(Object.hasOwn(session, member)).toBe(false);
    }
    expect(session.readOnlyStatements).toBe(false);
    expect(session.panels).toBe(PANELS);

    const call = callContext();
    const request: ExecuteRequest = { statement: "list", page: { limit: 1, offset: 0 } };
    await session.execute(request, call);
    await session.cancel?.({ runId: "r1" }, call);
    await session.tree?.({ action: "containers" } as never, call);
    await session.health(call);
    await session.close(call);
    expect(log.slice(1).map(({ name, self, args }) => [name, self, args[0] === handle])).toEqual([
      ["execute", true, true],
      ["cancel", true, true],
      ["tree", true, true],
      ["health", true, true],
      ["close", true, true],
    ]);
    expect(log[1]?.args.slice(1)).toEqual([request, call]);

    const everything = await sessionOf(
      implOf(async () => ({ handle }), log),
      callsOf(["console.transaction", "maintenance.run", "maintenance.preview"]),
    );
    await everything.transaction?.({ action: "state" }, call);
    await everything.run?.({} as never, call);
    await everything.preview?.({} as never, call);
    expect(log.slice(-3).map(({ name, self, args }) => [name, self, args[0] === handle])).toEqual([
      ["transaction", true, true],
      ["run", true, true],
      ["preview", true, true],
    ]);

    const readOnly = await openContractSession(
      implOf(async () => ({ handle }), []),
      { ...contextOf(), policy: { ...contextOf().policy, readOnly: true, sendsStatements: true } },
      declared(callsOf()),
      onLate,
    );
    expect(readOnly.kind === "opened" && readOnly.session.readOnlyStatements).toBe(true);
  });

  test("a package session states the object model its declaration states", async () => {
    const handle = { session: randomUUID() };
    const log: Recorded[] = [];
    const offering = await sessionOf(
      implOf(async () => ({ handle }), log),
      callsOf(["objects.tree"]),
    );
    const narrowedAway = await sessionOf(
      implOf(async () => ({ handle, refine: { calls: { objects: { tree: NOT } } } }), log),
      callsOf(["objects.tree"]),
    );
    const notOffering = await sessionOf(
      implOf(async () => ({ handle }), log),
      callsOf(),
    );
    const unmodelled = await openContractSession(
      implOf(async () => ({ handle }), log),
      contextOf(),
      { calls: callsOf(), maintenance: MAINTENANCE, panels: PANELS },
      onLate,
    );

    expect(offering.objectModel).toBe(MODEL);
    // A session that offers no tree reads no model, so it states none, whether a refinement withdrew the tree or the
    // package never offered it.
    expect(Object.hasOwn(narrowedAway, "objectModel")).toBe(false);
    expect(Object.hasOwn(notOffering, "objectModel")).toBe(false);
    expect(unmodelled.kind === "opened" && Object.hasOwn(unmodelled.session, "objectModel")).toBe(false);

    // The host core holds the package's tree call to that model: an unstated kind never reaches the package.
    const core = createHostCore();
    const ports = { late: onLate };
    const before = log.length;
    const refused = await core.treeCall(
      offering,
      { action: "list", container: [randomUUID()], kind: randomUUID() },
      callContext(),
      ports,
    );
    expect(refused).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "request-kind-not-stated", pointer: "/kind" }],
    });
    expect(log.length).toBe(before);
    expect(
      (await core.treeCall(offering, { action: "list", container: [randomUUID()], kind: "item" }, callContext(), ports))
        .kind,
    ).toBe("answered");
    expect(log.slice(before).map(({ name }) => name)).toEqual(["tree"]);
  });

  test("a package session that offers objects.source binds it with its handle first and states its declaration's object model", async () => {
    const handle = { session: randomUUID() };
    const log: Recorded[] = [];
    const offering = await sessionOf(
      implOf(async () => ({ handle }), log),
      callsOf(["objects.source"]),
    );
    const withdrawn = await sessionOf(
      implOf(async () => ({ handle, refine: { calls: { objects: { source: NOT } } } }), log),
      callsOf(["objects.tree", "objects.source"]),
    );
    const neither = await sessionOf(
      implOf(async () => ({ handle }), log),
      callsOf(),
    );

    // The model is stated where either object facet is offered, and the source member only where source is.
    expect(offering.objectModel).toBe(MODEL);
    expect(Object.hasOwn(offering, "tree")).toBe(false);
    expect(withdrawn.objectModel).toBe(MODEL);
    expect(Object.hasOwn(withdrawn, "source")).toBe(false);
    expect(Object.hasOwn(withdrawn, "tree")).toBe(true);
    expect(Object.hasOwn(neither, "objectModel")).toBe(false);
    expect(Object.hasOwn(neither, "source")).toBe(false);

    const request = { path: [randomUUID()], kind: "item" };
    const ctx = callContext();
    await offering.source?.(request, ctx);
    expect(log.map(({ name }) => name)).toEqual(["open", "open", "open", "source"]);
    expect(log.at(-1)).toEqual({ name: "source", self: true, args: [handle, request, ctx] });
  });

  test("a refinement narrows the calls and the maintenance; a widening one is refused and the handle is closed under a cleanup context", async () => {
    const handle = { session: randomUUID() };
    const narrowed = await sessionOf(
      implOf(async () => ({ handle, refine: { calls: { console: { cancel: NOT } } } }), []),
      callsOf(["console.cancel"]),
    );
    expect(narrowed.calls.console.cancel).toBe(NOT);
    expect(Object.hasOwn(narrowed, "cancel")).toBe(false);

    const kill = {
      operation: "kill",
      perEntity: true,
      global: false,
      kinds: null,
      preview: false,
    };
    const withMaintenance = { maintenance: ["kill"], maintenanceSpecs: [kill] } as unknown as EngineMaintenance;
    const accepted = await openContractSession(
      implOf(
        async () => ({ handle, refine: { maintenance: [{ operation: "kill", perEntity: false, global: false }] } }),
        [],
      ),
      contextOf(),
      { ...declared(callsOf()), maintenance: withMaintenance },
      onLate,
    );
    expect(accepted.kind === "opened" && accepted.session.maintenance.maintenance).toEqual([]);

    for (const refine of [
      { calls: { console: { cancel: OFFERED } } },
      { maintenance: [{ operation: "kill", perEntity: true, global: true }] },
      { unknownKey: true },
    ]) {
      const log: Recorded[] = [];
      const start = Date.now();
      const record = await openContractSession(
        implOf(async () => ({ handle, refine }), log),
        contextOf(),
        declared(callsOf()),
        onLate,
      );
      expect(record.kind).toBe("refused");
      if (record.kind !== "refused") return;
      expect(record.called).toBe(true);
      expect(record.refusals.length).toBeGreaterThan(0);
      const close = log.find(({ name }) => name === "close");
      expect(log.filter(({ name }) => name === "close")).toHaveLength(1);
      expect(close?.args[0]).toBe(handle);
      const cleanup = close?.args[1] as CallContext;
      expect(cleanup.deadline).toBeGreaterThanOrEqual(start + CLEANUP_DEADLINE_MS);
    }

    const getter = await openContractSession(
      implOf(async () => {
        const answer = { handle };
        Object.defineProperty(answer, "refine", { get: () => ({}), enumerable: true });
        return answer;
      }, []),
      contextOf(),
      declared(callsOf()),
      onLate,
    );
    expect(getter).toMatchObject({ kind: "refused", called: true, refusals: [{ rule: "refinement-unreadable" }] });
  });

  test("the host core's execute, cancel, endScope, tree, source, panel, pool statistics and health run on the session unchanged", async () => {
    const core = createHostCore();
    const log: Recorded[] = [];
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const all = [
      "console.cancel",
      "console.endScope",
      "objects.tree",
      "objects.source",
      "monitoring.panel",
      "monitoring.poolStats",
    ];
    // The one kind states its source here, so the host core admits a source call for it (clause C-115).
    const sourced: ObjectModel = {
      ...MODEL,
      objectKinds: [
        { ...MODEL.objectKinds[0], hasSource: true, sourceLanguage: "sql" } as ObjectModel["objectKinds"][number],
      ],
    };
    const opened = await openContractSession(
      implOf(async () => ({ handle: 1 }), log),
      contextOf(),
      { ...declared(callsOf(all)), objectModel: sourced },
      onLate,
    );
    if (opened.kind !== "opened") throw new Error(`the open answered ${opened.kind}`);
    const { session } = opened;
    const ports = { late: onLate, cancelFailed: onLate };
    const limits = () => ({ maxRows: 2, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES });

    const page = await core.executeCall(
      session,
      { statement: "list", page: { limit: 2, offset: 0 } },
      callContext(),
      limits,
      ports,
    );
    expect(page.kind).toBe("page");
    if (page.kind !== "page") return;
    expect(page.page.rows).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    page.release();

    expect(await core.endScopeCall(session, { scope: "s1" }, callContext(), ports)).toEqual({
      kind: "answered",
      openTransaction: "none",
    });
    expect((await core.treeCall(session, { action: "containers" } as never, callContext(), ports)).kind).toBe(
      "answered",
    );
    const path = [randomUUID(), randomUUID()];
    const source = await core.sourceCall(session, { path, kind: "item" }, callContext(), ports);
    expect(source.kind === "answered" && source.answer.path).toEqual(path);
    expect(log.filter(({ name }) => name === "source").map(({ args }) => args[0])).toEqual([1]);
    const panel = await core.panelCall(session, { panel: "overview" }, callContext(), ports);
    expect(panel.kind === "answered" && panel.answer).toBe(OVERVIEW);
    expect((await core.poolStatsCall(session, callContext(), ports)).kind).toBe("answered");
    const health = await core.healthCall(session, callContext(), ports);
    expect(health.kind === "answered" && health.answer).toBe(HEALTH);

    // A stopped execute sends the run's cancel on the session.
    const waiting = await sessionOf(
      implOf(
        async () => ({ handle: 2 }),
        log,
        () => {
          started();
          return new Promise<never>(() => undefined);
        },
      ),
      callsOf(all),
    );
    const caller = new AbortController();
    const stopped = core.executeCall(
      waiting,
      { statement: "slow", runId: "run-1", page: { limit: 2, offset: 0 } },
      callContext(caller.signal),
      limits,
      ports,
    );
    await running;
    caller.abort(new Error(randomUUID()));
    expect((await stopped).kind).toBe("stopped");
    expect(log.filter(({ name }) => name === "cancel").map(({ args }) => args.slice(0, 2))).toEqual([
      [2, { runId: "run-1" }],
    ]);
  });

  test("an open answer with no handle throws by name, and one that arrives after the stop is closed once and never answered", async () => {
    for (const answer of [
      {},
      null,
      new (class Answer {})(),
      {
        get handle() {
          return 1;
        },
      },
    ]) {
      const error = await openContractSession(
        implOf(async () => answer, []),
        contextOf(),
        declared(callsOf()),
        onLate,
      ).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        "The provider package's open answered no session handle, a defect of the package.",
      );
    }

    const log: Recorded[] = [];
    const versioned = await openContractSession(
      implOf(async () => ({ handle: 3, serverVersion: 7 }), log),
      contextOf(),
      declared(callsOf()),
      onLate,
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect((versioned as Error).message).toBe(
      "The provider package's open answered a serverVersion that is not text, a defect of the package.",
    );
    expect(log.map(({ name }) => name)).toEqual(["open", "close"]);

    let answerLate!: (value: unknown) => void;
    const lateLog: Recorded[] = [];
    const controller = new AbortController();
    const opening = openContractSession(
      implOf(
        () =>
          new Promise((resolve) => {
            answerLate = resolve;
          }),
        lateLog,
      ),
      contextOf(controller.signal),
      declared(callsOf()),
      onLate,
    );
    const reason = new Error(randomUUID());
    controller.abort(reason);
    const record = await opening;
    expect(record.kind).toBe("stopped");
    if (record.kind !== "stopped") return;
    expect(record.reason).toBe(reason);
    const handle = { session: randomUUID() };
    answerLate({ handle });
    await record.settled;
    expect(lateLog.filter(({ name }) => name === "close").map(({ args }) => args[0])).toEqual([handle]);

    let failLate!: (error: unknown) => void;
    const failing = new AbortController();
    const failed = openContractSession(
      implOf(
        () =>
          new Promise((_, reject) => {
            failLate = reject;
          }),
        [],
      ),
      contextOf(failing.signal),
      declared(callsOf()),
      onLate,
    );
    failing.abort(new Error(randomUUID()));
    const stopped = await failed;
    const failure = new Error(randomUUID());
    failLate(failure);
    if (stopped.kind === "stopped") await stopped.settled;
    expect(late).toContain(failure);
  });

  test("a close of a handle Studio does not admit that fails or is cut reaches the late port, and the open still answers", async () => {
    const failure = new Error(randomUUID());
    const widening = async () => ({ handle: 5, refine: { calls: { console: { cancel: OFFERED } } } });
    const failed = await openContractSession(
      implOf(widening, [], undefined, () => Promise.reject(failure)),
      contextOf(),
      declared(callsOf()),
      onLate,
    );
    expect(failed.kind).toBe("refused");
    expect(late).toContain(failure);

    jest.useFakeTimers();
    try {
      let closing!: () => void;
      const called = new Promise<void>((resolve) => {
        closing = resolve;
      });
      const cut: unknown[] = [];
      const opening = openContractSession(
        implOf(widening, [], undefined, () => {
          closing();
          return new Promise<void>(() => undefined);
        }),
        contextOf(),
        declared(callsOf()),
        (error) => cut.push(error),
      );
      await called;
      jest.advanceTimersByTime(CLEANUP_DEADLINE_MS);
      expect((await opening).kind).toBe("refused");
      expect((cut as Error[]).map(({ message }) => message)).toEqual([
        `The provider package's close of a session Studio did not admit did not answer within ${CLEANUP_DEADLINE_MS} ms.`,
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an open refused at its start calls nothing", async () => {
    const log: Recorded[] = [];
    const passed = { ...contextOf(), deadline: Date.now() - 1 };
    const record = await openContractSession(
      implOf(async () => ({ handle: 1 }), log),
      passed,
      declared(callsOf()),
      onLate,
    );
    expect(record).toMatchObject({ kind: "refused", called: false, refusals: [{ rule: "call-deadline-passed" }] });

    const reason = new Error(randomUUID());
    const aborted = new AbortController();
    aborted.abort(reason);
    const left = await openContractSession(
      implOf(async () => ({ handle: 1 }), log),
      contextOf(aborted.signal),
      declared(callsOf()),
      onLate,
    );
    expect(left).toMatchObject({ kind: "refused", called: false, cause: reason });
    expect(log).toEqual([]);
  });
});
