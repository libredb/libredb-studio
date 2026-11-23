/**
 * The host core's console calls (src/lib/provider-host/core/console.ts; docs/providers/CONTRACT.md, clauses C-48 and
 * C-28): each call is checked before it is made and refused as a record, runs on a context and request frozen in place,
 * is waited for until the call's signal, has its first result pumped and every other result closed, and a stop sends
 * the run's cancel under a cleanup context of its own while the abandoned run keeps its handler.
 *
 * Every session here is a fake whose `execute`, `cancel` and sources the test drives through promises it settles
 * itself; no assertion follows a timer. A late handler resolves a promise the test awaits, so an abandoned rejection
 * with no handler fires while the test runs and fails it. `console-bounds.test.ts` holds a run that never settles with
 * a real deadline in a bounded Node child.
 */
import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BATCH_MAX_BYTES,
  type BatchLimit,
  type CallContext,
  CallRefusalError,
  type CancelAnswer,
  type CancelRequest,
  CLEANUP_DEADLINE_MS,
  envReader,
  type ExecuteAnswer,
  type ExecuteRequest,
  PAGE_MAX_BYTES,
  type PumpLimits,
  type ResultSource,
  rowsSource,
} from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";
import {
  type ConsoleSession,
  cancelCall,
  type ExecuteRecord,
  executeCall,
  type HostCallPorts,
} from "@/lib/provider-host/core/console";

const HOUR = 3_600_000;
const marker = (): string => randomUUID();

/** A session's calls: both request fields honoured unless told otherwise, cancel offered unless told otherwise. */
function callsOf(options: { readonly honours?: ("params" | "offset")[]; readonly cancel?: boolean } = {}): Calls {
  return {
    console: {
      execute: { honours: options.honours ?? ["params", "offset"] },
      cancel: options.cancel === false ? "not-offered" : "offered",
      endScope: "not-offered",
    },
  };
}

function contextOf(controller = new AbortController(), deadline = Date.now() + HOUR): CallContext {
  return { deadline, signal: controller.signal, env: envReader([], () => undefined) };
}

function requestOf(over: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return { statement: `select ${marker()}`, page: { limit: 2, offset: 0 }, ...over };
}

const LIMITS: PumpLimits = { maxRows: 2, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES };

/** An answer over `results`. */
function answerOf(results: readonly ResultSource[], over: Partial<ExecuteAnswer> = {}): ExecuteAnswer {
  return { results, warnings: [], executionTimeMs: 4, pageApplied: true, ...over };
}

/** A source over `rows` of one column that counts its pulls and its closes. */
function counted(rows: readonly (readonly unknown[])[], rowCount?: number) {
  const inner = rowsSource([{ name: "v" }], rows, rowCount);
  const seen = { pulls: 0, closes: 0 };
  const closed = Promise.withResolvers<void>();
  const source: ResultSource = {
    columns: inner.columns,
    ...(rowCount === undefined ? {} : { rowCount }),
    next: (limit: BatchLimit) => {
      seen.pulls += 1;
      return inner.next(limit);
    },
    close: async () => {
      seen.closes += 1;
      closed.resolve();
    },
  };
  return { source, seen, closed: closed.promise };
}

/** Ports whose late and cancel-failed handlers record each error and resolve a promise with the first. */
function portsOf() {
  const late: unknown[] = [];
  const cancelFailed: unknown[] = [];
  const firstLate = Promise.withResolvers<unknown>();
  const firstCancelFailed = Promise.withResolvers<unknown>();
  const ports: HostCallPorts = {
    late: (error) => {
      late.push(error);
      firstLate.resolve(error);
    },
    cancelFailed: (error) => {
      cancelFailed.push(error);
      firstCancelFailed.resolve(error);
    },
  };
  return { ports, late, cancelFailed, firstLate: firstLate.promise, firstCancelFailed: firstCancelFailed.promise };
}

interface Seen {
  readonly request: unknown;
  readonly ctx: CallContext;
}

