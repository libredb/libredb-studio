/**
 * The host core's transaction call and a statement sent inside a transaction (src/lib/provider-host/core/console.ts;
 * docs/providers/CONTRACT.md, clauses C-48, C-57 and C-58): a transaction call is checked before it is made and refused
 * as a record, runs on a context and request frozen in place, is waited for until the call's signal, and answers the
 * session state its session answered, read by `checkTransactionAnswer`, never a state the core kept. A statement sent
 * with `transaction` answers its page with the session state the execute answered, read by `checkTransactionStatement`
 * before the page is pumped.
 *
 * Every session here is a fake whose functions the test drives through promises it settles itself; no assertion
 * follows a timer. `console-bounds.test.ts` holds a transaction call that never settles, with a real deadline, in a
 * bounded Node child.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BATCH_MAX_BYTES,
  type CallContext,
  envReader,
  type ExecuteAnswer,
  type ExecuteRequest,
  PAGE_MAX_BYTES,
  type PumpLimits,
  type ResultSource,
  rowsSource,
  type TransactionAnswer,
  type TransactionRequest,
} from "@libredb/provider-sdk/calls";
import type { SessionState } from "@libredb/provider-sdk/errors";
import type { Calls } from "@libredb/provider-sdk/manifest";
import {
  type ConsoleSession,
  consoleCalls,
  type ExecuteCall,
  type HostCallPorts,
  transactionCall,
} from "@/lib/provider-host/core/console";
import { createPageBudget } from "@/lib/provider-host/core/page-budget";

let executeCall: ExecuteCall;

beforeEach(() => {
  executeCall = consoleCalls(createPageBudget(1)).executeCall;
});

const HOUR = 3_600_000;
const marker = (): string => randomUUID();

/** A session's calls, with `console.transaction` offered unless told otherwise. */
function callsOf(transaction = true): Calls {
  return {
    console: {
      execute: { honours: ["params", "offset"] },
      cancel: "not-offered",
      endScope: "not-offered",
      transaction: transaction ? "offered" : "not-offered",
    },
  };
}

function contextOf(controller = new AbortController(), deadline = Date.now() + HOUR): CallContext {
  return { deadline, signal: controller.signal, env: envReader([], () => undefined) };
}

const LIMITS: PumpLimits = { maxRows: 2, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES };

/** Late ports that record each failure and resolve a promise with the first. */
function portsOf() {
  const late: unknown[] = [];
  const firstLate = Promise.withResolvers<unknown>();
  const ports: HostCallPorts = {
    late: (error) => {
      late.push(error);
      firstLate.resolve(error);
    },
    cancelFailed: () => {},
  };
  return { ports, late, firstLate: firstLate.promise };
}

