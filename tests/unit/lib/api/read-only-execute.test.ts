/**
 * The read-only execute facade (src/lib/api/read-only-execute.ts; docs/providers/CONTRACT.md, clause C-79): one agent
 * or hand-over statement runs through the host core's execute on the legacy bridge's read-only statement session, under
 * a deadline of the statement timeout from its own start and the caller's signal, and keeps today's answers: the review
 * gate and the budget check first, the provider's result by reference, the row and byte refusals in the providers'
 * sentences, the time refusal's class and sentence at every wait a stop ends, and the caller's hold of a stopped call.
 *
 * The real host core is installed for the file; a case that needs to see the call, or a record the real core would
 * answer only at a real deadline, installs a core of its own around the real one and restores it. A deadline case runs
 * a short real deadline settled with a plain `await` before asserting, and a caller's leaving is driven by the test
 * once the provider's call has reached it. `read-only-execute-bounds.test.ts` holds a provider that never answers in a
 * bounded Node child. A `process.on("unhandledRejection")` counter must read zero after every abandoned call settled.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, ExecuteRequest } from "@libredb/provider-sdk/calls";
import { type ReadOnlyExecuteCall, runReadOnlyExecute, runReadOnlyPage } from "@/lib/api/read-only-execute";
import { errorKind, errorOutcome } from "@/lib/db/error-record";
import {
  ExecutionProfileError,
  QueryCancelledError,
  QueryError,
  StudioByteBudgetRefusal,
  StudioOffsetRefusal,
  StudioProfileRefusal,
  StudioRowBudgetRefusal,
  StudioTimeBudgetRefusal,
} from "@/lib/db/errors";
import { byteBudgetSentence, measureRowBytes, rowBudgetSentence } from "@/lib/db/read-only-budget";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type { DatabaseProvider, ReadOnlyStatementBudget } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, HostCoreBootOrderError, hostCore, installHostCore } from "@/lib/provider-host/instance";
import type { QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

const ROUTE = "read-only-execute-test";
const marker = (): string => randomUUID();

const resultOf = (rows: Record<string, unknown>[]): QueryResult => ({
  rows,
  fields: Object.keys(rows[0] ?? { n: 1 }),
  rowCount: rows.length,
  executionTime: 2,
});

/** A provider whose read-only path answers what `answer` gives, beside a plain path that is never to be called. */
function providerOf(answer: () => Promise<QueryResult>) {
  const reached = Promise.withResolvers<void>();
  const queryReadOnly = mock<(...args: unknown[]) => Promise<QueryResult>>(() => {
    reached.resolve();
    return answer();
  });
  const provider: DatabaseProvider = Object.assign(createMockProvider(), { queryReadOnly });
  return { provider, queryReadOnly, reached: reached.promise };
}

/** The budget the provider's read-only path was handed on its call at `index`. */
function budgetAt(
  queryReadOnly: { readonly mock: { readonly calls: unknown[][] } },
  index: number,
): ReadOnlyStatementBudget {
  const call = queryReadOnly.mock.calls[index];
  if (call === undefined) throw new Error(`The provider's read-only path has no call at ${index}.`);
  return call[1] as ReadOnlyStatementBudget;
}

const budgetOf = (over: Partial<ReadOnlyStatementBudget> = {}): ReadOnlyStatementBudget => ({
  statementTimeoutMs: 60_000,
  maxResultRows: 200,
  maxResultBytes: 262_144,
  ...over,
});

/** One call of the facade, a statement and a caller of its own, each member overridable. */
function callOf(over: Partial<ReadOnlyExecuteCall> = {}): ReadOnlyExecuteCall & { readonly held: Promise<void>[] } {
  const held: Promise<void>[] = [];
  return {
    type: "postgres",
    statement: `SELECT ${marker()}`,
    budget: budgetOf(),
    caller: new AbortController().signal,
    route: ROUTE,
    holdUntilSettled: (settled) => {
      held.push(Promise.resolve(settled).then(() => undefined));
    },
    ...over,
    held,
  };
}

/** Runs `body` on a core `make` builds around the real one, then restores the real one. */
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

/** Every warning `body` logged. */
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

const timeSentence = (ms: number) => `Read-only execution exceeded the time budget: no answer within ${ms}ms`;