/** A session whose execute answers what `answer` gives, recording each call; cancel answers `cancelled`. */
function sessionOf(
  answer: (request: ExecuteRequest, ctx: CallContext) => Promise<ExecuteAnswer>,
  options: {
    readonly calls?: Calls;
    readonly cancel?: (request: CancelRequest, ctx: CallContext) => Promise<CancelAnswer>;
  } = {},
) {
  const executes: Seen[] = [];
  const cancels: Seen[] = [];
  const executeCalled = Promise.withResolvers<void>();
  const cancelCalled = Promise.withResolvers<void>();
  const cancel = options.cancel ?? (async () => ({ cancelled: true }));
  const session: ConsoleSession = {
    calls: options.calls ?? callsOf(),
    execute: (request, ctx) => {
      executes.push({ request, ctx });
      executeCalled.resolve();
      return answer(request, ctx);
    },
    cancel: (request, ctx) => {
      cancels.push({ request, ctx });
      cancelCalled.resolve();
      return cancel(request, ctx);
    },
  };
  return { session, executes, cancels, executeCalled: executeCalled.promise, cancelCalled: cancelCalled.promise };
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

/** A promise the test settles itself. */
function held<T>() {
  return Promise.withResolvers<T>();
}

describe("executeCall", () => {
  test("a call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called", async () => {
    const execute = mock(async () => answerOf([]));
    const session: ConsoleSession = { calls: callsOf(), execute };
    const controller = new AbortController();
    const reason = new Error(marker());
    controller.abort(reason);
    const { ports } = portsOf();

    const aborted = await executeCall(session, requestOf(), contextOf(controller), () => LIMITS, ports);
    const late = await executeCall(
      session,
      requestOf(),
      contextOf(new AbortController(), Date.now() - 1),
      () => LIMITS,
      ports,
    );

    expect(aborted).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-signal-aborted", pointer: "/signal" }],
      cause: reason,
    });
    expect((aborted as { readonly cause: unknown }).cause).toBe(reason);
    expect(late).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-deadline-passed", pointer: "/deadline" }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("a request field the session does not honour is refused as a record before the call", async () => {
    const execute = mock(async () => answerOf([]));
    const session: ConsoleSession = { calls: callsOf({ honours: [] }), execute };
    const { ports } = portsOf();

    const params = await executeCall(session, requestOf({ params: [1] }), contextOf(), () => LIMITS, ports);
    const offset = await executeCall(
      session,
      requestOf({ page: { limit: 2, offset: 4 } }),
      contextOf(),
      () => LIMITS,
      ports,
    );
    const scope = await executeCall(session, requestOf({ scope: marker() }), contextOf(), () => LIMITS, ports);

    expect(params).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "request-field-not-honoured", pointer: "/params", name: "params" }],
    });
    expect(offset).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "request-field-not-honoured", pointer: "/page/offset", name: "offset" }],
    });
    expect(scope).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "request-scope-not-offered", pointer: "/scope" }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("every call gets a fresh context and request, frozen at every depth", async () => {
    const fx = sessionOf(async () => answerOf([counted([[1]]).source]));
    const { ports } = portsOf();
    const controller = new AbortController();
    const first = { ctx: contextOf(controller), request: requestOf({ params: [marker(), [1]], runId: marker() }) };
    const second = { ctx: contextOf(controller), request: requestOf() };
    const { env, signal } = first.ctx;

    await executeCall(fx.session, first.request, first.ctx, () => LIMITS, ports);
    await executeCall(fx.session, second.request, second.ctx, () => LIMITS, ports);

    const [one, two] = fx.executes;
    expect(one?.ctx).toBe(first.ctx);
    expect(one?.request).toBe(first.request);
    expect(two?.ctx).toBe(second.ctx);
    expect(two?.request).toBe(second.request);
    const ctx = one?.ctx as CallContext & { deadline: number };
    const request = one?.request as { statement: string; page: { limit: number }; params: unknown[][] };
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(request.page)).toBe(true);
    expect(Object.isFrozen(request.params[1])).toBe(true);
    expect(() => {
      ctx.deadline = 0;
    }).toThrow(TypeError);
    expect(() => {
      request.page.limit = 0;
    }).toThrow(TypeError);
    expect(() => {
      request.params[1]?.push(2);
    }).toThrow(TypeError);
    expect(ctx.signal).toBe(signal);
    expect(ctx.env).toBe(env);
    expect(Object.isFrozen(signal)).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  test("the first result is pumped within the limits set from the answer, and every other result is closed once", async () => {
    const first = counted([[1], [2], [3]], 3);
    const second = counted([[4]]);
    const answer = answerOf([first.source, second.source], {
      warnings: [{ message: marker() }],
      executionTimeMs: 7,
      boundApplied: true,
      explainPlan: { plan: marker() },
    });
    const fx = sessionOf(async () => answer);
    const pumpLimits = mock<(answer: ExecuteAnswer) => PumpLimits>(() => LIMITS);
    const { ports } = portsOf();

    const record = await executeCall(fx.session, requestOf(), contextOf(), pumpLimits, ports);

    expect(pumpLimits.mock.calls).toHaveLength(1);
    expect(pumpLimits.mock.calls[0]?.[0]).toBe(answer);
    expect(record).toEqual({
      kind: "page",
      page: { rows: [[1], [2]], bytes: 6, end: "row-limit" },
      resultCount: 2,
      rowCount: 3,
      pageApplied: true,
      boundApplied: true,
      executionTimeMs: 7,
      warnings: answer.warnings,
      explainPlan: answer.explainPlan,
    });
    expect((record as { readonly warnings: unknown }).warnings).toBe(answer.warnings);
    expect(first.seen).toEqual({ pulls: 1, closes: 1 });
    expect(second.seen).toEqual({ pulls: 0, closes: 1 });

    const empty = await executeCall(
      sessionOf(async () => answerOf([], { pageApplied: false })).session,
      requestOf(),
      contextOf(),
      () => LIMITS,
      ports,
    );
    expect(empty).toEqual({
      kind: "page",
      page: { rows: [], bytes: 0, end: "done" },
      resultCount: 0,
      pageApplied: false,
      executionTimeMs: 4,
      warnings: [],
    });
  });

  test("a row no page can hold is refused as a record, and the source is closed once", async () => {
    const wide = counted([["x".repeat(64)]]);
    const other = counted([[1]]);
    const { ports } = portsOf();
    const small: PumpLimits = { maxRows: 10, maxBytes: 16, batchMaxBytes: 16 };

    const overPage = await executeCall(
      sessionOf(async () => answerOf([wide.source, other.source])).session,
      requestOf(),
      contextOf(),
      () => small,
      ports,
    );

    let overRowsCloses = 0;
    const overRows: ResultSource = {
      columns: [{ name: "v" }],
      next: async () => ({ rows: [[1], [2], [3]], done: true }),
      close: async () => {
        overRowsCloses += 1;
      },
    };
    const batchOverRows = await executeCall(
      sessionOf(async () => answerOf([overRows])).session,
      requestOf(),
      contextOf(),
      () => LIMITS,
      ports,
    );

    expect(overPage).toEqual({
      kind: "refused",
      called: true,
      refusals: [{ rule: "row-over-page", pointer: "/rows/0", limit: 16, size: 68 }],
    });
    expect(wide.seen.closes).toBe(1);
    expect(other.seen).toEqual({ pulls: 0, closes: 1 });
    expect(batchOverRows).toEqual({
      kind: "refused",
      called: true,
      refusals: [{ rule: "batch-over-rows", pointer: "/rows", limit: 2, size: 3 }],
    });
    expect(overRowsCloses).toBe(1);
  });

  test("an error the provider throws reaches the caller as the same object, and every source is closed once", async () => {
    const { ports } = portsOf();
    const thrown = new Error(marker());

    const fromExecute = await failure(() =>
      executeCall(
        sessionOf(async () => {
          throw thrown;
        }).session,
        requestOf(),
        contextOf(),
        () => LIMITS,
        ports,
      ),
    );
    expect(fromExecute).toBe(thrown);

    const pulled = new Error(marker());
    let failingCloses = 0;
    const failing: ResultSource = {
      columns: [{ name: "v" }],
      next: async () => {
        throw pulled;
      },
      close: async () => {
        failingCloses += 1;
      },
    };
    const rest = counted([[1]]);
    const fromPull = await failure(() =>
      executeCall(
        sessionOf(async () => answerOf([failing, rest.source])).session,
        requestOf(),
        contextOf(),
        () => LIMITS,
        ports,
      ),
    );
    expect(fromPull).toBe(pulled);
    expect(failingCloses).toBe(1);
    expect(rest.seen.closes).toBe(1);

    const limitError = new Error(marker());
    const unpumped = [counted([[1]]), counted([[2]])];
    const fromLimits = await failure(() =>
      executeCall(
        sessionOf(async () => answerOf(unpumped.map((item) => item.source))).session,
        requestOf(),
        contextOf(),
        () => {
          throw limitError;
        },
        ports,
      ),
    );
    expect(fromLimits).toBe(limitError);
    expect(unpumped.map((item) => item.seen)).toEqual([
      { pulls: 0, closes: 1 },
      { pulls: 0, closes: 1 },
    ]);

    const closeError = new Error(marker());
    const brokenClose = (): ResultSource => ({
      columns: [{ name: "v" }],
      next: async () => ({ rows: [], done: true }),
      close: () => {
        throw closeError;
      },
    });
    const afterPage = await failure(() =>
      executeCall(
        sessionOf(async () => answerOf([counted([[1]]).source, brokenClose()])).session,
        requestOf(),
        contextOf(),
        () => LIMITS,
        ports,
      ),
    );
    expect(afterPage).toBe(closeError);
    const twoCloses = await failure(() =>
      executeCall(
        sessionOf(async () => answerOf([counted([[1]]).source, brokenClose(), brokenClose()])).session,
        requestOf(),
        contextOf(),
        () => LIMITS,
        ports,
      ),
    );
    expect(twoCloses).toBeInstanceOf(AggregateError);
    expect((twoCloses as AggregateError).errors).toEqual([closeError, closeError]);
    const beside = await failure(() =>
      executeCall(
        sessionOf(async () => answerOf([failing, brokenClose()])).session,
        requestOf(),
        contextOf(),
        () => LIMITS,
        ports,
      ),
    );
    expect(beside).toBeInstanceOf(AggregateError);
    expect((beside as AggregateError).errors[0]).toBe(pulled);
    expect((beside as AggregateError).errors[1]).toBe(closeError);
  });
});