/** A session whose transaction answers what `answer` gives, recording each call. */
function sessionOf(
  answer: (request: TransactionRequest, ctx: CallContext) => Promise<unknown>,
  options: { readonly calls?: Calls; readonly execute?: (request: ExecuteRequest) => Promise<ExecuteAnswer> } = {},
) {
  const transactions: { readonly request: TransactionRequest; readonly ctx: CallContext }[] = [];
  const called = Promise.withResolvers<void>();
  const session: ConsoleSession = {
    calls: options.calls ?? callsOf(),
    execute: options.execute ?? (async () => ({ results: [], warnings: [], executionTimeMs: 1, pageApplied: false })),
    transaction: (request, ctx) => {
      transactions.push({ request, ctx });
      called.resolve();
      return answer(request, ctx) as Promise<TransactionAnswer>;
    },
  };
  return { session, transactions, called: called.promise };
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

/** A source over one row that counts its closes. */
function counted(close: () => Promise<void> = async () => {}) {
  const inner = rowsSource([{ name: "v" }], [[marker()]]);
  const seen = { closes: 0, pulls: 0 };
  const source: ResultSource = {
    columns: inner.columns,
    next: (limit) => {
      seen.pulls += 1;
      return inner.next(limit);
    },
    close: () => {
      seen.closes += 1;
      return close();
    },
  };
  return { source, seen };
}

function statementOf(over: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return { statement: `update t set v = '${marker()}'`, page: { limit: 2, offset: 0 }, transaction: true, ...over };
}

describe("transactionCall", () => {
  test("a transaction call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called", async () => {
    const fx = sessionOf(async () => ({ sessionState: "in-transaction" }));
    const { ports } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());
    controller.abort(reason);

    const aborted = await transactionCall(fx.session, { action: "commit" }, contextOf(controller), ports);
    const late = await transactionCall(
      fx.session,
      { action: "begin" },
      contextOf(new AbortController(), Date.now() - 1),
      ports,
    );

    expect(aborted).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-signal-aborted", pointer: "/signal" }],
      cause: reason,
    });
    expect(late).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-deadline-passed", pointer: "/deadline" }],
    });
    expect(fx.transactions).toEqual([]);
  });

  test("a transaction call to a session without console.transaction is refused as a record before the call", async () => {
    const fx = sessionOf(async () => ({ sessionState: "in-transaction" }), { calls: callsOf(false) });
    const { ports } = portsOf();
    const missing: ConsoleSession = { calls: callsOf(), execute: fx.session.execute };

    const record = await transactionCall(fx.session, { action: "state" }, contextOf(), ports);
    const defect = await failure(() => transactionCall(missing, { action: "state" }, contextOf(), ports));

    expect(record).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "facet-not-offered", pointer: "/console/transaction", name: "console.transaction" }],
    });
    expect(fx.transactions).toEqual([]);
    expect(defect).toBeInstanceOf(Error);
    expect((defect as Error).message).toBe(
      "The session offers console.transaction and has no transaction function, a defect of the host's session.",
    );
  });

  test("a transaction call answers the session state it was answered, and stateReported only for a begin", async () => {
    const answers: Record<string, TransactionAnswer> = {
      begin: { sessionState: "in-transaction", stateReported: false },
      commit: { sessionState: "not-in-transaction" },
      rollback: { sessionState: "not-in-transaction" },
      state: { sessionState: "unknown" },
    };
    const fx = sessionOf(async (request) => answers[request.action]);
    const { ports } = portsOf();
    const request: TransactionRequest = { action: "begin", requireReportedState: true };
    const ctx = contextOf();

    const begin = await transactionCall(fx.session, request, ctx, ports);
    const others = await Promise.all(
      (["commit", "rollback", "state"] as const).map((action) =>
        transactionCall(fx.session, { action }, contextOf(), ports),
      ),
    );

    expect(begin).toEqual({ kind: "answered", sessionState: "in-transaction", stateReported: false });
    expect(others).toEqual([
      { kind: "answered", sessionState: "not-in-transaction" },
      { kind: "answered", sessionState: "not-in-transaction" },
      { kind: "answered", sessionState: "unknown" },
    ]);
    expect(fx.transactions[0]?.request).toBe(request);
    expect(fx.transactions[0]?.ctx).toBe(ctx);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  test("an answer the host cannot read is refused as a record after the call, never read as any state", async () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "sessionState", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "in-transaction";
      },
    });
    const cases: readonly [TransactionRequest, unknown, string][] = [
      [{ action: "state" }, {}, "/sessionState"],
      [{ action: "state" }, { sessionState: "closed" }, "/sessionState"],
      [{ action: "state" }, accessor, "/sessionState"],
      [{ action: "commit" }, { sessionState: "not-in-transaction", stateReported: true }, "/stateReported"],
      [{ action: "state" }, null, ""],
    ];
    const { ports } = portsOf();

    const records = await Promise.all(
      cases.map(([request, answer]) =>
        transactionCall(sessionOf(async () => answer).session, request, contextOf(), ports),
      ),
    );

    expect(records).toEqual(
      cases.map(([, , pointer]) => ({
        kind: "refused",
        called: true,
        refusals: [{ rule: "transaction-answer-unreadable", pointer }],
      })),
    );
    expect(getterCalls).toBe(0);
  });

  test("an error the provider throws reaches the caller as the same object", async () => {
    const rejected = new Error(marker());
    const thrownNow = new Error(marker());
    const { ports, late } = portsOf();

    const later = await failure(() =>
      transactionCall(
        sessionOf(async () => {
          throw rejected;
        }).session,
        { action: "commit" },
        contextOf(),
        ports,
      ),
    );
    const now = await failure(() =>
      transactionCall(
        sessionOf(() => {
          throw thrownNow;
        }).session,
        { action: "rollback" },
        contextOf(),
        ports,
      ),
    );

    expect(later).toBe(rejected);
    expect(now).toBe(thrownNow);
    expect(late).toEqual([]);
  });

  test("a transaction call the caller stops waiting for answers a stop at once with no state, and its later failure reaches the late handler once", async () => {
    const pending = Promise.withResolvers<TransactionAnswer>();
    const fx = sessionOf(() => pending.promise);
    const { ports, late, firstLate } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());

    const running = transactionCall(fx.session, { action: "commit" }, contextOf(controller), ports);
    await fx.called;
    controller.abort(reason);
    const record = await running;
    const thrown = new Error(marker());
    pending.reject(thrown);

    expect(record).toEqual({ kind: "stopped", reason });
    expect(await firstLate).toBe(thrown);
    await turn();
    expect(late).toEqual([thrown]);

    // A later answer is dropped: nothing reaches the late handler.
    const answered = Promise.withResolvers<TransactionAnswer>();
    const other = sessionOf(() => answered.promise);
    const otherController = new AbortController();
    const stopped = transactionCall(other.session, { action: "begin" }, contextOf(otherController), ports);
    await other.called;
    otherController.abort(reason);
    expect(await stopped).toEqual({ kind: "stopped", reason });
    answered.resolve({ sessionState: "in-transaction" });
    await turn();
    expect(late).toEqual([thrown]);
  });

  test("the core asks the session on every call and keeps no state between calls", async () => {
    let state: SessionState = "in-transaction";
    const fx = sessionOf(async () => ({ sessionState: state }));
    const { ports } = portsOf();

    const first = await transactionCall(fx.session, { action: "state" }, contextOf(), ports);
    // The session's state changes outside any call: the server ended the transaction on its own.
    state = "not-in-transaction";
    const second = await transactionCall(fx.session, { action: "state" }, contextOf(), ports);
    state = "unknown";
    const third = await transactionCall(fx.session, { action: "state" }, contextOf(), ports);

    expect([first, second, third]).toEqual([
      { kind: "answered", sessionState: "in-transaction" },
      { kind: "answered", sessionState: "not-in-transaction" },
      { kind: "answered", sessionState: "unknown" },
    ]);
    expect(fx.transactions).toHaveLength(3);
  });
});

