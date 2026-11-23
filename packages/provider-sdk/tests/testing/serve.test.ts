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
  type BatchLimit,
  type CallContext,
  CallRefusalError,
  checkProviderModule,
  defineProvider,
  envReader,
  type ExecuteAnswer,
  type ExecuteRequest,
  type OpenContext,
  PAGE_MAX_BYTES,
  ProviderDefinitionError,
  type ProviderImpl,
  type ProviderModule,
  pumpPage,
  type ResultSource,
  rowsSource,
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

/** A provider module over the minimal manifest: honours both fields, offers both facets unless told otherwise. */
function fixture(
  options: { readonly cancel?: boolean; readonly endScope?: boolean; readonly honours?: string[] } = {},
): Fixture {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "../fixtures/minimal-manifest.json"), "utf8"));
  manifest.calls.console.execute.honours = options.honours ?? ["params", "offset"];
  manifest.calls.console.cancel = options.cancel === false ? "not-offered" : "offered";
  manifest.calls.console.endScope = options.endScope === false ? "not-offered" : "offered";
  manifest.engines[0].facets.monitoring.overview = "not-offered";
  const seen: Seen[] = [];
  const handle: ProviderHandle = { marker: marker() };
  const answers: Json = {
    open: () => ({ handle, serverVersion: marker() }),
    close: () => undefined,
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

describe("serve", () => {
  test("a served module answers every call through one request frame and one answer frame", async () => {
    const fx = fixture();
    const { impl, frames } = served(fx);

    const opened = await impl.open(openContext());
    const answer = await impl.console.execute(opened.handle, request(), callContext());
    await impl.console.cancel?.(opened.handle, { runId: marker() }, callContext());
    await impl.console.endScope?.(opened.handle, { scope: marker() }, callContext());
    const source = answer.results[0] as ResultSource;
    await source.next({ maxRows: 10, maxBytes: 1024 });
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

    expect(optionalUndefined).toBeInstanceOf(ValueCodecError);
    expect((optionalUndefined as ValueCodecError).path).toBe("/runId");
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
    expect(await failure(() => servedSource.next({ maxRows: 1, maxBytes: 1 }))).toBe(thrown);
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
    await source.next({ maxRows: 10, maxBytes: 1024 });
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

    expect((closed as FrameRefusalError).refusals).toEqual([
      { rule: "session-not-open", call: "console.execute", part: "handle", pointer: "" },
    ]);
    expect((copied as FrameRefusalError).refusals).toEqual([
      { rule: "session-not-open", call: "close", part: "handle", pointer: "" },
    ]);
    expect((foreign as FrameRefusalError).refusals).toEqual([
      { rule: "session-not-open", call: "console.endScope", part: "handle", pointer: "" },
    ]);
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

    const pulled = await failure(() => source.next({ maxRows: 1, maxBytes: 1024 }));
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
    expect(closes().map((item) => item.ctx)).toEqual(
      fx.seen.filter((item) => item.call === "open").map((item) => item.ctx),
    );

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
    expect(requested.map((frame) => JSON.parse(frame.text).request)).toEqual(pulls);
    expect(pumped.map((frame) => `${frame.direction} ${frame.call}`).slice(-2)).toEqual([
      "to-provider result.close",
      "to-host result.close",
    ]);
    expect(pumped).toHaveLength(12);
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
    const neither = fixture({ cancel: false, endScope: false });
    const servedBoth = serve(both.module);
    const servedNeither = serve(neither.module);

    expect(checkProviderModule(defineProvider(both.module.manifest, servedBoth))).toEqual([]);
    expect(checkProviderModule(defineProvider(neither.module.manifest, servedNeither))).toEqual([]);
    expect(Object.keys(servedBoth.console).sort()).toEqual(["cancel", "endScope", "execute"]);
    expect(Object.keys(servedNeither.console)).toEqual(["execute"]);
    expect(Object.isFrozen(servedBoth)).toBe(true);
    expect(Object.isFrozen(servedBoth.console)).toBe(true);
  });
});