describe("a stopped wait", () => {
  test("a wait the caller's signal ends answers a stop at once and sends the run's cancel with a context of its own", async () => {
    const answer = held<ExecuteAnswer>();
    const fx = sessionOf(() => answer.promise);
    const { ports, late } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());
    const runId = marker();
    const ctx = contextOf(controller);

    const running = executeCall(fx.session, requestOf({ runId }), ctx, () => LIMITS, ports);
    await fx.executeCalled;
    const before = Date.now();
    controller.abort(reason);
    const record = await running;
    const after = Date.now();

    expect(record).toEqual({ kind: "stopped", reason });
    expect((record as { readonly reason: unknown }).reason).toBe(reason);
    expect(fx.cancels).toHaveLength(1);
    const cancel = fx.cancels[0] as Seen;
    expect(cancel.request).toEqual({ runId });
    expect(Object.isFrozen(cancel.request)).toBe(true);
    expect(Object.isFrozen(cancel.ctx)).toBe(true);
    expect(cancel.ctx.signal.aborted).toBe(false);
    expect(cancel.ctx.env).toBe(ctx.env);
    expect(cancel.ctx.deadline).toBeGreaterThanOrEqual(before + CLEANUP_DEADLINE_MS);
    expect(cancel.ctx.deadline).toBeLessThanOrEqual(after + CLEANUP_DEADLINE_MS);
    answer.resolve(answerOf([]));
    await turn();
    expect(late).toEqual([]);
  });

  test("an answer that arrives after the stop has its sources closed and is never pumped", async () => {
    const answer = held<ExecuteAnswer>();
    const fx = sessionOf(() => answer.promise);
    const { ports, late } = portsOf();
    const controller = new AbortController();
    const pumpLimits = mock(() => LIMITS);

    const running = executeCall(fx.session, requestOf(), contextOf(controller), pumpLimits, ports);
    await fx.executeCalled;
    controller.abort();
    expect((await running).kind).toBe("stopped");
    const first = counted([[1]]);
    const second = counted([[2]]);
    answer.resolve(answerOf([first.source, second.source]));
    await Promise.all([first.closed, second.closed]);
    await turn();

    expect(first.seen).toEqual({ pulls: 0, closes: 1 });
    expect(second.seen).toEqual({ pulls: 0, closes: 1 });
    expect(pumpLimits).not.toHaveBeenCalled();
    expect(late).toEqual([]);
  });

  test("a failure after the stop reaches the late handler once and is never a detached rejection", async () => {
    const answer = held<ExecuteAnswer>();
    const fx = sessionOf(() => answer.promise);
    const { ports, late, firstLate } = portsOf();
    const controller = new AbortController();

    const running = executeCall(fx.session, requestOf(), contextOf(controller), () => LIMITS, ports);
    await fx.executeCalled;
    controller.abort();
    expect((await running).kind).toBe("stopped");
    const thrown = new Error(marker());
    answer.reject(thrown);

    expect(await firstLate).toBe(thrown);
    await turn();
    expect(late).toEqual([thrown]);
  });

  test("no cancel is sent to a session without console.cancel or for a request without a run id", async () => {
    const { ports } = portsOf();
    const stopped = async (calls: Calls, request: ExecuteRequest) => {
      const fx = sessionOf(() => new Promise<ExecuteAnswer>(() => {}), { calls });
      const controller = new AbortController();
      const running = executeCall(fx.session, request, contextOf(controller), () => LIMITS, ports);
      await fx.executeCalled;
      controller.abort();
      return { record: await running, cancels: fx.cancels };
    };

    const [notOffered, noRunId] = await Promise.all([
      stopped(callsOf({ cancel: false }), requestOf({ runId: marker() })),
      stopped(callsOf(), requestOf()),
    ]);

    expect(notOffered.record.kind).toBe("stopped");
    expect(notOffered.cancels).toEqual([]);
    expect(noRunId.record.kind).toBe("stopped");
    expect(noRunId.cancels).toEqual([]);
  });

  test("a cancel that fails after a stop reaches its handler once", async () => {
    const stoppedWith = async (cancel: () => Promise<CancelAnswer>) => {
      const fx = sessionOf(() => new Promise<ExecuteAnswer>(() => {}), { cancel });
      const fixture = portsOf();
      const controller = new AbortController();
      const running = executeCall(
        fx.session,
        requestOf({ runId: marker() }),
        contextOf(controller),
        () => LIMITS,
        fixture.ports,
      );
      await fx.executeCalled;
      controller.abort();
      const record = await running;
      const error = await fixture.firstCancelFailed;
      await turn();
      return { record, error, cancelFailed: fixture.cancelFailed };
    };
    const rejected = new Error(marker());
    const thrownNow = new Error(marker());

    const [later, now] = await Promise.all([
      stoppedWith(async () => {
        throw rejected;
      }),
      stoppedWith(() => {
        throw thrownNow;
      }),
    ]);

    expect(later.record.kind).toBe("stopped");
    expect(later.error).toBe(rejected);
    expect(later.cancelFailed).toEqual([rejected]);
    expect(now.error).toBe(thrownNow);
    expect(now.cancelFailed).toEqual([thrownNow]);
  });

  test("a provider that throws its own signal's reason is answered as a stop", async () => {
    const fx = sessionOf(
      (_, ctx) =>
        new Promise<ExecuteAnswer>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        }),
    );
    const { ports, late } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());

    const running = executeCall(fx.session, requestOf({ runId: marker() }), contextOf(controller), () => LIMITS, ports);
    await fx.executeCalled;
    controller.abort(reason);
    const record: ExecuteRecord = await running;
    await turn();

    expect(record).toEqual({ kind: "stopped", reason });
    expect(fx.cancels).toHaveLength(1);
    expect(late).toEqual([]);
  });
});