describe("a statement sent inside a transaction", () => {
  test("a statement sent inside a transaction answers its page with the session state after it", async () => {
    const states: SessionState[] = ["in-transaction", "not-in-transaction", "unknown"];
    const { ports } = portsOf();

    const records = await Promise.all(
      states.map(async (sessionState) => {
        const { source } = counted();
        const fx = sessionOf(async () => ({ sessionState }), {
          execute: async () => ({
            results: [source],
            warnings: [],
            executionTimeMs: 2,
            pageApplied: true,
            sessionState,
          }),
        });
        const record = await executeCall(fx.session, statementOf(), contextOf(), () => LIMITS, ports);
        if (record.kind === "page") record.release();
        return record.kind === "page" ? [record.kind, record.sessionState, record.page.rows.length] : [record.kind];
      }),
    );
    const outside = counted();
    const plain = await executeCall(
      sessionOf(async () => ({ sessionState: "unknown" }), {
        execute: async () => ({ results: [outside.source], warnings: [], executionTimeMs: 2, pageApplied: true }),
      }).session,
      { statement: `select ${marker()}`, page: { limit: 2, offset: 0 } },
      contextOf(),
      () => LIMITS,
      ports,
    );

    expect(records).toEqual([
      ["page", "in-transaction", 1],
      ["page", "not-in-transaction", 1],
      ["page", "unknown", 1],
    ]);
    expect(plain.kind).toBe("page");
    if (plain.kind === "page") {
      expect(Object.hasOwn(plain, "sessionState")).toBe(false);
      plain.release();
    }
  });

  test("a statement inside a transaction whose answer carries no readable session state is refused as a record, and every source is closed once", async () => {
    const first = counted();
    const second = counted();
    const { ports } = portsOf();
    const budget = createPageBudget(1);
    const calls = consoleCalls(budget);
    const fx = sessionOf(async () => ({ sessionState: "unknown" }), {
      execute: async () =>
        ({
          results: [first.source, second.source],
          warnings: [],
          executionTimeMs: 2,
          pageApplied: true,
          sessionState: "closed",
        }) as unknown as ExecuteAnswer,
    });

    const record = await calls.executeCall(fx.session, statementOf(), contextOf(), () => LIMITS, ports);

    expect(record).toEqual({
      kind: "refused",
      called: true,
      refusals: [{ rule: "transaction-answer-unreadable", pointer: "/sessionState" }],
    });
    expect([first.seen, second.seen]).toEqual([
      { closes: 1, pulls: 0 },
      { closes: 1, pulls: 0 },
    ]);
    // The slot is held by nothing: a large page on the same budget is answered at once.
    const big = await calls.executeCall(
      sessionOf(async () => ({ sessionState: "unknown" }), {
        execute: async () => ({
          results: [counted().source],
          warnings: [],
          executionTimeMs: 2,
          pageApplied: true,
          sessionState: "in-transaction",
        }),
      }).session,
      statementOf(),
      contextOf(),
      () => LIMITS,
      ports,
    );
    expect(big.kind).toBe("page");
    if (big.kind === "page") big.release();

    // Closing that fails beside the refusal reaches the caller as the closes' errors.
    const closeFailure = new Error(marker());
    const failing = counted(async () => {
      throw closeFailure;
    });
    const missing = sessionOf(async () => ({ sessionState: "unknown" }), {
      execute: async () => ({ results: [failing.source], warnings: [], executionTimeMs: 2, pageApplied: true }),
    });
    const caught = await failure(() => executeCall(missing.session, statementOf(), contextOf(), () => LIMITS, ports));
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([closeFailure]);
    expect(failing.seen.closes).toBe(1);
  });

  test("a statement inside a transaction that its caller stops answers a stop with no state", async () => {
    const pending = Promise.withResolvers<ExecuteAnswer>();
    const started = Promise.withResolvers<void>();
    const fx = sessionOf(async () => ({ sessionState: "unknown" }), {
      execute: () => {
        started.resolve();
        return pending.promise;
      },
    });
    const { ports } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());

    const running = executeCall(fx.session, statementOf(), contextOf(controller), () => LIMITS, ports);
    await started.promise;
    controller.abort(reason);
    const record = await running;
    const late = counted();
    pending.resolve({
      results: [late.source],
      warnings: [],
      executionTimeMs: 1,
      pageApplied: true,
      sessionState: "in-transaction",
    });
    await turn();

    expect(record).toEqual({ kind: "stopped", reason });
    expect(Object.hasOwn(record, "sessionState")).toBe(false);
  });
});