describe("runReadOnlyExecute", () => {
  test("a read-only execute runs the provider's read-only path once through one host core execute call, on a fresh request and a context of deadline, signal and env alone", async () => {
    const result = resultOf([{ n: 1 }]);
    const { provider, queryReadOnly } = providerOf(async () => result);
    const readAllowance = new RunReadAllowance(3);
    const seen: { request: ExecuteRequest; ctx: CallContext }[] = [];
    const call = callOf({ budget: budgetOf({ statementTimeoutMs: 5_000, readAllowance }), mode: "estimate-plan" });
    const plain = callOf({ budget: budgetOf({ statementTimeoutMs: 5_000 }) });
    const before = Date.now();

    await withCore(
      (real) => ({
        ...real,
        executeCall: (session, request, ctx, limits, ports) => {
          seen.push({ request, ctx });
          return real.executeCall(session, request, ctx, limits, ports);
        },
      }),
      async () => {
        await runReadOnlyExecute(provider, call);
        await runReadOnlyExecute(provider, plain);
      },
    );
    const after = Date.now();

    expect(queryReadOnly).toHaveBeenCalledTimes(2);
    expect(provider.query).not.toHaveBeenCalled();
    expect(provider.prepareQuery).not.toHaveBeenCalled();
    expect(queryReadOnly.mock.calls[0]).toEqual([
      call.statement,
      { statementTimeoutMs: 5_000, maxResultRows: 200, maxResultBytes: 262_144, readAllowance },
      "estimate-plan",
    ]);
    expect(budgetAt(queryReadOnly, 0).readAllowance).toBe(readAllowance);
    expect(queryReadOnly.mock.calls[0]?.[1]).not.toBe(call.budget);
    expect(queryReadOnly.mock.calls[1]?.[2]).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.request).toEqual({
      statement: call.statement,
      page: { unlimited: true },
      readOnly: { budget: { maxRows: 200, maxBytes: 262_144 }, mode: "estimate-plan" },
    });
    expect(seen[1]?.request).toEqual({
      statement: plain.statement,
      page: { unlimited: true },
      readOnly: { budget: { maxRows: 200, maxBytes: 262_144 } },
    });
    expect(Object.hasOwn(seen[1]?.request.readOnly ?? {}, "mode")).toBe(false);
    for (const { ctx } of seen) {
      expect(Reflect.ownKeys(ctx).sort()).toEqual(["deadline", "env", "signal"]);
      expect(ctx.deadline).toBeGreaterThanOrEqual(before + 5_000);
      expect(ctx.deadline).toBeLessThanOrEqual(after + 5_000);
      expect(ctx.signal.aborted).toBe(false);
    }
    expect(Object.isFrozen(call.budget)).toBe(false);
    expect(call.held).toEqual([]);
  });

  test("its answer is the provider's result by reference, held to the row budget, except for an estimating plan, and to the byte budget, in the providers' sentences", async () => {
    const three = resultOf([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const answering = providerOf(async () => three);
    const statement = `SELECT ${marker()}`;
    const rowBudget = budgetOf({ maxResultRows: 2 });

    expect(await runReadOnlyExecute(answering.provider, callOf())).toBe(three);
    const rows = await failure(() =>
      runReadOnlyExecute(answering.provider, callOf({ statement, budget: rowBudget, type: "mysql" })),
    );
    const plan = await runReadOnlyExecute(answering.provider, callOf({ budget: rowBudget, mode: "estimate-plan" }));
    const rowBytes = measureRowBytes({ n: 1 });
    const bytes = await failure(() =>
      runReadOnlyExecute(answering.provider, callOf({ statement, budget: budgetOf({ maxResultBytes: rowBytes }) })),
    );

    expect(rows).toBeInstanceOf(StudioRowBudgetRefusal);
    expect((rows as Error).message).toBe(rowBudgetSentence(3, 2));
    expect((rows as QueryError).provider).toBe("mysql");
    expect((rows as QueryError).query).toBe(statement);
    expect(plan).toBe(three);
    expect(bytes).toBeInstanceOf(StudioByteBudgetRefusal);
    expect((bytes as Error).message).toBe(byteBudgetSentence(rowBytes * 2, rowBytes));
    expect((bytes as QueryError).query).toBe(statement);
  });

  test("an engine off the review record, a budget that is not whole positive numbers and a provider without a read-only path are each refused by name before any provider call", async () => {
    const { provider, queryReadOnly } = providerOf(async () => resultOf([]));
    const plain: DatabaseProvider = createMockProvider();
    const seen: string[] = [];

    const refusals = await withCore(
      (real) => ({
        ...real,
        executeCall: (...args) => {
          seen.push("execute");
          return real.executeCall(...args);
        },
      }),
      async () => [
        await failure(() =>
          runReadOnlyExecute(provider, callOf({ type: "snowflake", budget: budgetOf({ maxResultRows: 0 }) })),
        ),
        await failure(() => runReadOnlyExecute(provider, callOf({ budget: budgetOf({ maxResultRows: 1.5 }) }))),
        await failure(() => runReadOnlyExecute(provider, callOf({ budget: budgetOf({ statementTimeoutMs: 0 }) }))),
        await failure(() => runReadOnlyExecute(plain, callOf({ type: "mysql" }))),
      ],
    );
    const [notReviewed, fractional, zeroTime, without] = refusals;

    expect(notReviewed).toBeInstanceOf(ExecutionProfileError);
    expect((notReviewed as ExecutionProfileError).reasonCode).toBe("PROFILE_ENGINE_NOT_REVIEWED");
    for (const error of [fractional, zeroTime]) {
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toMatch(/^Read-only execution budget field \w+ must be a positive integer/);
    }
    expect(without).toBeInstanceOf(StudioProfileRefusal);
    expect((without as StudioProfileRefusal).reasonCode).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
    expect((without as Error).message).toBe(
      'Provider type "mysql" implements no read-only statement path (queryReadOnly)',
    );
    expect(seen).toEqual([]);
    expect(queryReadOnly).not.toHaveBeenCalled();
    expect(plain.query).not.toHaveBeenCalled();
  });

  test("a statement its deadline stopped is refused in the time budget's sentence, its settlement handed to the caller's hold, and a later failure is logged by kind and code only", async () => {
    const secret = marker();
    const pending = Promise.withResolvers<QueryResult>();
    const { provider } = providerOf(() => pending.promise);
    const call = callOf({ budget: budgetOf({ statementTimeoutMs: 50 }), type: "sqlite" });
    let settledSeen = false;

    const warned = await warningsOf(async () => {
      const stopped = await failure(() => runReadOnlyExecute(provider, call));

      expect(stopped).toBeInstanceOf(StudioTimeBudgetRefusal);
      expect((stopped as Error).message).toBe(timeSentence(50));
      expect((stopped as QueryError).provider).toBe("sqlite");
      expect((stopped as QueryError).query).toBe(call.statement);
      expect(errorKind(stopped)).toBe("studio-time-budget-refusal");
      expect(errorOutcome(stopped)).toBe("unknown");
      expect(call.held).toHaveLength(1);
      const held = call.held[0]?.then(() => {
        settledSeen = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settledSeen).toBe(false);
      pending.reject(new Error(secret));
      await held;
      expect(settledSeen).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(warned).toEqual([
      [
        "A statement Studio stopped waiting for failed afterwards",
        { route: ROUTE, kind: "internal", code: "INTERNAL_ERROR" },
      ],
    ]);
    expect(JSON.stringify(warned)).not.toContain(secret);
  });

  test("a stop at any wait of the run answers the time refusal", async () => {
    const { provider, queryReadOnly } = providerOf(async () => resultOf([]));
    const reason = new DOMException("The call's deadline has passed.", "TimeoutError");

    const waits = [undefined, "large-page-slot", "page", "other-results"] as const;
    const calls = waits.map(() => callOf({ budget: budgetOf({ statementTimeoutMs: 1_234 }) }));
    const pending = [...waits];
    // One stub core for the four calls, each answered the stop of the next wait in turn.
    const stopped = await withCore(
      (real) => ({
        ...real,
        executeCall: async () => {
          const waitingFor = pending.shift();
          return {
            kind: "stopped" as const,
            reason,
            ...(waitingFor === undefined ? {} : { waitingFor }),
            settled: Promise.resolve(),
          };
        },
      }),
      () => Promise.all(calls.map((call) => failure(() => runReadOnlyExecute(provider, call)))),
    );

    expect(pending).toEqual([]);
    for (const error of stopped) {
      expect(error).toBeInstanceOf(StudioTimeBudgetRefusal);
      expect((error as Error).message).toBe(timeSentence(1_234));
      expect(errorOutcome(error)).toBe("unknown");
    }
    expect(calls.map((call) => call.held.length)).toEqual([1, 1, 1, 1]);
    expect(queryReadOnly).not.toHaveBeenCalled();
  });

  test("a statement whose deadline passed before its call starts is refused in the time budget's sentence, outcome not-sent, and never reaches the provider", async () => {
    const { provider, queryReadOnly } = providerOf(async () => resultOf([]));
    const call = callOf({ budget: budgetOf({ statementTimeoutMs: 1 }), type: "mysql" });
    const records: Awaited<ReturnType<HostCore["executeCall"]>>[] = [];

    const refused = await withCore(
      (real) => ({
        ...real,
        executeCall: async (session, request, ctx, limits, ports) => {
          // Held past the deadline without yielding, so the deadline passes before the signal's timer can fire.
          while (Date.now() < ctx.deadline) {
            // Waits out the one millisecond.
          }
          const record = await real.executeCall(session, request, ctx, limits, ports);
          records.push(record);
          return record;
        },
      }),
      () => failure(() => runReadOnlyExecute(provider, call)),
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-deadline-passed", pointer: "/deadline" }],
    });
    expect(refused).toBeInstanceOf(StudioTimeBudgetRefusal);
    expect((refused as Error).message).toBe(timeSentence(1));
    expect((refused as QueryError).provider).toBe("mysql");
    expect((refused as QueryError).query).toBe(call.statement);
    expect(errorKind(refused)).toBe("studio-time-budget-refusal");
    expect(errorOutcome(refused)).toBe("not-sent");
    expect(queryReadOnly).not.toHaveBeenCalled();
    expect(call.held).toEqual([]);
  });

  test("a statement whose caller left is QueryCancelledError: outcome unknown once sent, not-sent before", async () => {
    const pending = Promise.withResolvers<QueryResult>();
    const { provider, queryReadOnly, reached } = providerOf(() => pending.promise);
    const controller = new AbortController();
    const call = callOf({ caller: controller.signal });

    const running = failure(() => runReadOnlyExecute(provider, call));
    await reached;
    controller.abort(new Error(marker()));
    const left = await running;
    pending.resolve(resultOf([]));
    await call.held[0];

    expect(left).toBeInstanceOf(QueryCancelledError);
    expect((left as Error).message).toBe("The query was cancelled.");
    expect(errorOutcome(left)).toBe("unknown");
    expect(call.held).toHaveLength(1);

    const gone = new AbortController();
    gone.abort(new Error(marker()));
    const early = callOf({ caller: gone.signal });
    const before = await failure(() => runReadOnlyExecute(provider, early));

    expect(before).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(before)).toBe("not-sent");
    expect(queryReadOnly).toHaveBeenCalledTimes(1);
    expect(early.held).toEqual([]);
  });

  test("a row larger than one page is refused by the host's page budget", async () => {
    const wide = "x".repeat(33 * 1024 * 1024);
    const { provider } = providerOf(async () => resultOf([{ wide }]));

    const refused = await failure(() =>
      runReadOnlyExecute(provider, callOf({ budget: budgetOf({ maxResultBytes: 64 * 1024 * 1024 }) })),
    );

    expect(refused).toBeInstanceOf(StudioByteBudgetRefusal);
    expect((refused as Error).message).toMatch(
      /^A row of the result is \d+ bytes, over the 33554432 bytes one page of a result may hold, so Studio answers no page of it\.$/,
    );
    expect(errorOutcome(refused)).toBe("unknown");
  });

  test("a provider's error passes as the same object", async () => {
    const thrown = new Error(marker());
    const { provider } = providerOf(async () => {
      throw thrown;
    });
    const call = callOf();

    expect(await failure(() => runReadOnlyExecute(provider, call))).toBe(thrown);
    expect(call.held).toEqual([]);
  });

  test("before the host core is installed the read fails by name and calls no provider", async () => {
    const { provider, queryReadOnly } = providerOf(async () => resultOf([]));
    const real = hostCore();
    forgetHostCore();
    let error: unknown;
    try {
      error = await failure(() => runReadOnlyExecute(provider, callOf()));
    } finally {
      installHostCore(real, "test");
    }

    expect(error).toBeInstanceOf(HostCoreBootOrderError);
    expect(queryReadOnly).not.toHaveBeenCalled();
  });

  test("a time budget at the longest a timer waits builds its deadline", async () => {
    const result = resultOf([{ n: 1 }]);
    const { provider, queryReadOnly } = providerOf(async () => result);

    expect(
      await runReadOnlyExecute(provider, callOf({ budget: budgetOf({ statementTimeoutMs: 2_147_483_647 }) })),
    ).toBe(result);
    expect(budgetAt(queryReadOnly, 0).statementTimeoutMs).toBe(2_147_483_647);
  });
});

describe("runReadOnlyPage", () => {
  /**
   * A provider whose prepare answers `wasLimited` with a text of its own, and whose read-only path answers `result`.
   */
  function pagingProviderOf(wasLimited: boolean, result: QueryResult) {
    const prepared = `SELECT ${marker()}`;
    const prepareQuery = mock((_statement: string, options: { limit: number; offset: number }) => ({
      query: prepared,
      wasLimited,
      ...options,
    }));
    const queryReadOnly = mock<(...args: unknown[]) => Promise<QueryResult>>(async () => result);
    const provider: DatabaseProvider = Object.assign(createMockProvider(), { prepareQuery, queryReadOnly });
    return { provider, prepareQuery, queryReadOnly, prepared };
  }

  test("a paged read-only execute sends its page through one host core execute call and answers whether the provider applied it", async () => {
    const result = resultOf([{ n: 1 }, { n: 2 }]);
    const applying = pagingProviderOf(true, result);
    const notApplying = pagingProviderOf(false, result);
    const seen: ExecuteRequest[] = [];
    const call = callOf({ type: "sqlite" });

    const [applied, notApplied] = await withCore(
      (real) => ({
        ...real,
        executeCall: (session, request, ctx, limits, ports) => {
          seen.push(request);
          return real.executeCall(session, request, ctx, limits, ports);
        },
      }),
      async () => [
        await runReadOnlyPage(applying.provider, { ...call, page: { limit: 4, offset: 2 } }),
        await runReadOnlyPage(notApplying.provider, { ...call, page: { limit: 4, offset: 0 } }),
      ],
    );

    expect(seen).toEqual([
      {
        statement: call.statement,
        page: { limit: 4, offset: 2 },
        readOnly: { budget: { maxRows: 200, maxBytes: 262_144 } },
      },
      {
        statement: call.statement,
        page: { limit: 4, offset: 0 },
        readOnly: { budget: { maxRows: 200, maxBytes: 262_144 } },
      },
    ]);
    expect(applied).toEqual({ result, pageApplied: true });
    expect(applied.result).toBe(result);
    expect(notApplied).toEqual({ result, pageApplied: false });
    expect(applying.prepareQuery.mock.calls).toEqual([[call.statement, { limit: 4, offset: 2 }]]);
    expect(applying.queryReadOnly.mock.calls[0]?.[0]).toBe(applying.prepared);
    expect(notApplying.queryReadOnly.mock.calls[0]?.[0]).toBe(notApplying.prepared);
    expect(applying.provider.query).not.toHaveBeenCalled();
  });

  test("a paged read-only execute whose offset the provider's prepare did not apply is refused as Studio's own refusal before the read-only path is called", async () => {
    const { provider, prepareQuery, queryReadOnly } = pagingProviderOf(false, resultOf([{ n: 1 }]));

    const refused = await failure(() =>
      runReadOnlyPage(provider, { ...callOf({ type: "sqlite" }), page: { limit: 4, offset: 2 } }),
    );

    expect(refused).toBeInstanceOf(StudioOffsetRefusal);
    expect(errorKind(refused)).toBe("studio-offset-refusal");
    expect(errorOutcome(refused)).toBe("not-sent");
    expect(prepareQuery).toHaveBeenCalledTimes(1);
    expect(queryReadOnly).not.toHaveBeenCalled();
    expect(provider.query).not.toHaveBeenCalled();
  });
});
