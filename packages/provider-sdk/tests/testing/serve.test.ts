/**
 * `serve` puts a provider module record behind the memory test transport (docs/providers/CONTRACT.md, clauses C-19 and
 * C-22 to C-24): every call crosses as one request frame and one answer frame through the value codec, the provider
 * receives decoded, frozen copies, the host receives decoded copies, and a session handle or a result source never
 * crosses.
 *
 * Each case serves a fixture module `defineProvider` built over the minimal manifest, records what the implementation
 * received and what the observer saw, and asserts on both. Every planted value is generated at run time. A call's
 * failure is captured with a plain `await` inside `failure`, never asserted with `.rejects`.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  awaitWithin,
  type BatchLimit,
  type CallContext,
  type CallRefusal,
  CallRefusalError,
  CLEANUP_DEADLINE_MS,
  checkProviderModule,
  deadlineSignal,
  defineProvider,
  encodedRowBytes,
  envReader,
  type ExecuteAnswer,
  type ExecuteRequest,
  type HealthInfo,
  type LateOutcome,
  type MaintenancePreview,
  type MaintenancePreviewRequest,
  type MaintenanceRunAnswer,
  type MaintenanceRunRequest,
  type MonitoringPanelAnswer,
  type MonitoringPanelRequest,
  type OpenAnswer,
  type OpenContext,
  PAGE_MAX_BYTES,
  ProviderDefinitionError,
  type ProviderImpl,
  type ProviderModule,
  pumpPage,
  type ResultSource,
  type RowBatch,
  rowsSource,
  type TransactionAnswer,
  type TransactionRequest,
  type TreeAnswer,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";
import { FrameRefusalError, type ServedFrame, type ServedHandle, serve } from "@libredb/provider-sdk/testing";
import { ValueCodecError } from "@libredb/provider-sdk/values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a draft each case bends into a shape the transport refuses.
type Json = Record<string, any>;

const marker = (): string => randomUUID();

interface Seen {
  readonly call: string;
  readonly handle?: unknown;
  readonly request?: unknown;
  readonly ctx?: CallContext;
}

interface ProviderHandle {
  readonly marker: string;
}

interface Fixture {
  readonly module: ProviderModule;
  readonly seen: Seen[];
  readonly handle: ProviderHandle;
  /** What each call answers, changed by a case before it calls. */
  readonly answers: Json;
}

/** A relation kind `id`, every member written out as a declaration states it. */
function objectKind(id: string): Json {
  return {
    id,
    role: "relation",
    label: id,
    labelPlural: id,
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
  };
}

/** The fixture engine's object model: one container level, addressed exactly, holding the kinds `table` and `view`. */
function objectModel(): Json {
  return {
    containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
    containerPathShapes: "exact",
    containerNameSpelling: null,
    objectKinds: [objectKind("table"), objectKind("view")],
    rowActions: [],
    containersNameKinds: false,
    tablesNeedContainer: false,
    tablesAreDerivedGroupings: false,
    agentWalkScope: null,
    schemaDiffScope: null,
    maskedNameKinds: [],
  };
}

/** A provider module over the minimal manifest: honours both fields, offers every facet unless told otherwise. */
function fixture(
  options: {
    readonly cancel?: boolean;
    readonly endScope?: boolean;
    readonly transaction?: boolean;
    readonly tree?: boolean;
    readonly run?: boolean;
    readonly preview?: boolean;
    readonly panel?: boolean;
    readonly poolStats?: boolean;
    readonly honours?: string[];
    /** Whether the engine offers the overview and the table statistics panels, and no other. */
    readonly offersPanels?: boolean;
    /** Whether the engine lists maintenance: vacuum and analyze on a row and whole, kill on neither, release on a row. */
    readonly listsMaintenance?: boolean;
    /** Whether the engine states its object model: one level and the kinds `table` and `view`; true by default. */
    readonly statesModel?: boolean;
  } = {},
): Fixture {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "../fixtures/minimal-manifest.json"), "utf8"));
  manifest.calls.console.execute.honours = options.honours ?? ["params", "offset"];
  manifest.calls.console.cancel = options.cancel === false ? "not-offered" : "offered";
  manifest.calls.console.endScope = options.endScope === false ? "not-offered" : "offered";
  manifest.calls.console.transaction = options.transaction === false ? "not-offered" : "offered";
  manifest.calls.objects.tree = options.tree === false ? "not-offered" : "offered";
  manifest.calls.maintenance.run = options.run === false ? "not-offered" : "offered";
  manifest.calls.maintenance.preview = options.preview === false ? "not-offered" : "offered";
  manifest.calls.monitoring.panel = options.panel === false ? "not-offered" : "offered";
  manifest.calls.monitoring.poolStats = options.poolStats === false ? "not-offered" : "offered";
  manifest.engines[0].facets.monitoring.overview = options.offersPanels === true ? "offered" : "not-offered";
  manifest.engines[0].facets.monitoring.tables = options.offersPanels === true ? "offered" : "not-offered";
  if (options.statesModel !== false) manifest.engines[0].objects = objectModel();
  if (options.listsMaintenance === true) {
    const placed: [string, boolean, boolean, boolean][] = [
      ["vacuum", true, true, false],
      ["analyze", true, true, false],
      ["kill", false, false, false],
      ["release", true, false, options.preview !== false],
    ];
    manifest.engines[0].facets.maintenance = placed.map(([operation]) => operation);
    manifest.engines[0].facets.maintenanceSpecs = placed.map(([operation, perEntity, global, preview]) => ({
      operation,
      label: operation,
      perEntity,
      global,
      title: null,
      description: null,
      confirmation: null,
      preview,
      kinds: null,
    }));
  }
  const seen: Seen[] = [];
  const handle: ProviderHandle = { marker: marker() };
  const answers: Json = {
    open: () => ({ handle, serverVersion: marker() }),
    close: () => undefined,
    health: () => ({ databaseSize: "0 B", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] }),
    execute: () => ({
      results: [
        rowsSource(
          [{ name: "id" }, { name: "label" }],
          [
            [1, marker()],
            [2, marker()],
          ],
          2,
        ),
      ],
      warnings: [{ message: marker(), code: 1 }],
      executionTimeMs: 3,
      pageApplied: false,
      explainPlan: { plan: [marker()] },
    }),
    cancel: () => ({ cancelled: true }),
    endScope: () => ({ openTransaction: "none" }),
    transaction: () => ({ sessionState: "in-transaction" }),
    tree: () => ({ containers: [] }),
    run: () => ({ success: true, executionTime: 1, message: marker() }),
    preview: () => ({ summary: marker(), facts: [] }),
    panel: () => ({ storage: [] }),
    poolStats: () => ({ total: 1, idle: 1, active: 0, waiting: 0 }),
  };
  const impl: Json = {
    open: async (ctx: OpenContext) => {
      seen.push({ call: "open", ctx });
      return answers.open();
    },
    close: async (h: unknown, ctx: CallContext) => {
      seen.push({ call: "close", handle: h, ctx });
      return answers.close();
    },
    health: async (h: unknown, ...rest: unknown[]) => {
      seen.push({ call: "health", handle: h, ctx: rest[0] as CallContext, request: rest.slice(1) });
      return answers.health();
    },
    console: {
      execute: async (h: unknown, request: unknown, ctx: CallContext) => {
        seen.push({ call: "console.execute", handle: h, request, ctx });
        return answers.execute();
      },
    },
  };
  if (options.cancel !== false) {
    impl.console.cancel = async (h: unknown, request: unknown, ctx: CallContext) => {
      seen.push({ call: "console.cancel", handle: h, request, ctx });
      return answers.cancel();
    };
  }
  if (options.endScope !== false) {
    impl.console.endScope = async (h: unknown, request: unknown, ctx: CallContext) => {
      seen.push({ call: "console.endScope", handle: h, request, ctx });
      return answers.endScope();
    };
  }
  if (options.transaction !== false) {
    impl.console.transaction = async (h: unknown, request: unknown, ctx: CallContext) => {
      seen.push({ call: "console.transaction", handle: h, request, ctx });
      return answers.transaction();
    };
  }
  if (options.tree !== false) {
    impl.objects = {
      tree: async (h: unknown, request: unknown, ctx: CallContext) => {
        seen.push({ call: "objects.tree", handle: h, request, ctx });
        return answers.tree();
      },
    };
  }
  const maintenance: Json = {};
  if (options.run !== false) {
    maintenance.run = async (h: unknown, request: unknown, ctx: CallContext) => {
      seen.push({ call: "maintenance.run", handle: h, request, ctx });
      return answers.run();
    };
  }
  if (options.preview !== false) {
    maintenance.preview = async (h: unknown, request: unknown, ctx: CallContext) => {
      seen.push({ call: "maintenance.preview", handle: h, request, ctx });
      return answers.preview();
    };
  }
  impl.maintenance = maintenance;
  const monitoring: Json = {};
  if (options.panel !== false) {
    monitoring.panel = async (h: unknown, request: unknown, ctx: CallContext) => {
      seen.push({ call: "monitoring.panel", handle: h, request, ctx });
      return answers.panel();
    };
  }
  if (options.poolStats !== false) {
    monitoring.poolStats = async (h: unknown, ...rest: unknown[]) => {
      seen.push({ call: "monitoring.poolStats", handle: h, ctx: rest[0] as CallContext, request: rest.slice(1) });
      return answers.poolStats();
    };
  }
  impl.monitoring = monitoring;
  return { module: defineProvider(manifest, impl as ProviderImpl<unknown>), seen, handle, answers };
}

function openContext(controller = new AbortController()): OpenContext {
  return {
    deadline: Date.now() + 60_000,
    signal: controller.signal,
    env: envReader([], () => undefined),
    engine: "exampledb",
    connectionId: marker(),
    connection: { host: marker(), port: 7000, user: marker(), password: marker(), allowInsecureAuth: false },
    tls: { mode: "verify-full", caCert: marker() },
    egress: { blocksPrivateHosts: true, source: "default" },
    trust: { certificates: [marker()] },
    policy: {
      readOnly: false,
      sendsStatements: true,
      allowExternalFileAccess: false,
      refuseWrites: false,
      managed: false,
      literalSeedFile: false,
    },
  };
}

function callContext(controller = new AbortController()): CallContext {
  return { deadline: Date.now() + 60_000, signal: controller.signal, env: envReader([], () => undefined) };
}

function request(change: (draft: Json) => void = () => {}): ExecuteRequest {
  const draft: Json = { statement: `select ${marker()}`, page: { limit: 500, offset: 0 } };
  change(draft);
  return draft as ExecuteRequest;
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

/** A served instance of `fx` with an observer that records every frame. */
function served(fx: Fixture): { readonly impl: ProviderImpl<ServedHandle>; readonly frames: ServedFrame[] } {
  const frames: ServedFrame[] = [];
  return { impl: serve(fx.module, { observe: (frame) => frames.push(frame) }), frames };
}

/** Whether `value` and every plain object and array it holds are frozen. */
function deepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null || value instanceof Uint8Array || value instanceof Date) return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

/** `ctx` without its host services, as a frame carries it. */
function dataOf(ctx: CallContext): Json {
  return Object.fromEntries(Object.entries(ctx).filter(([key]) => key !== "signal" && key !== "env"));
}