describe("cancelCall", () => {
  test("a cancel to a session without console.cancel is refused as a record, and the provider is never called", async () => {
    const fx = sessionOf(async () => answerOf([]), { calls: callsOf({ cancel: false }) });
    const { ports } = portsOf();

    const record = await cancelCall(fx.session, { runId: marker() }, contextOf(), ports);

    expect(record).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "facet-not-offered", pointer: "/console/cancel", name: "console.cancel" }],
    });
    expect(fx.cancels).toEqual([]);
  });

  test("a cancel of a run the provider does not know answers not cancelled", async () => {
    const fx = sessionOf(async () => answerOf([]), { cancel: async () => ({ cancelled: false }) });
    const { ports } = portsOf();
    const request = { runId: marker() };
    const ctx = contextOf();

    const record = await cancelCall(fx.session, request, ctx, ports);

    expect(record).toEqual({ kind: "answered", cancelled: false });
    expect(fx.cancels).toHaveLength(1);
    expect(fx.cancels[0]?.request).toBe(request);
    expect(fx.cancels[0]?.ctx).toBe(ctx);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  test("a cancel whose signal already aborted is refused as a record", async () => {
    const fx = sessionOf(async () => answerOf([]));
    const { ports } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());
    controller.abort(reason);

    const record = await cancelCall(fx.session, { runId: marker() }, contextOf(controller), ports);

    expect(record).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-signal-aborted", pointer: "/signal" }],
      cause: reason,
    });
    expect(fx.cancels).toEqual([]);
  });

  test("a cancel the caller stops waiting for answers a stop, and its later failure reaches the late handler once", async () => {
    const answer = held<CancelAnswer>();
    const fx = sessionOf(async () => answerOf([]), { cancel: () => answer.promise });
    const { ports, late, firstLate } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());

    const running = cancelCall(fx.session, { runId: marker() }, contextOf(controller), ports);
    await fx.cancelCalled;
    controller.abort(reason);
    const record = await running;
    const thrown = new Error(marker());
    answer.reject(thrown);

    expect(record).toEqual({ kind: "stopped", reason });
    expect(await firstLate).toBe(thrown);
    await turn();
    expect(late).toEqual([thrown]);
  });

  test("a cancel that fails reaches the caller as the same object", async () => {
    const thrown = new Error(marker());
    const fx = sessionOf(async () => answerOf([]), {
      cancel: () => {
        throw thrown;
      },
    });
    const { ports } = portsOf();
    const missing: ConsoleSession = { calls: callsOf(), execute: async () => answerOf([]) };

    const caught = await failure(() => cancelCall(fx.session, { runId: marker() }, contextOf(), ports));
    const defect = await failure(() => cancelCall(missing, { runId: marker() }, contextOf(), ports));

    expect(caught).toBe(thrown);
    expect(defect).toBeInstanceOf(Error);
    expect((defect as Error).message).toBe(
      "The session offers console.cancel and has no cancel function, a defect of the host's session.",
    );
    expect(defect).not.toBeInstanceOf(CallRefusalError);
  });
});