/** A pull's limit as a host passes it by hand, with `encodedRowBytes` as its measure. */
function limitOf(maxRows: number, maxBytes: number): BatchLimit {
  return { maxRows, maxBytes, measure: encodedRowBytes };
}

/** `ctx` with its deadline already past. */
function past<C extends CallContext>(ctx: C): C {
  return { ...ctx, deadline: Date.now() - 1 };
}

/** A late handler that records each outcome and resolves `first` with the first one. */
function lateHandler<T>(): {
  readonly late: (outcome: LateOutcome<T>) => void;
  readonly calls: LateOutcome<T>[];
  readonly first: Promise<LateOutcome<T>>;
} {
  const calls: LateOutcome<T>[] = [];
  const { promise, resolve } = Promise.withResolvers<LateOutcome<T>>();
  return {
    late: (outcome) => {
      calls.push(outcome);
      resolve(outcome);
    },
    calls,
    first: promise,
  };
}

/** A source over one row that counts its closes. */
function countedSource(): { readonly source: ResultSource; readonly closes: () => number } {
  let closes = 0;
  const inner = rowsSource([{ name: "id" }, { name: "label" }], [[1, marker()]], 1);
  return {
    source: {
      columns: inner.columns,
      next: (limit: BatchLimit) => inner.next(limit),
      close: async () => {
        closes += 1;
        await inner.close();
      },
    },
    closes: () => closes,
  };
}

describe("serve", () => {
  test("a served module answers every call through one request frame and one answer frame", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);

    const opened = await impl.open(openContext());
    const answer = await impl.console.execute(opened.handle, request(), callContext());
    await impl.console.cancel?.(opened.handle, { runId: marker() }, callContext());
    await impl.console.endScope?.(opened.handle, { scope: marker() }, callContext());
    const source = answer.results[0] as ResultSource;
    await source.next(limitOf(10, 1024));
    await source.close();
    await impl.close(opened.handle, callContext());

    expect(frames.map((frame) => `${frame.direction} ${frame.call}`)).toEqual(
      ["open", "console.execute", "console.cancel", "console.endScope", "result.next", "result.close", "close"].flatMap(
        (call) => [`to-provider ${call}`, `to-host ${call}`],
      ),
    );
    for (const frame of frames) {
      expect(Object.isFrozen(frame)).toBe(true);
      expect(typeof JSON.parse(frame.text)).toBe("object");
    }
  });

  test("the provider receives decoded copies, frozen at every depth, with the host's signal and environment reader by reference", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    const controller = new AbortController();
    const ctx = openContext(controller);
    const sent = request((r) => (r.params = [new Uint8Array([1, 2]), new Date(0), { nested: [marker()] }]));

    const opened = await impl.open(ctx);
    await impl.console.execute(opened.handle, sent, callContext(controller));
    const [atOpen, atExecute] = fx.seen as [Seen, Seen];

    expect(dataOf(atOpen.ctx as CallContext)).toEqual(dataOf(ctx));
    expect(atOpen.ctx).not.toBe(ctx);
    expect(Object.values(dataOf(atOpen.ctx as CallContext)).every(deepFrozen)).toBe(true);
    expect(Object.isFrozen(atOpen.ctx)).toBe(true);
    expect(atOpen.ctx?.signal).toBe(ctx.signal);
    expect(atOpen.ctx?.env).toBe(ctx.env);
    expect(atExecute.request).toEqual(sent);
    expect(atExecute.request).not.toBe(sent);
    expect(deepFrozen(atExecute.request)).toBe(true);
    controller.abort();
    expect(atOpen.ctx?.signal.aborted).toBe(true);
    expect(atExecute.ctx?.signal.aborted).toBe(true);
  });

  test("the host's own context and request are left as the host built them, and the host receives decoded copies of each answer", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    const ctx = openContext();
    const sent = request((r) => (r.params = [marker()]));
    const provided = fx.answers.execute();
    fx.answers.execute = () => provided;
    const openAnswer = { handle: fx.handle, serverVersion: marker() };
    fx.answers.open = () => openAnswer;

    const opened = await impl.open(ctx);
    const answer = await impl.console.execute(opened.handle, sent, callContext());
    const cancelAnswer = { cancelled: false };
    fx.answers.cancel = () => cancelAnswer;
    const cancelled = await impl.console.cancel?.(opened.handle, { runId: marker() }, callContext());

    expect(Object.isFrozen(ctx)).toBe(false);
    expect(Object.isFrozen(ctx.connection)).toBe(false);
    expect(Object.isFrozen(sent)).toBe(false);
    expect(Object.isFrozen(sent.params)).toBe(false);
    expect(opened.serverVersion).toBe(openAnswer.serverVersion);
    expect(Object.keys(opened).sort()).toEqual(["handle", "serverVersion"]);
    expect(answer.warnings).toEqual(provided.warnings);
    expect(answer.warnings).not.toBe(provided.warnings);
    expect(answer.explainPlan).toEqual(provided.explainPlan);
    expect(answer.explainPlan).not.toBe(provided.explainPlan);
    expect({ ...answer, results: [] }).toEqual({ ...provided, results: [] });
    expect(cancelled).toEqual(cancelAnswer);
    expect(cancelled).not.toBe(cancelAnswer);
  });

  test("a value the codec cannot carry, or a frame key the call does not define, fails the call before the provider is called", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    const opened = await impl.open(openContext());
    const executes = () => fx.seen.filter((item) => item.call === "console.execute").length;

    const optionalUndefined = await failure(() =>
      impl.console.execute(
        opened.handle,
        request((r) => (r.runId = undefined)),
        callContext(),
      ),
    );
    const map = await failure(() =>
      impl.console.execute(
        opened.handle,
        request((r) => (r.params = [new Map()])),
        callContext(),
      ),
    );
    const extra = await failure(() =>
      impl.console.execute(
        opened.handle,
        request((r) => (r.extra = marker())),
        callContext(),
      ),
    );
    const dropped = await failure(() =>
      impl.console.execute(
        opened.handle,
        request((r) => (r.params = Object.assign([1], { note: marker() }))),
        callContext(),
      ),
    );
    const extraContext = await failure(() =>
      impl.close(opened.handle, { ...callContext(), extra: 1 } as unknown as CallContext),
    );

    // The codec leaves an undefined member out (V-9), so the round trip refuses the member it dropped.
    expect(optionalUndefined).toBeInstanceOf(FrameRefusalError);
    expect((optionalUndefined as FrameRefusalError).refusals).toEqual([
      { rule: "round-trip-changed", call: "console.execute", part: "request", pointer: "/runId" },
    ]);
    expect(map).toBeInstanceOf(ValueCodecError);
    expect((map as ValueCodecError).path).toBe("/params/0");
    expect(extra).toBeInstanceOf(FrameRefusalError);
    expect((extra as FrameRefusalError).refusals).toEqual([
      { rule: "frame-key-unknown", call: "console.execute", part: "request", pointer: "/extra", name: "extra" },
    ]);
    expect((dropped as FrameRefusalError).refusals).toEqual([
      { rule: "round-trip-changed", call: "console.execute", part: "request", pointer: "/params" },
    ]);
    expect((extraContext as FrameRefusalError).refusals).toEqual([
      { rule: "frame-key-unknown", call: "close", part: "context", pointer: "/extra", name: "extra" },
    ]);
    expect(executes()).toBe(0);
    expect(fx.seen.filter((item) => item.call === "close")).toEqual([]);
  });

  test("an error a call or a source throws reaches the host as the same object", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    const thrown = new Error(marker());
    const opened = await impl.open(openContext());
    const source: ResultSource = {
      columns: [{ name: "id" }],
      next: async () => {
        throw thrown;
      },
      close: async () => {
        throw thrown;
      },
    };
    fx.answers.execute = () => ({ results: [source], warnings: [], executionTimeMs: 0, pageApplied: false });
    const answer = await impl.console.execute(opened.handle, request(), callContext());
    const servedSource = answer.results[0] as ResultSource;
    fx.answers.open = () => {
      throw thrown;
    };
    fx.answers.cancel = () => {
      throw thrown;
    };

    expect(await failure(() => impl.open(openContext()))).toBe(thrown);
    expect(await failure(() => servedSource.next(limitOf(1, 1)))).toBe(thrown);
    expect(await failure(() => servedSource.close())).toBe(thrown);
    expect(await failure(async () => impl.console.cancel?.(opened.handle, { runId: marker() }, callContext()))).toBe(
      thrown,
    );
  });

  test("the session handle and each result source stay in the served instance's tables, and only their ids cross", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const provided = fx.answers.execute();
    fx.answers.execute = () => provided;

    const opened = await impl.open(openContext());
    const answer = await impl.console.execute(opened.handle, request(), callContext());
    const source = answer.results[0] as ResultSource;
    await source.next(limitOf(10, 1024));
    await impl.close(opened.handle, callContext());
    const executeAnswer = JSON.parse((frames[3] as ServedFrame).text);

    for (const frame of frames) expect(frame.text).not.toContain(fx.handle.marker);
    expect(opened.handle).not.toBe(fx.handle);
    expect(Object.isFrozen(opened.handle)).toBe(true);
    expect(Object.keys(opened.handle)).toEqual(["session"]);
    expect(JSON.parse((frames[0] as ServedFrame).text).session).toBeUndefined();
    expect(JSON.parse((frames[1] as ServedFrame).text).session).toBe(opened.handle.session);
    expect(fx.seen.filter((item) => item.call !== "open").map((item) => item.handle)).toEqual([fx.handle, fx.handle]);
    expect(fx.seen[1]?.handle).toBe(fx.handle);
    expect(fx.seen[2]?.handle).toBe(fx.handle);
    expect(source).not.toBe(provided.results[0]);
    expect(Object.isFrozen(source)).toBe(true);
    expect(source.columns).toEqual(provided.results[0].columns);
    expect(source.rowCount).toBe(2);
    expect(Object.keys(executeAnswer.answer.results[0]).sort()).toEqual(["columns", "result", "rowCount"]);
    expect(JSON.parse((frames[4] as ServedFrame).text).result).toBe(executeAnswer.answer.results[0].result);
  });

  test("a closed or foreign session token is refused as session-not-open before any frame", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const copy = { ...opened.handle };
    const other = await serve(fx.module).open(openContext());
    await impl.close(opened.handle, callContext());
    const before = frames.length;

    const closed = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    const copied = await failure(() => impl.close(copy, callContext()));
    const foreign = await failure(
      () => impl.console.endScope?.(other.handle, { scope: marker() }, callContext()) as Promise<unknown>,
    );
    const closedHealth = await failure(() => impl.health(opened.handle, callContext()));
    const foreignHealth = await failure(() => impl.health(other.handle, callContext()));

    expect((closed as FrameRefusalError).refusals).toEqual([
      { rule: "session-not-open", call: "console.execute", part: "handle", pointer: "" },
    ]);
    expect((copied as FrameRefusalError).refusals).toEqual([
      { rule: "session-not-open", call: "close", part: "handle", pointer: "" },
    ]);
    expect((foreign as FrameRefusalError).refusals).toEqual([
      { rule: "session-not-open", call: "console.endScope", part: "handle", pointer: "" },
    ]);
    for (const refused of [closedHealth, foreignHealth]) {
      expect((refused as FrameRefusalError).refusals).toEqual([
        { rule: "session-not-open", call: "health", part: "handle", pointer: "" },
      ]);
    }
    expect((closed as Error).message).toBe(
      "The session handle at the top level of the console.execute call is not one the served instance holds open, so no frame was sent.",
    );
    expect(frames.length).toBe(before);
  });

  test("a closed result source is refused as result-not-open before any frame", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const answer = await impl.console.execute(opened.handle, request(), callContext());
    const source = answer.results[0] as ResultSource;
    await source.close();
    const before = frames.length;

    const pulled = await failure(() => source.next(limitOf(1, 1024)));
    const closedAgain = await failure(() => source.close());

    expect((pulled as FrameRefusalError).refusals).toEqual([
      { rule: "result-not-open", call: "result.next", part: "handle", pointer: "" },
    ]);
    expect((closedAgain as FrameRefusalError).refusals).toEqual([
      { rule: "result-not-open", call: "result.close", part: "handle", pointer: "" },
    ]);
    expect(frames.length).toBe(before);
  });

  test("a close takes the session out of both tables even when the provider's close throws", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    const thrown = new Error(marker());
    const opened = await impl.open(openContext());
    fx.answers.close = () => {
      throw thrown;
    };

    expect(await failure(() => impl.close(opened.handle, callContext()))).toBe(thrown);
    expect(((await failure(() => impl.close(opened.handle, callContext()))) as FrameRefusalError).refusals).toEqual([
      { rule: "session-not-open", call: "close", part: "handle", pointer: "" },
    ]);
    expect(fx.seen.filter((item) => item.call === "close").map((item) => item.handle)).toEqual([fx.handle]);

    const second = await impl.open(openContext());
    fx.answers.close = () => marker();
    const answered = await failure(() => impl.close(second.handle, callContext()));

    expect((answered as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "close", part: "answer", pointer: "" },
    ]);
    expect(
      ((await failure(() => impl.close(second.handle, callContext()))) as FrameRefusalError).refusals[0]?.rule,
    ).toBe("session-not-open");
  });

  test("a request field or a console facet the session does not offer is refused before any frame", async () => {
    const fx = fixture({ honours: [], endScope: false });
    const { impl, frames } = served(fx);
    fx.answers.open = () => ({ handle: fx.handle, refine: { calls: { console: { cancel: "not-offered" } } } });
    const opened = await impl.open(openContext());
    const before = frames.length;

    const params = await failure(() =>
      impl.console.execute(
        opened.handle,
        request((r) => (r.params = [])),
        callContext(),
      ),
    );
    const scope = await failure(() =>
      impl.console.execute(
        opened.handle,
        request((r) => (r.scope = marker())),
        callContext(),
      ),
    );
    const cancel = await failure(async () => impl.console.cancel?.(opened.handle, { runId: marker() }, callContext()));

    expect(params).toBeInstanceOf(CallRefusalError);
    expect((params as CallRefusalError).refusals).toEqual([
      { rule: "request-field-not-honoured", pointer: "/params", name: "params" },
    ]);
    expect((scope as CallRefusalError).refusals).toEqual([{ rule: "request-scope-not-offered", pointer: "/scope" }]);
    expect((cancel as CallRefusalError).refusals).toEqual([
      { rule: "facet-not-offered", pointer: "/console/cancel", name: "console.cancel" },
    ]);
    expect(impl.console.endScope).toBeUndefined();
    expect(frames.length).toBe(before);
    expect(fx.seen.map((item) => item.call)).toEqual(["open"]);
  });

  test("a read-only execute crosses to a session opened for read-only statements, and every other pairing is refused before any frame", async () => {
    const fx = fixture({ honours: ["params", "offset", "readOnly"] });
    const { impl, frames } = served(fx);
    const policyOf = (readOnly: boolean, sendsStatements: boolean): OpenContext => {
      const ctx = openContext();
      return { ...ctx, policy: { ...ctx.policy, readOnly, sendsStatements } };
    };
    const readOnly = (mode?: "estimate-plan") =>
      request((r) => {
        r.page = { unlimited: true };
        r.readOnly = { budget: { maxRows: 200, maxBytes: 262144 }, ...(mode === undefined ? {} : { mode }) };
      });
    const statements = await impl.open(policyOf(true, true));
    const sent = readOnly("estimate-plan");

    await impl.console.execute(statements.handle, sent, callContext());
    await impl.console.execute(statements.handle, readOnly(), callContext());
    const received = fx.seen.filter((item) => item.call === "console.execute");

    expect(received.map((item) => item.request)).toEqual([
      sent,
      expect.objectContaining({ readOnly: { budget: sent.readOnly?.budget } }),
    ]);
    expect(received[0]?.request).not.toBe(sent);
    expect(deepFrozen(received[0]?.request)).toBe(true);
    const before = frames.length;
    const plain = await failure(() => impl.console.execute(statements.handle, request(), callContext()));
    // Each pairing is opened, refused and then sent a plain execute in turn, so the frames between are its own.
    const refusedOn = async (readOnlyFlag: boolean, sendsStatements: boolean): Promise<unknown> => {
      const opened = await impl.open(policyOf(readOnlyFlag, sendsStatements));
      const opens = frames.length;
      const error = await failure(() => impl.console.execute(opened.handle, readOnly(), callContext()));
      expect(frames.length).toBe(opens);
      await impl.console.execute(opened.handle, request(), callContext());
      return error;
    };
    const notStatements = await refusedOn(false, true);
    const notReadOnly = await refusedOn(true, false);
    const neither = await refusedOn(false, false);

    expect(plain).toBeInstanceOf(CallRefusalError);
    expect((plain as CallRefusalError).refusals).toEqual([{ rule: "request-read-only-missing", pointer: "/readOnly" }]);
    for (const error of [notStatements, notReadOnly, neither]) {
      expect(error).toBeInstanceOf(CallRefusalError);
      expect((error as CallRefusalError).refusals).toEqual([
        { rule: "request-read-only-not-opened", pointer: "/readOnly" },
      ]);
    }
    expect(frames.slice(before, before + 2).map((frame) => frame.call)).toEqual(["open", "open"]);
    expect(fx.seen.filter((item) => item.call === "console.execute")).toHaveLength(5);
  });

  test("a read-only execute to a session whose module does not honour readOnly is refused by the field before any frame", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const ctx = openContext();
    const opened = await impl.open({ ...ctx, policy: { ...ctx.policy, readOnly: true, sendsStatements: true } });
    const before = frames.length;

    const error = await failure(() =>
      impl.console.execute(
        opened.handle,
        request((r) => (r.readOnly = { budget: { maxRows: 1, maxBytes: 1 } })),
        callContext(),
      ),
    );

    expect((error as CallRefusalError).refusals).toEqual([
      { rule: "request-field-not-honoured", pointer: "/readOnly", name: "readOnly" },
    ]);
    expect(frames.length).toBe(before);
    expect(fx.seen.map((item) => item.call)).toEqual(["open"]);
  });

  test("a served transaction call crosses its request and answer as frames, and a statement inside the transaction carries its session state back", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;
    const requests: TransactionRequest[] = [
      { action: "begin", requireReportedState: true },
      { action: "state" },
      { action: "commit" },
      { action: "rollback" },
    ];
    const answers: TransactionAnswer[] = [
      { sessionState: "in-transaction", stateReported: true },
      { sessionState: "unknown" },
      { sessionState: "not-in-transaction" },
      { sessionState: "not-in-transaction" },
    ];
    const received: unknown[] = [];

    for (const [index, sent] of requests.entries()) {
      const answer = answers[index] as TransactionAnswer;
      fx.answers.transaction = () => answer;
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each frame pair and answer is its own call's.
      const got = await impl.console.transaction?.(opened.handle, sent, callContext());
      expect(got).toEqual(answer);
      expect(got).not.toBe(answer);
      received.push(got);
    }
    const plainExecute = fx.answers.execute;
    fx.answers.execute = () => ({ ...plainExecute(), sessionState: "in-transaction" });
    const inTransaction = request((r) => (r.transaction = true));
    const statement = await impl.console.execute(opened.handle, inTransaction, callContext());
    const seen = fx.seen.slice(1);

    expect(received.length).toBe(4);
    expect(frames.slice(before).map((frame) => `${frame.direction} ${frame.call}`)).toEqual(
      [...requests.map(() => "console.transaction"), "console.execute"].flatMap((call) => [
        `to-provider ${call}`,
        `to-host ${call}`,
      ]),
    );
    expect(seen.map((item) => item.call)).toEqual([...requests.map(() => "console.transaction"), "console.execute"]);
    for (const [index, item] of seen.slice(0, 4).entries()) {
      expect(item.handle).toBe(fx.handle);
      expect(item.request).toEqual(requests[index]);
      expect(item.request).not.toBe(requests[index]);
      expect(deepFrozen(item.request)).toBe(true);
      expect(Object.isFrozen(item.ctx)).toBe(true);
    }
    const statementSeen = seen[4] as Seen;
    expect(statementSeen.request).toEqual(inTransaction);
    expect((statementSeen.request as ExecuteRequest).transaction).toBe(true);
    expect(statement.sessionState).toBe("in-transaction");

    fx.answers.transaction = () => ({ sessionState: "maybe" });
    const unreadable = await failure(async () =>
      impl.console.transaction?.(opened.handle, { action: "state" }, callContext()),
    );
    expect((unreadable as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "console.transaction", part: "answer", pointer: "/sessionState" },
    ]);
  });

  test("a transaction call or a statement inside a transaction on a session without console.transaction is refused before any frame", async () => {
    const declaredNot = fixture({ transaction: false });
    const withdrawn = fixture();
    withdrawn.answers.open = () => ({
      handle: withdrawn.handle,
      refine: { calls: { console: { transaction: "not-offered" } } },
    });
    const notServed = served(declaredNot);
    const narrowed = served(withdrawn);
    const declaredSession = await notServed.impl.open(openContext());
    const narrowedSession = await narrowed.impl.open(openContext());
    const before = [notServed.frames.length, narrowed.frames.length];
    const inTransaction = request((r) => (r.transaction = true));

    const declaredStatement = await failure(() =>
      notServed.impl.console.execute(declaredSession.handle, inTransaction, callContext()),
    );
    const narrowedStatement = await failure(() =>
      narrowed.impl.console.execute(narrowedSession.handle, inTransaction, callContext()),
    );
    const narrowedCall = await failure(async () =>
      narrowed.impl.console.transaction?.(narrowedSession.handle, { action: "begin" }, callContext()),
    );

    expect(notServed.impl.console.transaction).toBeUndefined();
    for (const refused of [declaredStatement, narrowedStatement]) {
      expect(refused).toBeInstanceOf(CallRefusalError);
      expect((refused as CallRefusalError).refusals).toEqual([
        { rule: "request-transaction-not-offered", pointer: "/transaction" },
      ]);
    }
    expect((narrowedCall as CallRefusalError).refusals).toEqual([
      { rule: "facet-not-offered", pointer: "/console/transaction", name: "console.transaction" },
    ]);
    expect([notServed.frames.length, narrowed.frames.length]).toEqual(before);
    expect(declaredNot.seen.map((item) => item.call)).toEqual(["open"]);
    expect(withdrawn.seen.map((item) => item.call)).toEqual(["open"]);
  });

  test("a served tree call crosses each action's request and answer as frames, and the provider receives decoded frozen copies", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;
    const container = [marker()];
    const path = [...container, marker()];
    const detail = {
      path,
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true, defaultValue: marker() }],
      indexes: [{ name: marker(), columns: ["id"], unique: true }],
      foreignKeys: [{ columnName: "id", referencedTable: marker(), referencedColumn: "id" }],
    };
    const calls: [TreeRequest, TreeAnswer][] = [
      [{ action: "containers" }, { containers: [{ path: container, name: marker(), level: 0, kinds: ["table"] }] }],
      [{ action: "containers", parent: container }, { containers: [] }],
      [{ action: "count", container }, { counts: { table: { count: 2 }, view: { unavailable: marker() } } }],
      [
        { action: "list", container, kind: "table" },
        { objects: [{ path, name: marker(), kind: "table", readRanges: [{ prefix: marker() }] }] },
      ],
      [{ action: "describe", path, kind: "table" }, { detail: { ...detail, indexes: { unavailable: marker() } } }],
      [
        { action: "describeMany", container, kind: "table", limit: 1, defaultSql: true },
        { details: [detail], truncated: { limit: 1, reason: marker() } },
      ],
    ];
    const received: unknown[] = [];

    for (const [sent, answer] of calls) {
      fx.answers.tree = () => answer;
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each frame pair and answer is its own call's.
      const got = await impl.objects?.tree?.(opened.handle, sent, callContext());
      expect(got).toEqual(answer);
      expect(got).not.toBe(answer);
      received.push(got);
    }
    const seen = fx.seen.slice(1);

    expect(received.length).toBe(calls.length);
    expect(frames.slice(before).map((frame) => `${frame.direction} ${frame.call}`)).toEqual(
      calls.flatMap(() => ["to-provider objects.tree", "to-host objects.tree"]),
    );
    expect(seen.map((item) => item.call)).toEqual(calls.map(() => "objects.tree"));
    for (const [index, item] of seen.entries()) {
      const sent = (calls[index] as [TreeRequest, TreeAnswer])[0];
      expect(item.handle).toBe(fx.handle);
      expect(item.request).toEqual(sent);
      expect(item.request).not.toBe(sent);
      expect(deepFrozen(item.request)).toBe(true);
      expect(Object.isFrozen(item.ctx)).toBe(true);
    }

    fx.answers.tree = () => ({ containers: [], objects: [] });
    const twoForms = await failure(async () =>
      impl.objects?.tree?.(opened.handle, { action: "containers" }, callContext()),
    );
    expect((twoForms as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "objects.tree", part: "answer", pointer: "" },
    ]);
    const unknownAction = await failure(async () =>
      impl.objects?.tree?.(opened.handle, { action: "search" } as unknown as TreeRequest, callContext()),
    );
    expect((unknownAction as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "objects.tree", part: "request", pointer: "/action" },
    ]);
    expect(fx.seen.length).toBe(calls.length + 2);
  });

  test("a containers answer that says the inventory needs configuration crosses as a frame with its sentence", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;
    const answer = { containers: [], needsConfiguration: marker() };
    fx.answers.tree = () => answer;

    const got = await impl.objects?.tree?.(opened.handle, { action: "containers" }, callContext());

    expect(got).toEqual(answer);
    expect(got).not.toBe(answer);
    expect(frames.slice(before).map((frame) => `${frame.direction} ${frame.call}`)).toEqual([
      "to-provider objects.tree",
      "to-host objects.tree",
    ]);
  });

  test("a served tree call naming a level or a kind its engine's object model does not state is refused before any frame", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;
    const unstated = marker();
    const refusedRequests: [TreeRequest, CallRefusal[]][] = [
      [
        { action: "containers", parent: [marker(), marker()] },
        [{ rule: "request-level-not-stated", pointer: "/parent" }],
      ],
      [{ action: "count", container: [] }, [{ rule: "request-level-not-stated", pointer: "/container" }]],
      [
        { action: "list", container: [marker()], kind: unstated },
        [{ rule: "request-kind-not-stated", pointer: "/kind" }],
      ],
      [
        { action: "describeMany", container: [marker(), marker()], kind: "__proto__" },
        [
          { rule: "request-level-not-stated", pointer: "/container" },
          { rule: "request-kind-not-stated", pointer: "/kind" },
        ],
      ],
      [
        { action: "describe", path: [marker()], kind: unstated },
        [{ rule: "request-kind-not-stated", pointer: "/kind" }],
      ],
    ];

    for (const [request, refusals] of refusedRequests) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each refusal is its own call's.
      const refused = await failure(async () => impl.objects?.tree?.(opened.handle, request, callContext()));
      expect(refused).toBeInstanceOf(CallRefusalError);
      expect((refused as CallRefusalError).refusals).toEqual(refusals);
      expect((refused as CallRefusalError).message).not.toContain(unstated);
    }
    expect(frames.length).toBe(before);
    expect(fx.seen.map((item) => item.call)).toEqual(["open"]);

    // A stated request is served.
    fx.answers.tree = () => ({ objects: [] });
    expect(
      await impl.objects?.tree?.(opened.handle, { action: "list", container: [marker()], kind: "view" }, callContext()),
    ).toEqual({ objects: [] });
    expect(fx.seen.map((item) => item.call)).toEqual(["open", "objects.tree"]);
  });

  test("a served tree call on a session offering objects.tree whose engine states no object model is the host's defect, before any frame", async () => {
    const fx = fixture({ statesModel: false });
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;

    const thrown = await failure(async () =>
      impl.objects?.tree?.(opened.handle, { action: "containers" }, callContext()),
    );

    expect(thrown).not.toBeInstanceOf(CallRefusalError);
    expect((thrown as Error).message).toBe(
      "The session offers objects.tree and its engine states no object model, a defect of the host's session.",
    );
    expect(frames.length).toBe(before);
    expect(fx.seen.map((item) => item.call)).toEqual(["open"]);
  });

  test("a tree call on a session without objects.tree is refused before any frame", async () => {
    const declaredNot = fixture({ tree: false });
    const withdrawn = fixture();
    withdrawn.answers.open = () => ({
      handle: withdrawn.handle,
      refine: { calls: { objects: { tree: "not-offered" } } },
    });
    const notServed = served(declaredNot);
    const narrowed = served(withdrawn);
    const narrowedSession = await narrowed.impl.open(openContext());
    const before = narrowed.frames.length;

    const refused = await failure(async () =>
      narrowed.impl.objects?.tree?.(narrowedSession.handle, { action: "containers" }, callContext()),
    );

    expect(notServed.impl.objects?.tree).toBeUndefined();
    expect(refused).toBeInstanceOf(CallRefusalError);
    expect((refused as CallRefusalError).refusals).toEqual([
      { rule: "facet-not-offered", pointer: "/objects/tree", name: "objects.tree" },
    ]);
    expect(narrowed.frames.length).toBe(before);
    expect(withdrawn.seen.map((item) => item.call)).toEqual(["open"]);
  });

  test("a served maintenance call crosses its request and answer as frames, and the provider receives decoded frozen copies", async () => {
    const fx = fixture({ listsMaintenance: true });
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;
    const runs: [MaintenanceRunRequest, MaintenanceRunAnswer][] = [
      [
        { operation: "vacuum", target: marker(), container: marker() },
        { success: true, executionTime: 4, message: marker() },
      ],
      [
        { operation: "analyze" },
        {
          success: true,
          executionTime: 2,
          message: marker(),
          rows: [{ key: marker(), size: 7 }],
          fields: ["key", "size"],
        },
      ],
      [
        { operation: "kill", target: "4711" },
        { success: false, executionTime: 0, message: marker() },
      ],
    ];
    const previewRequest: MaintenancePreviewRequest = { operation: "release", path: [marker(), marker()] };
    const previewAnswer: MaintenancePreview = {
      summary: marker(),
      facts: [{ label: marker(), value: marker() }],
      refusal: marker(),
      note: marker(),
    };

    for (const [sent, answer] of runs) {
      fx.answers.run = () => answer;
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each frame pair and answer is its own call's.
      const got = await impl.maintenance?.run?.(opened.handle, sent, callContext());
      expect(got).toEqual(answer);
      expect(got).not.toBe(answer);
    }
    fx.answers.preview = () => previewAnswer;
    const previewed = await impl.maintenance?.preview?.(opened.handle, previewRequest, callContext());
    const seen = fx.seen.slice(1);

    expect(previewed).toEqual(previewAnswer);
    expect(previewed).not.toBe(previewAnswer);
    expect(frames.slice(before).map((frame) => `${frame.direction} ${frame.call}`)).toEqual([
      ...runs.flatMap(() => ["to-provider maintenance.run", "to-host maintenance.run"]),
      "to-provider maintenance.preview",
      "to-host maintenance.preview",
    ]);
    expect(seen.map((item) => item.call)).toEqual([...runs.map(() => "maintenance.run"), "maintenance.preview"]);
    for (const [index, item] of seen.entries()) {
      const sent =
        index < runs.length ? (runs[index] as [MaintenanceRunRequest, MaintenanceRunAnswer])[0] : previewRequest;
      expect(item.handle).toBe(fx.handle);
      expect(item.request).toEqual(sent);
      expect(item.request).not.toBe(sent);
      expect(deepFrozen(item.request)).toBe(true);
      expect(Object.isFrozen(item.ctx)).toBe(true);
    }

    fx.answers.run = () => ({ success: true, executionTime: 1, message: marker(), columns: [] });
    const unknownKey = await failure(async () =>
      impl.maintenance?.run?.(opened.handle, { operation: "vacuum" }, callContext()),
    );
    expect((unknownKey as FrameRefusalError).refusals).toEqual([
      { rule: "frame-key-unknown", call: "maintenance.run", part: "answer", pointer: "/columns", name: "columns" },
    ]);
    const unreadablePath = await failure(async () =>
      impl.maintenance?.preview?.(
        opened.handle,
        { operation: "release", path: [7] } as unknown as MaintenancePreviewRequest,
        callContext(),
      ),
    );
    expect((unreadablePath as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "maintenance.preview", part: "request", pointer: "/path/0" },
    ]);
    const missingPath = await failure(async () =>
      impl.maintenance?.preview?.(
        opened.handle,
        { operation: "release" } as unknown as MaintenancePreviewRequest,
        callContext(),
      ),
    );
    expect(missingPath).toBeInstanceOf(FrameRefusalError);
    expect((missingPath as FrameRefusalError).refusals).toEqual([
      { rule: "frame-key-missing", call: "maintenance.preview", part: "request", pointer: "/path", name: "path" },
    ]);
    expect(fx.seen.length).toBe(runs.length + 3);
  });

  test("a maintenance call on a session without the facet is refused before any frame", async () => {
    for (const facet of ["run", "preview"] as const) {
      const declaredNot = fixture({ [facet]: false });
      const withdrawn = fixture({ listsMaintenance: true });
      withdrawn.answers.open = () => ({
        handle: withdrawn.handle,
        refine: { calls: { maintenance: { [facet]: "not-offered" } } },
      });
      const notServed = served(declaredNot);
      const narrowed = served(withdrawn);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each case's frames are its own.
      const narrowedSession = await narrowed.impl.open(openContext());
      const before = narrowed.frames.length;
      const call = (): Promise<unknown> | undefined =>
        facet === "run"
          ? narrowed.impl.maintenance?.run?.(narrowedSession.handle, { operation: "vacuum" }, callContext())
          : narrowed.impl.maintenance?.preview?.(
              narrowedSession.handle,
              { operation: "release", path: [marker()] },
              callContext(),
            );

      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each case's frames are its own.
      const refused = await failure(async () => call());

      expect(notServed.impl.maintenance?.[facet]).toBeUndefined();
      expect(refused).toBeInstanceOf(CallRefusalError);
      expect((refused as CallRefusalError).refusals).toEqual([
        { rule: "facet-not-offered", pointer: `/maintenance/${facet}`, name: `maintenance.${facet}` },
      ]);
      expect(narrowed.frames.length).toBe(before);
      expect(withdrawn.seen.map((item) => item.call)).toEqual(["open"]);
    }
  });

  test("a served maintenance call whose request the session's maintenance does not take is refused before any frame", async () => {
    const fx = fixture({ listsMaintenance: true });
    const { impl, frames } = served(fx);
    fx.answers.open = () => ({
      handle: fx.handle,
      refine: { maintenance: [{ operation: "vacuum", perEntity: false, global: true }] },
    });
    const opened = await impl.open(openContext());
    const before = frames.length;
    const cases: [() => Promise<unknown> | undefined, CallRefusal][] = [
      [
        () => impl.maintenance?.run?.(opened.handle, { operation: "optimize" }, callContext()),
        { rule: "request-operation-not-offered", pointer: "/operation" },
      ],
      [
        () =>
          impl.maintenance?.run?.(
            opened.handle,
            { operation: "shrink" } as unknown as MaintenanceRunRequest,
            callContext(),
          ),
        { rule: "request-operation-not-offered", pointer: "/operation" },
      ],
      [
        () => impl.maintenance?.run?.(opened.handle, { operation: "vacuum", target: marker() }, callContext()),
        { rule: "request-placement-not-offered", pointer: "/target" },
      ],
      [
        () => impl.maintenance?.run?.(opened.handle, { operation: "analyze", container: "" }, callContext()),
        { rule: "request-field-empty", pointer: "/container", name: "container" },
      ],
      [
        () => impl.maintenance?.preview?.(opened.handle, { operation: "analyze", path: [marker()] }, callContext()),
        { rule: "request-preview-not-offered", pointer: "/operation" },
      ],
      [
        () => impl.maintenance?.preview?.(opened.handle, { operation: "release", path: [] }, callContext()),
        { rule: "request-field-empty", pointer: "/path", name: "path" },
      ],
    ];

    for (const [call, refusal] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so no frame of one is read as another's.
      const refused = await failure(async () => call());
      expect(refused).toBeInstanceOf(CallRefusalError);
      expect((refused as CallRefusalError).refusals).toEqual([refusal]);
    }
    expect(frames.length).toBe(before);
    expect(fx.seen.map((item) => item.call)).toEqual(["open"]);

    const taken = await impl.maintenance?.run?.(opened.handle, { operation: "vacuum" }, callContext());
    expect(taken?.success).toBe(true);
    expect(fx.seen.map((item) => item.call)).toEqual(["open", "maintenance.run"]);
  });

  test("a served monitoring call crosses its request and answer as frames, and the provider receives decoded frozen copies", async () => {
    const fx = fixture({ offersPanels: true });
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;
    const startTime = new Date(1_700_000_000_000);
    const calls: [MonitoringPanelRequest, MonitoringPanelAnswer][] = [
      [
        { panel: "overview" },
        {
          overview: {
            version: marker(),
            uptime: marker(),
            startTime,
            maxConnections: 0,
            databaseSize: marker(),
            tableCount: 3,
            indexCount: 1,
          },
        },
      ],
      [
        { panel: "tables", schema: marker() },
        {
          tables: [
            {
              schemaName: marker(),
              tableName: marker(),
              totalSize: "8 kB",
              totalSizeBytes: 8192,
              lastAnalyze: new Date(1_700_000_001_000),
            },
          ],
        },
      ],
      [{ panel: "tables" }, { tables: [] }],
    ];
    const pool = { total: 5, idle: 2, active: 3, waiting: 0, max: 10 };

    for (const [sent, answer] of calls) {
      fx.answers.panel = () => answer;
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each frame pair and answer is its own call's.
      const got = await impl.monitoring?.panel?.(opened.handle, sent, callContext());
      expect(got).toEqual(answer);
      expect(got).not.toBe(answer);
    }
    fx.answers.poolStats = () => pool;
    const counted = await impl.monitoring?.poolStats?.(opened.handle, callContext());
    const seen = fx.seen.slice(1);
    const overview = (calls[0] as [MonitoringPanelRequest, { overview: { startTime: Date } }])[1].overview;

    expect(counted).toEqual(pool);
    expect(counted).not.toBe(pool);
    expect(frames.slice(before).map((frame) => `${frame.direction} ${frame.call}`)).toEqual([
      ...calls.flatMap(() => ["to-provider monitoring.panel", "to-host monitoring.panel"]),
      "to-provider monitoring.poolStats",
      "to-host monitoring.poolStats",
    ]);
    expect(Object.keys(JSON.parse((frames.at(-2) as ServedFrame).text)).sort()).toEqual(["call", "context", "session"]);
    expect(overview.startTime).toBe(startTime);
    expect(seen.map((item) => item.call)).toEqual([...calls.map(() => "monitoring.panel"), "monitoring.poolStats"]);
    for (const [index, item] of seen.slice(0, calls.length).entries()) {
      const sent = (calls[index] as [MonitoringPanelRequest, MonitoringPanelAnswer])[0];
      expect(item.handle).toBe(fx.handle);
      expect(item.request).toEqual(sent);
      expect(item.request).not.toBe(sent);
      expect(deepFrozen(item.request)).toBe(true);
      expect(Object.isFrozen(item.ctx)).toBe(true);
    }
    const poolSeen = seen.at(-1) as Seen;
    expect(poolSeen.handle).toBe(fx.handle);
    expect(poolSeen.request).toEqual([]);
    expect(Object.isFrozen(poolSeen.ctx)).toBe(true);

    fx.answers.panel = () => calls[0]?.[1];
    const decoded = (await impl.monitoring?.panel?.(opened.handle, { panel: "overview" }, callContext())) as {
      overview: { startTime: Date };
    };
    expect(decoded.overview.startTime).toBeInstanceOf(Date);
    expect(decoded.overview.startTime).not.toBe(startTime);
    expect(decoded.overview.startTime.getTime()).toBe(startTime.getTime());

    fx.answers.panel = () => ({ overview: { version: marker() }, tables: [] });
    const twoForms = await failure(async () =>
      impl.monitoring?.panel?.(opened.handle, { panel: "overview" }, callContext()),
    );
    expect((twoForms as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "monitoring.panel", part: "answer", pointer: "" },
    ]);
    fx.answers.poolStats = () => ({ total: 1, idle: 1, active: 0, waiting: 0, min: 0 });
    const unknownKey = await failure(async () => impl.monitoring?.poolStats?.(opened.handle, callContext()));
    expect((unknownKey as FrameRefusalError).refusals).toEqual([
      { rule: "frame-key-unknown", call: "monitoring.poolStats", part: "answer", pointer: "/min", name: "min" },
    ]);
    const unreadableLimit = await failure(async () =>
      impl.monitoring?.panel?.(
        opened.handle,
        { panel: "tables", schema: 7 } as unknown as MonitoringPanelRequest,
        callContext(),
      ),
    );
    expect((unreadableLimit as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "monitoring.panel", part: "request", pointer: "/schema" },
    ]);
  });

  test("a monitoring call on a session without the facet, or for a panel its engine does not offer, is refused before any frame", async () => {
    for (const facet of ["panel", "poolStats"] as const) {
      // A package that declares monitoring.panel not-offered cannot list an engine's panel, so only poolStats's has panels.
      const declaredNot = fixture({ [facet]: false, offersPanels: facet === "poolStats" });
      const withdrawn = fixture({ offersPanels: true });
      withdrawn.answers.open = () => ({
        handle: withdrawn.handle,
        refine: { calls: { monitoring: { [facet]: "not-offered" } } },
      });
      const notServed = served(declaredNot);
      const narrowed = served(withdrawn);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each case's frames are its own.
      const narrowedSession = await narrowed.impl.open(openContext());
      const before = narrowed.frames.length;
      const call = (): Promise<unknown> | undefined =>
        facet === "panel"
          ? narrowed.impl.monitoring?.panel?.(narrowedSession.handle, { panel: "overview" }, callContext())
          : narrowed.impl.monitoring?.poolStats?.(narrowedSession.handle, callContext());

      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each case's frames are its own.
      const refused = await failure(async () => call());

      expect(notServed.impl.monitoring?.[facet]).toBeUndefined();
      expect(refused).toBeInstanceOf(CallRefusalError);
      expect((refused as CallRefusalError).refusals).toEqual([
        { rule: "facet-not-offered", pointer: `/monitoring/${facet}`, name: `monitoring.${facet}` },
      ]);
      expect(narrowed.frames.length).toBe(before);
      expect(withdrawn.seen.map((item) => item.call)).toEqual(["open"]);
    }

    const fx = fixture({ offersPanels: true });
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;
    const requests = [
      { panel: "performance" },
      { panel: "activeSessions", limit: 50 },
      { panel: "__proto__" },
      {},
    ] as unknown as MonitoringPanelRequest[];
    for (const sent of requests) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so no frame of one is read as another's.
      const refused = await failure(async () => impl.monitoring?.panel?.(opened.handle, sent, callContext()));
      expect(refused).toBeInstanceOf(CallRefusalError);
      expect((refused as CallRefusalError).refusals).toEqual([
        { rule: "request-panel-not-offered", pointer: "/panel" },
      ]);
    }
    expect(frames.length).toBe(before);
    expect(fx.seen.map((item) => item.call)).toEqual(["open"]);
  });

  test("a served health call crosses its context and answer as frames, and the host receives a decoded copy", async () => {
    const fx = fixture({ panel: false, poolStats: false });
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;
    const answer: HealthInfo = {
      activeConnections: 3,
      databaseSize: marker(),
      cacheHitRatio: marker(),
      slowQueries: [{ query: marker(), calls: 2, avgTime: marker() }],
      activeSessions: [
        { pid: 4711, user: marker(), database: marker(), state: marker(), query: marker(), duration: "1s" },
      ],
    };
    fx.answers.health = () => answer;
    const ctx = callContext();

    const got = await impl.health(opened.handle, ctx);
    const seen = fx.seen.at(-1) as Seen;

    expect(got).toEqual(answer);
    expect(got).not.toBe(answer);
    expect(frames.slice(before).map((frame) => `${frame.direction} ${frame.call}`)).toEqual([
      "to-provider health",
      "to-host health",
    ]);
    expect(JSON.parse((frames[before] as ServedFrame).text)).toEqual({
      call: "health",
      session: opened.handle.session,
      context: dataOf(ctx),
    });
    expect(seen.call).toBe("health");
    expect(seen.handle).toBe(fx.handle);
    expect(seen.request).toEqual([]);
    expect(Object.isFrozen(seen.ctx)).toBe(true);
    expect(seen.ctx?.signal).toBe(ctx.signal);

    const unmeasured: HealthInfo = {
      databaseSize: answer.databaseSize,
      cacheHitRatio: answer.cacheHitRatio,
      slowQueries: answer.slowQueries,
      activeSessions: answer.activeSessions,
    };
    fx.answers.health = () => unmeasured;
    expect(await impl.health(opened.handle, callContext())).toEqual(unmeasured);
    fx.answers.health = () => ({ ...answer, activeConnections: undefined });
    const dropped = await failure(() => impl.health(opened.handle, callContext()));
    expect((dropped as FrameRefusalError).refusals).toEqual([
      { rule: "round-trip-changed", call: "health", part: "answer", pointer: "/activeConnections" },
    ]);
    fx.answers.health = () => ({ ...answer, uptime: marker() });
    const unknownKey = await failure(() => impl.health(opened.handle, callContext()));
    expect((unknownKey as FrameRefusalError).refusals).toEqual([
      { rule: "frame-key-unknown", call: "health", part: "answer", pointer: "/uptime", name: "uptime" },
    ]);
  });

  test("a served open whose maintenance narrowing names an operation its engine does not list is refused, and the session it opened is closed", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const closes = () => fx.seen.filter((item) => item.call === "close");
    const engineUser = marker();
    fx.answers.open = () => ({
      handle: fx.handle,
      engineUser,
      refine: { maintenance: [{ operation: "vacuum", perEntity: true, global: false }] },
    });

    const widened = await failure(() => impl.open(openContext()));

    expect(widened).toBeInstanceOf(CallRefusalError);
    expect((widened as CallRefusalError).refusals).toEqual([
      { rule: "refinement-widens", pointer: "/maintenance/0/operation" },
    ]);
    expect(closes().map((item) => item.handle)).toEqual([fx.handle]);
    expect(closes()[0]?.ctx?.deadline).toBeGreaterThan(Date.now());
    // The served side closes a refused open's session on the provider's side directly, so no close frame crosses.
    expect(frames.map((frame) => `${frame.direction} ${frame.call}`)).toEqual(["to-provider open", "to-host open"]);

    const listing = fixture();
    const offered = served(listing);
    listing.answers.open = () => ({ handle: listing.handle, engineUser, refine: { maintenance: [] } });
    const opened = await offered.impl.open(openContext());
    expect(opened.engineUser).toBe(engineUser);
    expect(opened.refine).toEqual({ maintenance: [] });
    expect(listing.seen.map((item) => item.call)).toEqual(["open"]);

    const unread = fixture();
    const unreadServed = served(unread);
    unread.answers.open = () => ({ handle: unread.handle, refine: { maintenance: [{ operation: "vacuum" }] } });
    const shape = await failure(() => unreadServed.impl.open(openContext()));
    expect((shape as CallRefusalError).refusals).toEqual([
      { rule: "refinement-unreadable", pointer: "/maintenance/0/perEntity" },
      { rule: "refinement-unreadable", pointer: "/maintenance/0/global" },
    ]);
    expect(unread.seen.map((item) => item.call)).toEqual(["open", "close"]);
  });

  test("a served open is held to the maintenance of the engine its context names, which the module declares", async () => {
    const fx = fixture();
    const manifest = structuredClone(fx.module.manifest) as Json;
    manifest.engines[0].facets.maintenance = ["vacuum", "analyze"];
    manifest.engines[0].facets.maintenanceSpecs = ["vacuum", "analyze"].map((operation) => ({
      operation,
      label: operation,
      perEntity: true,
      global: true,
      title: null,
      description: null,
      confirmation: null,
      preview: false,
      kinds: null,
    }));
    const listing = defineProvider(manifest, fx.module.impl);
    const impl = serve(listing);
    fx.answers.open = () => ({
      handle: fx.handle,
      refine: { maintenance: [{ operation: "vacuum", perEntity: false, global: true }] },
    });

    const opened = await impl.open(openContext());
    const undeclared = await failure(() => impl.open({ ...openContext(), engine: "otherdb" }));

    expect(opened.refine).toEqual({ maintenance: [{ operation: "vacuum", perEntity: false, global: true }] });
    expect(undeclared).toBeInstanceOf(Error);
    expect((undeclared as Error).message).toBe(
      'The open context names the engine "otherdb", which the served module\'s manifest does not declare, so the provider was not called.',
    );
    expect(fx.seen.map((item) => item.call)).toEqual(["open"]);
  });

  test("a refinement open answers narrows the served session's calls", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    const plain = await impl.open(openContext());
    fx.answers.open = () => ({ handle: fx.handle, refine: { calls: { console: { execute: { honours: [] } } } } });
    const narrowed = await impl.open(openContext());
    const withParams = request((r) => (r.params = [1]));

    await impl.console.execute(plain.handle, withParams, callContext());
    const refused = await failure(() => impl.console.execute(narrowed.handle, withParams, callContext()));

    expect(narrowed.refine).toEqual({ calls: { console: { execute: { honours: [] } } } });
    expect((refused as CallRefusalError).refusals).toEqual([
      { rule: "request-field-not-honoured", pointer: "/params", name: "params" },
    ]);
  });

  test("an open answer the host refuses closes its session, and an execute answer the host refuses closes its sources", async () => {
    const fx = fixture({ endScope: false });
    const { impl } = served(fx);
    const closes = () => fx.seen.filter((item) => item.call === "close");

    fx.answers.open = () => ({ handle: fx.handle, refine: { calls: { console: { endScope: "offered" } } } });
    const widened = await failure(() => impl.open(openContext()));
    fx.answers.open = () => ({ handle: fx.handle, extra: marker() });
    const unknown = await failure(() => impl.open(openContext()));
    fx.answers.open = () => ({ handle: fx.handle, serverVersion: new Map() });
    const unframed = await failure(() => impl.open(openContext()));

    expect((widened as CallRefusalError).refusals).toEqual([
      { rule: "refinement-widens", pointer: "/calls/console/endScope" },
    ]);
    expect((unknown as FrameRefusalError).refusals).toEqual([
      { rule: "frame-key-unknown", call: "open", part: "answer", pointer: "/extra", name: "extra" },
    ]);
    expect(unframed).toBeInstanceOf(ValueCodecError);
    expect(closes().map((item) => item.handle)).toEqual([fx.handle, fx.handle, fx.handle]);

    fx.answers.open = () => marker();
    const notARecord = await failure(() => impl.open(openContext()));
    fx.answers.open = () => ({ serverVersion: marker() });
    const noHandle = await failure(() => impl.open(openContext()));
    let handleReads = 0;
    fx.answers.open = () =>
      Object.defineProperty({}, "handle", {
        enumerable: true,
        get() {
          handleReads += 1;
          return fx.handle;
        },
      });
    const accessor = await failure(() => impl.open(openContext()));

    expect((notARecord as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "open", part: "answer", pointer: "" },
    ]);
    expect((noHandle as FrameRefusalError).refusals).toEqual([
      { rule: "frame-key-missing", call: "open", part: "answer", pointer: "/handle", name: "handle" },
    ]);
    expect((accessor as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "open", part: "answer", pointer: "/handle" },
    ]);
    expect(handleReads).toBe(0);
    expect(closes()).toHaveLength(3);

    fx.answers.open = () => ({ handle: fx.handle });
    const opened = await impl.open(openContext());
    const closed: string[] = [];
    const counted = (name: string): ResultSource => ({
      columns: [{ name }],
      next: async () => ({ rows: [], done: true }),
      close: async () => {
        closed.push(name);
      },
    });
    fx.answers.execute = () => ({
      results: [counted("first"), counted("second")],
      warnings: [{ message: 1 }],
      executionTimeMs: 0,
      pageApplied: false,
    });
    const malformed = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    fx.answers.execute = () => marker();
    const notAnAnswer = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    const holed: ResultSource[] = [counted("before-hole")];
    holed.length = 2;
    fx.answers.execute = () => ({ results: holed, warnings: [], executionTimeMs: 0, pageApplied: false });
    const hole = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    fx.answers.execute = () => ({ results: marker(), warnings: [], executionTimeMs: 0, pageApplied: false });
    const notAList = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    const dropping = counted("dropping");
    fx.answers.execute = () => ({
      results: [{ ...dropping, columns: Object.assign([{ name: "id" }], { note: marker() }) }],
      warnings: [],
      executionTimeMs: 0,
      pageApplied: false,
    });
    const columns = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    fx.answers.execute = () => ({
      results: [counted("before-null"), null],
      warnings: [],
      executionTimeMs: 0,
      pageApplied: false,
    });
    const nullItem = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    fx.answers.execute = () => ({
      results: [counted("before-scalar"), marker()],
      warnings: [],
      executionTimeMs: 0,
      pageApplied: false,
    });
    const scalarItem = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    const getterError = new Error(marker());
    const throwing = Object.defineProperty({ ...counted("throwing") }, "rowCount", {
      enumerable: true,
      get() {
        throw getterError;
      },
    });
    fx.answers.execute = () => ({
      results: [counted("before-getter"), throwing],
      warnings: [],
      executionTimeMs: 0,
      pageApplied: false,
    });
    const getter = await failure(() => impl.console.execute(opened.handle, request(), callContext()));

    expect((nullItem as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "console.execute", part: "answer", pointer: "/results/1" },
    ]);
    expect((scalarItem as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "console.execute", part: "answer", pointer: "/results/1" },
    ]);
    expect(getter).toBe(getterError);

    expect((malformed as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "console.execute", part: "answer", pointer: "/warnings/0/message" },
    ]);
    expect((notAnAnswer as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "console.execute", part: "answer", pointer: "" },
    ]);
    expect((hole as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "console.execute", part: "answer", pointer: "/results/1" },
    ]);
    expect((notAList as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "console.execute", part: "answer", pointer: "/results" },
    ]);
    expect((columns as FrameRefusalError).refusals).toEqual([
      { rule: "round-trip-changed", call: "console.execute", part: "answer", pointer: "/results/0/columns" },
    ]);
    expect(closed).toEqual([
      "first",
      "second",
      "before-hole",
      "dropping",
      "before-null",
      "before-scalar",
      "before-getter",
      "throwing",
    ]);
  });

  test("a served execute answer outside the SDK's types is refused on the host side with the core's refusals, and its sources are closed", async () => {
    const fx = fixture({ endScope: false });
    const { impl } = served(fx);
    fx.answers.open = () => ({ handle: fx.handle });
    const opened = await impl.open(openContext());
    const closed: string[] = [];
    const counted = (name: string, columns = [{ name: "id" }], rowCount?: number): ResultSource => ({
      columns,
      ...(rowCount === undefined ? {} : { rowCount }),
      next: async () => ({ rows: [], done: true }),
      close: async () => {
        closed.push(name);
      },
    });
    const answering = (over: Json) => {
      fx.answers.execute = () => ({
        results: [counted("first"), counted("second")],
        warnings: [],
        executionTimeMs: 0,
        pageApplied: false,
        ...over,
      });
    };

    answering({ executionTimeMs: -1 });
    const slow = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    answering({ results: [counted("counted", undefined, 1.5)] });
    const counts = await failure(() => impl.console.execute(opened.handle, request(), callContext()));
    answering({ results: [counted("twice", [{ name: "id" }, { name: "id" }])] });
    const twice = await failure(() => impl.console.execute(opened.handle, request(), callContext()));

    expect(slow).toBeInstanceOf(CallRefusalError);
    expect((slow as CallRefusalError).refusals).toEqual([
      { rule: "execute-answer-unreadable", pointer: "/executionTimeMs" },
    ]);
    expect((counts as CallRefusalError).refusals).toEqual([
      { rule: "execute-answer-unreadable", pointer: "/results/0/rowCount" },
    ]);
    expect((twice as CallRefusalError).refusals).toEqual([
      { rule: "execute-answer-unreadable", pointer: "/results/0/columns/1/name" },
    ]);
    expect(closed).toEqual(["first", "second", "counted", "twice"]);

    // Vacuity: a well-formed answer crosses, its sources open.
    answering({ executionTimeMs: 2 });
    const answer = await impl.console.execute(opened.handle, request(), callContext());
    expect([answer.executionTimeMs, answer.results.length]).toEqual([2, 2]);
    expect(closed).toHaveLength(4);
  });

  test("a refused open answer's session is closed with a context of its own, not the open's aborted one", async () => {
    const fx = fixture({ endScope: false });
    const { impl } = served(fx);
    const controller = new AbortController();
    const reason = new Error(marker());
    const env = envReader([], () => undefined);
    fx.answers.open = () => {
      controller.abort(reason);
      return { handle: fx.handle, refine: { calls: { console: { endScope: "offered" } } } };
    };
    const ctx = { ...openContext(controller), env };
    const before = Date.now();
    const refused = await failure(() => impl.open(ctx));
    const after = Date.now();
    const closes = fx.seen.filter((item) => item.call === "close");

    expect(refused).toBeInstanceOf(CallRefusalError);
    expect(controller.signal.aborted).toBe(true);
    expect(closes).toHaveLength(1);
    const closeCtx = closes[0]?.ctx as CallContext;
    expect(closes[0]?.handle).toBe(fx.handle);
    expect(closeCtx.signal.aborted).toBe(false);
    expect(closeCtx.signal).not.toBe(controller.signal);
    expect(closeCtx.deadline).not.toBe(ctx.deadline);
    expect(closeCtx.deadline).toBeGreaterThanOrEqual(before + CLEANUP_DEADLINE_MS);
    expect(closeCtx.deadline).toBeLessThanOrEqual(after + CLEANUP_DEADLINE_MS);
    expect(closeCtx.env).toBe(env);
    expect(Object.isFrozen(closeCtx)).toBe(true);
  });

  test("a close that fails beside a refused answer is thrown with the refusal first", async () => {
    const fx = fixture({ endScope: false });
    const { impl } = served(fx);
    const thrown = new Error(marker());
    fx.answers.open = () => ({ handle: fx.handle, refine: { calls: { console: { endScope: "offered" } } } });
    fx.answers.close = () => {
      throw thrown;
    };

    const opening = await failure(() => impl.open(openContext()));

    expect(opening).toBeInstanceOf(AggregateError);
    expect((opening as AggregateError).errors[0]).toBeInstanceOf(CallRefusalError);
    expect((opening as AggregateError).errors.slice(1)).toEqual([thrown]);
    expect((opening as AggregateError).errors[1]).toBe(thrown);

    fx.answers.open = () => ({ handle: fx.handle });
    const opened = await impl.open(openContext());
    const failing: ResultSource = {
      columns: [{ name: "id" }],
      next: async () => ({ rows: [], done: true }),
      close: async () => {
        throw thrown;
      },
    };
    const quiet = rowsSource([{ name: "id" }], []);
    fx.answers.execute = () => ({
      results: [failing, quiet],
      warnings: [],
      executionTimeMs: "slow",
      pageApplied: false,
    });
    const executing = await failure(() => impl.console.execute(opened.handle, request(), callContext()));

    expect(executing).toBeInstanceOf(AggregateError);
    expect(((executing as AggregateError).errors[0] as FrameRefusalError).refusals).toEqual([
      { rule: "frame-value-unreadable", call: "console.execute", part: "answer", pointer: "/executionTimeMs" },
    ]);
    expect((executing as AggregateError).errors).toHaveLength(2);
    expect((executing as AggregateError).errors[1]).toBe(thrown);
  });

  test("a served result source pulled by pumpPage answers the provider's rows, one frame a batch", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const rows = Array.from({ length: 5 }, (_, index) => [index, "x"]);
    const pulls: unknown[] = [];
    const inner = rowsSource([{ name: "id" }, { name: "label" }], rows, 5);
    fx.answers.execute = () => ({
      results: [
        {
          columns: inner.columns,
          rowCount: 5,
          next: (limit: BatchLimit) => {
            pulls.push(limit);
            return inner.next(limit);
          },
          close: () => inner.close(),
        },
      ],
      warnings: [],
      executionTimeMs: 0,
      pageApplied: false,
    });
    const opened = await impl.open(openContext());
    const answer: ExecuteAnswer = await impl.console.execute(opened.handle, request(), callContext());
    const before = frames.length;

    const page = await pumpPage(
      answer.results[0] as ResultSource,
      {
        maxRows: 100,
        maxBytes: PAGE_MAX_BYTES,
        batchMaxBytes: 7,
      },
      callContext(),
    );
    const pumped = frames.slice(before);
    const requested = pumped.filter((frame) => frame.direction === "to-provider" && frame.call === "result.next");

    expect(page).toEqual({ rows, bytes: 35, end: "done" });
    expect(page.rows).not.toBe(rows);
    expect(pulls).toHaveLength(5);
    expect(requested).toHaveLength(5);
    expect(requested.map((frame) => JSON.parse(frame.text).request)).toEqual(
      pulls.map((limit) => {
        const { maxRows, maxBytes } = limit as BatchLimit;
        return { maxRows, maxBytes };
      }),
    );
    expect(pumped.map((frame) => `${frame.direction} ${frame.call}`).slice(-2)).toEqual([
      "to-provider result.close",
      "to-host result.close",
    ]);
    expect(pumped).toHaveLength(12);
  });

  test("a served source's provider receives the limit's numbers decoded and frozen with the host's measure by reference, and the frame carries the numbers only", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);
    const pulls: BatchLimit[] = [];
    const inner = rowsSource([{ name: "id" }, { name: "label" }], [[1, marker()]], 1);
    fx.answers.execute = () => ({
      results: [
        {
          columns: inner.columns,
          next: (limit: BatchLimit) => {
            pulls.push(limit);
            return inner.next(limit);
          },
          close: () => inner.close(),
        },
      ],
      warnings: [],
      executionTimeMs: 0,
      pageApplied: false,
    });
    const opened = await impl.open(openContext());
    const answer = await impl.console.execute(opened.handle, request(), callContext());
    const measured: (readonly unknown[])[] = [];
    const measure = (row: readonly unknown[]): number => {
      measured.push(row);
      return encodedRowBytes(row);
    };
    const host: BatchLimit = { maxRows: 7, maxBytes: 1024, measure };
    const before = frames.length;

    const batch: RowBatch = await (answer.results[0] as ResultSource).next(host);
    const asked = frames.slice(before).find((frame) => frame.direction === "to-provider");

    expect(JSON.parse((asked as ServedFrame).text).request).toEqual({ maxRows: 7, maxBytes: 1024 });
    expect(pulls).toHaveLength(1);
    const [provided] = pulls;
    expect(provided).not.toBe(host);
    expect(Object.isFrozen(provided)).toBe(true);
    expect(Object.keys(provided as BatchLimit).sort()).toEqual(["maxBytes", "maxRows", "measure"]);
    expect(provided?.maxRows).toBe(7);
    expect(provided?.maxBytes).toBe(1024);
    expect(provided?.measure).toBe(measure);
    expect(measured).toHaveLength(1);
    expect(batch.rows).toEqual(measured);
    expect(batch.rows[0]).not.toBe(measured[0]);
  });

  test("a call whose signal aborted or whose deadline passed is refused before any frame, and the provider is never called", async () => {
    const fx = fixture({ honours: [] });
    const { impl, frames } = served(fx);
    const opened = await impl.open(openContext());
    const before = frames.length;
    const reason = new Error(marker());
    const gone = new AbortController();
    gone.abort(reason);
    const calls: [string, (ctx: CallContext) => Promise<unknown>][] = [
      ["open", (ctx) => impl.open({ ...openContext(), deadline: ctx.deadline, signal: ctx.signal })],
      ["close", (ctx) => impl.close(opened.handle, ctx)],
      ["console.execute", (ctx) => impl.console.execute(opened.handle, request(), ctx)],
      ["console.cancel", async (ctx) => impl.console.cancel?.(opened.handle, { runId: marker() }, ctx)],
      ["console.endScope", async (ctx) => impl.console.endScope?.(opened.handle, { scope: marker() }, ctx)],
    ];

    const refused = await Promise.all(
      calls.map(async ([call, run]) => ({
        call,
        aborted: await failure(() => run(callContext(gone))),
        passed: await failure(() => run(past(callContext()))),
      })),
    );
    const withField = await failure(() =>
      impl.console.execute(
        opened.handle,
        request((r) => (r.params = [])),
        callContext(gone),
      ),
    );

    for (const { aborted, passed } of refused) {
      expect(aborted).toBeInstanceOf(CallRefusalError);
      expect((aborted as CallRefusalError).refusals).toEqual([{ rule: "call-signal-aborted", pointer: "/signal" }]);
      expect((aborted as CallRefusalError).cause).toBe(reason);
      expect(passed).toBeInstanceOf(CallRefusalError);
      expect((passed as CallRefusalError).refusals).toEqual([{ rule: "call-deadline-passed", pointer: "/deadline" }]);
      expect((passed as CallRefusalError).cause).toBeUndefined();
    }
    expect(refused.map((item) => item.call)).toEqual(calls.map(([call]) => call));
    expect((withField as CallRefusalError).refusals).toEqual([{ rule: "call-signal-aborted", pointer: "/signal" }]);
    expect(frames.length).toBe(before);
    expect(fx.seen.map((item) => item.call)).toEqual(["open"]);

    const answer = await impl.console.execute(opened.handle, request(), callContext());
    expect(answer.results).toHaveLength(1);
    await impl.close(opened.handle, callContext());
    expect(fx.seen.map((item) => item.call)).toEqual(["open", "console.execute", "close"]);
  });

  test("the provider's context carries the host's deadline and signal, and its signal aborts at the deadline", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    const opened = await impl.open(openContext());
    fx.answers.execute = () =>
      new Promise((_, reject) => {
        const signal = fx.seen.at(-1)?.ctx?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const deadline = Date.now() + 30;
    const signal = deadlineSignal(deadline);

    const error = await failure(() =>
      impl.console.execute(opened.handle, request(), {
        deadline,
        signal,
        env: envReader([], () => undefined),
      }),
    );

    const providerCtx = fx.seen.at(-1)?.ctx as CallContext;
    expect(providerCtx.deadline).toBe(deadline);
    expect(providerCtx.signal).toBe(signal);
    expect(error).toBe(signal.reason);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("TimeoutError");
  });

  test("an answer the host stopped waiting for reaches its late handler whole, and the host closes what it handed over once", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    const opened = await impl.open(openContext());

    const lateExecute = Promise.withResolvers<unknown>();
    fx.answers.execute = () => lateExecute.promise;
    const executeController = new AbortController();
    const executeHandler = lateHandler<ExecuteAnswer>();
    const executeWait = awaitWithin(
      impl.console.execute(opened.handle, request(), callContext(executeController)),
      executeController.signal,
      executeHandler.late,
    );
    const executeReason = new Error(marker());
    executeController.abort(executeReason);
    expect(await failure(() => executeWait)).toBe(executeReason);
    const counted = countedSource();
    lateExecute.resolve({ results: [counted.source], warnings: [], executionTimeMs: 0, pageApplied: false });
    const executeOutcome = await executeHandler.first;
    expect(executeOutcome.kind).toBe("answered");
    const lateAnswer = (executeOutcome as { readonly value: ExecuteAnswer }).value;
    expect(lateAnswer.results).toHaveLength(1);
    await Promise.all(lateAnswer.results.map((result) => result.close()));
    expect(counted.closes()).toBe(1);
    expect(executeHandler.calls).toHaveLength(1);

    const lateFailure = Promise.withResolvers<unknown>();
    fx.answers.execute = () => lateFailure.promise;
    const failingController = new AbortController();
    const failingHandler = lateHandler<ExecuteAnswer>();
    const failingWait = awaitWithin(
      impl.console.execute(opened.handle, request(), callContext(failingController)),
      failingController.signal,
      failingHandler.late,
    );
    const failingReason = new Error(marker());
    failingController.abort(failingReason);
    expect(await failure(() => failingWait)).toBe(failingReason);
    const thrown = new Error(marker());
    lateFailure.reject(thrown);
    const failedOutcome = await failingHandler.first;
    expect(failedOutcome.kind).toBe("failed");
    expect((failedOutcome as { readonly error: unknown }).error).toBe(thrown);

    const lateRefused = Promise.withResolvers<unknown>();
    fx.answers.execute = () => lateRefused.promise;
    const refusedController = new AbortController();
    const refusedHandler = lateHandler<ExecuteAnswer>();
    const refusedWait = awaitWithin(
      impl.console.execute(opened.handle, request(), callContext(refusedController)),
      refusedController.signal,
      refusedHandler.late,
    );
    refusedController.abort(new Error(marker()));
    await failure(() => refusedWait);
    const handedOver = countedSource();
    lateRefused.resolve({ results: [handedOver.source, 7], warnings: [], executionTimeMs: 0, pageApplied: false });
    const refusedOutcome = await refusedHandler.first;
    expect(refusedOutcome.kind).toBe("failed");
    expect((refusedOutcome as { readonly error: unknown }).error).toBeInstanceOf(FrameRefusalError);
    expect(handedOver.closes()).toBe(1);

    const lateOpen = Promise.withResolvers<unknown>();
    const lateHandle = { marker: marker() };
    fx.answers.open = () => lateOpen.promise;
    const openController = new AbortController();
    const openHandler = lateHandler<OpenAnswer<ServedHandle>>();
    const openWait = awaitWithin(impl.open(openContext(openController)), openController.signal, openHandler.late);
    const openReason = new Error(marker());
    openController.abort(openReason);
    expect(await failure(() => openWait)).toBe(openReason);
    lateOpen.resolve({ handle: lateHandle });
    const openOutcome = await openHandler.first;
    expect(openOutcome.kind).toBe("answered");
    const token = (openOutcome as { readonly value: OpenAnswer<ServedHandle> }).value.handle;
    const closesBefore = fx.seen.filter((item) => item.call === "close").length;
    await impl.close(token, callContext());
    const closes = fx.seen.filter((item) => item.call === "close");
    expect(closes.length - closesBefore).toBe(1);
    expect(closes.at(-1)?.handle).toBe(lateHandle);
    const after = await failure(() => impl.console.execute(token, request(), callContext()));
    expect((after as FrameRefusalError).refusals[0]?.rule).toBe("session-not-open");
    expect(openHandler.calls).toHaveLength(1);
  });

  test("a call that throws fails only that call, and its session and the served instance keep serving", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    const first = await impl.open(openContext());
    const second = await impl.open(openContext());
    const earlier = await impl.console.execute(first.handle, request(), callContext());
    const thrown = new Error(marker());
    const honest = fx.answers.execute;
    let throwOnce = true;
    fx.answers.execute = () => {
      if (!throwOnce) return honest();
      throwOnce = false;
      throw thrown;
    };

    expect(await failure(() => impl.console.execute(first.handle, request(), callContext()))).toBe(thrown);
    const again = await impl.console.execute(first.handle, request(), callContext());
    const other = await impl.console.execute(second.handle, request(), callContext());
    const pulled = await (earlier.results[0] as ResultSource).next(limitOf(10, 1024));

    expect(again.results).toHaveLength(1);
    expect(other.results).toHaveLength(1);
    expect(pulled.rows).toHaveLength(2);
    expect(pulled.done).toBe(true);
  });

  test("two sessions of one served module reach only their own handles, and one session's error or close leaves the other serving", async () => {
    const fx = fixture();
    const { impl } = served(fx);
    fx.answers.open = () => ({
      handle: { marker: ((fx.seen.at(-1) as Seen).ctx as OpenContext).connection.user as string },
    });
    const failing = new Set<string>();
    const thrown = new Error(marker());
    fx.answers.execute = () => {
      const own = ((fx.seen.at(-1) as Seen).handle as ProviderHandle).marker;
      if (failing.has(own)) throw thrown;
      return {
        results: [rowsSource([{ name: "who" }], [[own]], 1)],
        warnings: [],
        executionTimeMs: 0,
        pageApplied: false,
      };
    };
    const ctxA = openContext();
    const ctxB = openContext();
    const userA = ctxA.connection.user as string;
    const userB = ctxB.connection.user as string;
    const a = await impl.open(ctxA);
    const b = await impl.open(ctxB);

    /** The one row a session's execute answers, pulled through its served source. */
    const who = async (handle: ServedHandle): Promise<unknown> => {
      const answer = await impl.console.execute(handle, request(), callContext());
      const source = answer.results[0] as ResultSource;
      const batch = await source.next(limitOf(10, 1024));
      await source.close();
      return batch.rows[0]?.[0];
    };

    expect(userA).not.toBe(userB);
    expect(await who(a.handle)).toBe(userA);
    expect(await who(b.handle)).toBe(userB);

    failing.add(userA);
    expect(await failure(() => impl.console.execute(a.handle, request(), callContext()))).toBe(thrown);
    expect(await who(b.handle)).toBe(userB);
    failing.delete(userA);

    await impl.close(a.handle, callContext());
    const closed = fx.seen.filter((item) => item.call === "close");
    expect(closed.map((item) => (item.handle as ProviderHandle).marker)).toEqual([userA]);
    expect(await who(b.handle)).toBe(userB);
    const refused = await failure(() => impl.console.execute(a.handle, request(), callContext()));
    expect((refused as FrameRefusalError).refusals[0]?.rule).toBe("session-not-open");
  });

  test("two served instances of one module share no session", async () => {
    const fx = fixture();
    const one = served(fx);
    const two = served(fx);
    const opened = await one.impl.open(openContext());
    const oneBefore = one.frames.length;

    const refused = await failure(() => two.impl.console.execute(opened.handle, request(), callContext()));
    const closing = await failure(() => two.impl.close(opened.handle, callContext()));

    expect(refused).toBeInstanceOf(FrameRefusalError);
    expect((refused as FrameRefusalError).refusals[0]?.rule).toBe("session-not-open");
    expect((closing as FrameRefusalError).refusals[0]?.rule).toBe("session-not-open");
    expect(two.frames).toHaveLength(0);
    expect(one.frames).toHaveLength(oneBefore);
    expect(fx.seen.map((item) => item.call)).toEqual(["open"]);
    const answer = await one.impl.console.execute(opened.handle, request(), callContext());
    expect(answer.results).toHaveLength(1);
  });

  test("a value that is not a provider module record is refused with every refusal before anything is served", () => {
    const fx = fixture();
    const broken = { ...fx.module, impl: { ...fx.module.impl, open: undefined, extra: () => {} } };
    let thrown: unknown;
    try {
      serve(broken as unknown as ProviderModule);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderDefinitionError);
    expect((thrown as ProviderDefinitionError).refusals).toEqual(checkProviderModule(broken));
    expect((thrown as ProviderDefinitionError).refusals.map((item) => item.rule)).toEqual([
      "impl-key-unknown",
      "call-missing",
    ]);
    expect(() => serve({} as ProviderModule)).toThrow(ProviderDefinitionError);
  });

  test("the served implementation is an implementation of the module's manifest, with the module's facets", () => {
    const both = fixture();
    const neither = fixture({
      cancel: false,
      endScope: false,
      transaction: false,
      tree: false,
      run: false,
      preview: false,
      panel: false,
      poolStats: false,
    });
    const servedBoth = serve(both.module);
    const servedNeither = serve(neither.module);

    expect(checkProviderModule(defineProvider(both.module.manifest, servedBoth))).toEqual([]);
    expect(typeof servedBoth.health).toBe("function");
    expect(typeof servedNeither.health).toBe("function");
    expect(checkProviderModule(defineProvider(neither.module.manifest, servedNeither))).toEqual([]);
    expect(Object.keys(servedBoth.console).sort()).toEqual(["cancel", "endScope", "execute", "transaction"]);
    expect(Object.keys(servedNeither.console)).toEqual(["execute"]);
    expect(Object.keys(servedBoth.objects ?? {})).toEqual(["tree"]);
    expect(Object.keys(servedNeither.objects ?? {})).toEqual([]);
    expect(Object.keys(servedBoth.maintenance ?? {})).toEqual(["run", "preview"]);
    expect(Object.keys(servedNeither.maintenance ?? {})).toEqual([]);
    expect(Object.keys(serve(fixture({ preview: false }).module).maintenance ?? {})).toEqual(["run"]);
    expect(Object.keys(servedBoth.monitoring ?? {})).toEqual(["panel", "poolStats"]);
    expect(Object.keys(servedNeither.monitoring ?? {})).toEqual([]);
    expect(Object.keys(serve(fixture({ panel: false }).module).monitoring ?? {})).toEqual(["poolStats"]);
    expect(Object.isFrozen(servedBoth)).toBe(true);
    expect(Object.isFrozen(servedBoth.console)).toBe(true);
    expect(Object.isFrozen(servedBoth.objects)).toBe(true);
    expect(Object.isFrozen(servedBoth.maintenance)).toBe(true);
    expect(Object.isFrozen(servedBoth.monitoring)).toBe(true);
  });
});
