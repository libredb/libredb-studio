/**
 * The read-only execute facade (src/lib/api/read-only-execute.ts; docs/providers/CONTRACT.md, clause C-79): one agent
 * or hand-over statement runs through the host core's execute on the legacy bridge's read-only statement session, or on
 * a provider package's read-only statement session the provider factory opened through its package, under
 * a deadline of the statement timeout from its own start and the caller's signal, and keeps today's answers: the review
 * gate and the budget check first, the provider's result by reference, the row and byte refusals in the providers'
 * sentences, the time refusal's class and sentence at every wait a stop ends, and the caller's hold of a stopped call.
 *
 * The real host core is installed for the file; a case that needs to see the call, or a record the real core would
 * answer only at a real deadline, installs a core of its own around the real one and restores it. A deadline case runs
 * a short real deadline settled with a plain `await` before asserting, and a caller's leaving is driven by the test
 * once the provider's call has reached it. `read-only-execute-bounds.test.ts` holds a provider that never answers in a
 * bounded Node child. A `process.on("unhandledRejection")` counter must read zero after every abandoned call settled.
 *
 * A provider package's session is opened by the factory's own opener over packages written into a scratch providers
 * directory and admitted by Studio's boot admission (tests/helpers/package-session-fixture.ts), so the session arm runs
 * on a real contract session; each package function calls the hook the case sets, and a stop is driven on a promise the
 * execute hook settles, never on a timer. Paths are the scratch directory's real paths, the same step on every
 * platform; every password and marker is generated at run time.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, ExecuteRequest } from "@libredb/provider-sdk/calls";
import { type ReadOnlyExecuteCall, runReadOnlyExecute, runReadOnlyPage } from "@/lib/api/read-only-execute";
import { entryReadOnlyTarget, providerReadOnlyTarget } from "@/lib/api/session-target";
import { errorCode, errorKind, errorOutcome } from "@/lib/db/error-record";
import { type CachedSession, clearProviderCache, getOrCreateReadOnlyStatementSession } from "@/lib/db/factory";
import { connectionTextScrub, PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import type { EngineConnection, EngineRecord } from "@/lib/db/server-catalog";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { encodeValue } from "@libredb/provider-sdk/values";
import { PAGE_MAX_BYTES } from "@libredb/provider-sdk/calls";
import { admitSessionPackages, setHooks } from "../../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../../helpers/provider-artifacts";
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
        await runReadOnlyExecute(providerReadOnlyTarget(provider), call);
        await runReadOnlyExecute(providerReadOnlyTarget(provider), plain);
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

    expect(await runReadOnlyExecute(providerReadOnlyTarget(answering.provider), callOf())).toBe(three);
    const rows = await failure(() =>
      runReadOnlyExecute(
        providerReadOnlyTarget(answering.provider),
        callOf({ statement, budget: rowBudget, type: "mysql" }),
      ),
    );
    const plan = await runReadOnlyExecute(
      providerReadOnlyTarget(answering.provider),
      callOf({ budget: rowBudget, mode: "estimate-plan" }),
    );
    const rowBytes = measureRowBytes({ n: 1 });
    const bytes = await failure(() =>
      runReadOnlyExecute(
        providerReadOnlyTarget(answering.provider),
        callOf({ statement, budget: budgetOf({ maxResultBytes: rowBytes }) }),
      ),
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
          runReadOnlyExecute(
            providerReadOnlyTarget(provider),
            callOf({ type: "snowflake", budget: budgetOf({ maxResultRows: 0 }) }),
          ),
        ),
        await failure(() =>
          runReadOnlyExecute(providerReadOnlyTarget(provider), callOf({ budget: budgetOf({ maxResultRows: 1.5 }) })),
        ),
        await failure(() =>
          runReadOnlyExecute(providerReadOnlyTarget(provider), callOf({ budget: budgetOf({ statementTimeoutMs: 0 }) })),
        ),
        await failure(() => runReadOnlyExecute(providerReadOnlyTarget(plain), callOf({ type: "mysql" }))),
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
      const stopped = await failure(() => runReadOnlyExecute(providerReadOnlyTarget(provider), call));

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
      () => Promise.all(calls.map((call) => failure(() => runReadOnlyExecute(providerReadOnlyTarget(provider), call)))),
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
      () => failure(() => runReadOnlyExecute(providerReadOnlyTarget(provider), call)),
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

    const running = failure(() => runReadOnlyExecute(providerReadOnlyTarget(provider), call));
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
    const before = await failure(() => runReadOnlyExecute(providerReadOnlyTarget(provider), early));

    expect(before).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(before)).toBe("not-sent");
    expect(queryReadOnly).toHaveBeenCalledTimes(1);
    expect(early.held).toEqual([]);
  });

  test("a row larger than one page is refused by the host's page budget", async () => {
    const wide = "x".repeat(33 * 1024 * 1024);
    const { provider } = providerOf(async () => resultOf([{ wide }]));

    const refused = await failure(() =>
      runReadOnlyExecute(
        providerReadOnlyTarget(provider),
        callOf({ budget: budgetOf({ maxResultBytes: 64 * 1024 * 1024 }) }),
      ),
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

    expect(await failure(() => runReadOnlyExecute(providerReadOnlyTarget(provider), call))).toBe(thrown);
    expect(call.held).toEqual([]);
  });

  test("before the host core is installed the read fails by name and calls no provider", async () => {
    const { provider, queryReadOnly } = providerOf(async () => resultOf([]));
    const real = hostCore();
    forgetHostCore();
    let error: unknown;
    try {
      error = await failure(() => runReadOnlyExecute(providerReadOnlyTarget(provider), callOf()));
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
      await runReadOnlyExecute(
        providerReadOnlyTarget(provider),
        callOf({ budget: budgetOf({ statementTimeoutMs: 2_147_483_647 }) }),
      ),
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
        await runReadOnlyPage(providerReadOnlyTarget(applying.provider), { ...call, page: { limit: 4, offset: 2 } }),
        await runReadOnlyPage(providerReadOnlyTarget(notApplying.provider), { ...call, page: { limit: 4, offset: 0 } }),
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
      runReadOnlyPage(providerReadOnlyTarget(provider), {
        ...callOf({ type: "sqlite" }),
        page: { limit: 4, offset: 2 },
      }),
    );

    expect(refused).toBeInstanceOf(StudioOffsetRefusal);
    expect(errorKind(refused)).toBe("studio-offset-refusal");
    expect(errorOutcome(refused)).toBe("not-sent");
    expect(prepareQuery).toHaveBeenCalledTimes(1);
    expect(queryReadOnly).not.toHaveBeenCalled();
    expect(provider.query).not.toHaveBeenCalled();
  });
});

/** A package that honours readOnly under a row granting agent execution, its own words code-only. */
const PKG = "acmeroxmain";
/** The same, its row granting its own words through core's scrub. */
const WORDS = "acmeroxwords";
/** One that honours readOnly and offset, code-only. */
const PAGED = "acmeroxpaged";
const ADMIN = Object.freeze({ allowExternalFileAccess: true });
const REVIEWED = Object.freeze({ agentExecution: true, readRootsRequired: false });
const providers = scratchDirectory("studio-read-only-execute-session-");
let packageEngines: Map<string, EngineRecord>;

beforeAll(async () => {
  packageEngines = await admitSessionPackages(
    providers,
    [
      { name: "acme-rox-main", engine: PKG, honours: ["readOnly"] },
      { name: "acme-rox-words", engine: WORDS, honours: ["readOnly"] },
      { name: "acme-rox-paged", engine: PAGED, honours: ["readOnly", "offset"] },
    ],
    { [PKG]: REVIEWED, [WORDS]: { ...REVIEWED, ownWords: "scrubbed" }, [PAGED]: REVIEWED },
  );
});
afterAll(async () => {
  await clearProviderCache();
  removeScratch(providers);
});

/** A connection of `id`'s engine with a generated password. */
function packageConnection(id: string): EngineConnection {
  return { id: `conn-${randomUUID()}`, name: "ROX", type: id, host: "db.local", password: randomUUID() } as never;
}

/** What one execute hook received and how the case answers it. */
interface ExecuteSeen {
  readonly request: ExecuteRequest;
  readonly ctx: CallContext;
  /** The entry's running count when the call reached the package. */
  readonly running: number;
}

/**
 * A result source of `rows` under `columns`, answering in batches no larger than the pump asks for and of at most
 * `batchRows` rows.
 */
function sourceOf(columns: readonly { name: string; type?: string }[], rows: unknown[][], batchRows = rows.length) {
  let at = 0;
  return {
    columns,
    next: (limit: { maxRows: number }) => {
      const batch = rows.slice(at, at + Math.min(limit.maxRows, batchRows));
      at += batch.length;
      return Promise.resolve({ rows: batch, done: at >= rows.length });
    },
    close: () => Promise.resolve(),
  };
}

/**
 * The read-only statement session of `id` for a fresh connection, opened by the factory's opener with `open` as the
 * package's open answer, and its target; each execute calls `execute` after recording what it received.
 */
async function packageSession(
  id: string,
  execute: (seen: ExecuteSeen) => Promise<unknown>,
  open: () => unknown = () => ({ handle: { session: randomUUID() } }),
) {
  const connection = packageConnection(id);
  const seen: ExecuteSeen[] = [];
  // The entry the opener answers, read by the execute hook, which runs only after the open.
  const opened: { entry?: CachedSession } = {};
  setHooks(id, {
    open: () => Promise.resolve(open()),
    close: () => Promise.resolve(),
    health: () => Promise.resolve({ databaseSize: "1", cacheHitRatio: "1", slowQueries: [], activeSessions: [] }),
    execute: (_handle, request, ctx) => {
      const call = {
        request: request as ExecuteRequest,
        ctx: ctx as CallContext,
        running: opened.entry?.running ?? -1,
      };
      seen.push(call);
      return execute(call);
    },
  });
  const entry = await getOrCreateReadOnlyStatementSession(connection, packageEngines.get(id) as EngineRecord, ADMIN);
  opened.entry = entry;
  const scrub = connectionTextScrub(connection, undefined, "any");
  return { connection, entry, seen, target: entryReadOnlyTarget(entry, connection, scrub) };
}

/** An answer of one result of `rows` under `columns`. */
const answerOf = (
  columns: readonly { name: string; type?: string }[],
  rows: unknown[][],
  over: Record<string, unknown> = {},
) =>
  Promise.resolve({
    results: [sourceOf(columns, rows)],
    warnings: [],
    executionTimeMs: 4,
    pageApplied: false,
    ...over,
  });

describe("a provider package's read-only statement session", () => {
  test("the read-only execute runs a statement on a provider package's read-only statement session through one host core execute call, held to the budget it sends", async () => {
    const columns = [{ name: "key" }, { name: "value", type: "text" }];
    const { entry, seen, target } = await packageSession(PKG, () =>
      answerOf(columns, [
        ["alpha", 1],
        ["beta", BigInt(10)],
      ]),
    );
    const call = callOf({
      type: PKG,
      budget: { ...budgetOf(), readAllowance: new RunReadAllowance(10, { scope: "call" }) },
    });
    const result = await runReadOnlyExecute(target, call);
    expect(result).toEqual({
      rows: [
        { key: "alpha", value: 1 },
        { key: "beta", value: encodeValue(BigInt(10)) },
      ],
      fields: ["key", "value"],
      columnTypes: { value: "text" },
      rowCount: 2,
      executionTime: 4,
    });
    // One call, a fresh request of the statement, every row as one row past the budget, the budget, and no allowance.
    expect(seen.map(({ request }) => request)).toEqual([
      {
        statement: call.statement,
        page: { limit: 201, offset: 0 },
        readOnly: { budget: { maxRows: 200, maxBytes: 262_144 } },
      },
    ]);
    expect(() => seen[0]?.ctx.env.get("PATH")).toThrow();
    // The entry counted the call while it ran, and not after.
    expect([seen[0]?.running, entry.running]).toEqual([1, 0]);

    // The mode is sent where one is given, and an estimating plan is held to its bytes alone.
    const two = budgetOf({ maxResultRows: 1 });
    const plan = await runReadOnlyPage(target, {
      ...callOf({ type: PKG, budget: two, mode: "estimate-plan" }),
      page: { unlimited: true },
    });
    expect(plan.result.rows).toHaveLength(2);
    expect(seen[1]?.request.readOnly).toEqual({ budget: { maxRows: 1, maxBytes: 262_144 }, mode: "estimate-plan" });
    expect(plan.pageApplied).toBe(false);
    // An answer of one row past the budget is refused, never cut; one over the byte budget too.
    const rows = await failure(() => runReadOnlyExecute(target, callOf({ type: PKG, budget: two })));
    expect(rows).toBeInstanceOf(StudioRowBudgetRefusal);
    expect((rows as Error).message).toBe(rowBudgetSentence(2, 1));
    const bytes = await failure(() =>
      runReadOnlyExecute(target, callOf({ type: PKG, budget: budgetOf({ maxResultBytes: 10 }) })),
    );
    expect(bytes).toBeInstanceOf(StudioByteBudgetRefusal);
    expect(entry.running).toBe(0);
  });

  test("an estimating plan of every row on a provider package's session asks every row and answers a plan longer than the row budget whole", async () => {
    const plan = [[1], [2], [3], [4], [5]];
    const { seen, target } = await packageSession(PKG, () => answerOf([{ name: "op" }], plan));
    const answer = await runReadOnlyPage(target, {
      ...callOf({ type: PKG, budget: budgetOf({ maxResultRows: 1 }), mode: "estimate-plan" }),
      page: { unlimited: true },
    });
    // A plan's rows are the optimizer's operators, held to the bytes alone (clause C-78), so the page is every row.
    expect(seen.map(({ request }) => request.page)).toEqual([{ unlimited: true }]);
    expect(answer.result.rows).toEqual(plan.map(([op]) => ({ op })));
    expect(answer.result.rowCount).toBe(5);
    expect(answer.pageApplied).toBe(false);
  });

  test("a package's warnings reach the answer by its record's words grant, and a page the host cut by bytes answers none of its rows", async () => {
    const marker = randomUUID();
    const warned = {
      results: [sourceOf([{ name: "n" }], [[1]])],
      warnings: [{ message: marker }],
      executionTimeMs: 1,
      pageApplied: false,
    };
    const codeOnly = await packageSession(PKG, () => Promise.resolve(warned));
    let answered: QueryResult | undefined;
    const lines = await warningsOf(async () => {
      answered = await runReadOnlyExecute(codeOnly.target, callOf({ type: PKG }));
    });
    expect(answered?.warnings).toEqual([
      { message: "The provider package returned 1 warning; the server's log holds their words." },
    ]);
    expect(lines.filter(([line]) => line === "A provider package's execute returned a warning")).toHaveLength(1);
    const scrubbed = await packageSession(WORDS, () => Promise.resolve(warned));
    const words = await runReadOnlyExecute(scrubbed.target, callOf({ type: WORDS }));
    expect(words.warnings?.map((warning) => warning.message)).toEqual([marker]);

    // Two rows of 20 MiB: the host pumps the first, cuts the page at its 32 MiB, and Studio answers none of them.
    const wide = "x".repeat(20 * 1024 * 1024);
    const cut = await packageSession(PKG, () =>
      Promise.resolve({
        results: [sourceOf([{ name: "w" }], [[wide], [wide]], 1)],
        warnings: [],
        executionTimeMs: 1,
        pageApplied: false,
      }),
    );
    const over = await failure(() =>
      runReadOnlyExecute(cut.target, callOf({ type: PKG, budget: budgetOf({ maxResultBytes: 64 * 1024 * 1024 }) })),
    );
    expect(over).toBeInstanceOf(StudioByteBudgetRefusal);
    expect((over as Error).message).toBe(
      `The statement's result is more than the ${PAGE_MAX_BYTES} bytes one page of a result may hold, so Studio answers none of its rows.`,
    );
    expect(errorOutcome(over)).toBe("unknown");
  });

  test("a stopped or refused read-only execute on a provider package's session answers as the provider arm answers it", async () => {
    // A deadline that ends the call: the time refusal, the stopped call's settlement handed to the caller's hold.
    const pending = Promise.withResolvers<unknown>();
    const stopped = await packageSession(PKG, () => pending.promise);
    const deadlined = callOf({ type: PKG, budget: budgetOf({ statementTimeoutMs: 50 }) });
    const timed = await failure(() => runReadOnlyExecute(stopped.target, deadlined));
    expect(timed).toBeInstanceOf(StudioTimeBudgetRefusal);
    expect((timed as Error).message).toBe(timeSentence(50));
    expect(deadlined.held).toHaveLength(1);
    // Counted until the stopped call settles.
    expect(stopped.entry.running).toBe(1);
    pending.resolve({ results: [], warnings: [], executionTimeMs: 0, pageApplied: false });
    await Promise.all(deadlined.held);
    expect(stopped.entry.running).toBe(0);

    // A caller that leaves once the call reached the package: QueryCancelledError, outcome unknown.
    const reached = Promise.withResolvers<void>();
    const left = Promise.withResolvers<unknown>();
    const leaving = await packageSession(PKG, () => {
      reached.resolve();
      return left.promise;
    });
    const caller = new AbortController();
    const running = failure(() => runReadOnlyExecute(leaving.target, callOf({ type: PKG, caller: caller.signal })));
    await reached.promise;
    caller.abort();
    const cancelled = await running;
    expect(cancelled).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(cancelled)).toBe("unknown");
    left.resolve({ results: [], warnings: [], executionTimeMs: 0, pageApplied: false });
  });

  test("a paged read-only execute on a provider package's session sends the caller's page, and an offset the session does not honour is refused before the call", async () => {
    const paged = await packageSession(PAGED, () =>
      answerOf([{ name: "n" }], [[1], [2], [3], [4], [5]], { pageApplied: true }),
    );
    const answer = await runReadOnlyPage(paged.target, { ...callOf({ type: PAGED }), page: { limit: 4, offset: 2 } });
    expect(paged.seen[0]?.request.page).toEqual({ limit: 4, offset: 2 });
    expect(answer.pageApplied).toBe(true);
    // The pump takes the page's rows.
    expect(answer.result.rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

    const unpaged = await packageSession(PKG, () => answerOf([{ name: "n" }], [[1]]));
    const refused = await failure(() =>
      runReadOnlyPage(unpaged.target, { ...callOf({ type: PKG }), page: { limit: 4, offset: 2 } }),
    );
    expect(refused).toBeInstanceOf(StudioOffsetRefusal);
    expect(errorOutcome(refused)).toBe("not-sent");
    expect((refused as Error).message).toBe(
      "This connection's provider package does not take an offset, so Studio asks for no page after the first.",
    );
    expect(unpaged.seen).toEqual([]);
    // Offset 0 is no offset: sent.
    await runReadOnlyPage(unpaged.target, { ...callOf({ type: PKG }), page: { limit: 4, offset: 0 } });
    expect(unpaged.seen).toHaveLength(1);
  });

  test("a provider package's failure of a read-only execute is answered by its record's words grant, logged once and handed to the caller's packageAnswered", async () => {
    /**
     * Runs one statement on a fresh session of `id` whose execute rejects with what `thrown` builds from its password,
     * and keeps what the call's `packageAnswered` was handed.
     */
    const run = async (id: string, thrown: (password: string) => unknown) => {
      const held: { password: string } = { password: "" };
      const session = await packageSession(id, () => Promise.reject(thrown(held.password)));
      held.password = session.connection.password as string;
      const logged: unknown[][] = [];
      const handed: unknown[] = [];
      const error = spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      try {
        const failed = await failure(() =>
          runReadOnlyExecute(session.target, {
            ...callOf({ type: id }),
            packageAnswered: (answer) => handed.push(answer),
          }),
        );
        return { failed, logged, handed, password: held.password };
      } finally {
        error.mockRestore();
      }
    };
    const marker = randomUUID();
    const sentence = (value: unknown) =>
      `The provider package's execute failed (${errorCode(value)}); the server's log holds its words.`;

    // A statement failure, as a legacy provider's is, outcome unknown since the statement may have run.
    // Code-only: Studio's sentence naming its code; the words go to the log once, through the scrub.
    const codeOnly = await run(PKG, (password) => new Error(`${marker} denied for ${password}`));
    expect(codeOnly.failed).toBeInstanceOf(QueryError);
    expect(errorOutcome(codeOnly.failed)).toBe("unknown");
    expect((codeOnly.failed as Error).message).toBe(sentence(new Error(marker)));
    expect((codeOnly.failed as Error).message).not.toContain(marker);
    expect(codeOnly.logged).toHaveLength(1);
    expect(codeOnly.logged[0]?.[0]).toBe("A provider package's execute failed");
    expect(JSON.stringify(codeOnly.logged)).not.toContain(codeOnly.password);
    expect(codeOnly.password).not.toBe("");
    // The answer thrown is the one handed to the caller, by identity.
    expect(codeOnly.handed).toHaveLength(1);
    expect(codeOnly.handed[0]).toBe(codeOnly.failed);

    // A value that is no error answers Studio's sentence under code-only.
    const plain = await run(PKG, () => marker);
    expect(plain.failed).toBeInstanceOf(QueryError);
    expect((plain.failed as Error).message).toBe(sentence(marker));
    expect(plain.logged).toHaveLength(1);

    // Scrubbed: the error's own words through core's scrub, the connection's password withheld, logged once.
    const words = await run(WORDS, () => new Error(marker));
    expect(words.failed).toBeInstanceOf(QueryError);
    expect((words.failed as Error).message).toBe(marker);
    expect(words.logged).toHaveLength(1);
    expect(words.handed).toHaveLength(1);
    expect(words.handed[0]).toBe(words.failed);
    const withheld = await run(WORDS, (password) => new Error(`${marker} denied for ${password}`));
    expect(withheld.failed).toBeInstanceOf(QueryError);
    expect((withheld.failed as Error).message).toBe(PROVIDER_TEXT_WITHHELD);
    expect(JSON.stringify(withheld.logged)).not.toContain(withheld.password);

    // A malformed answer is the package's defect, a statement failure in the package-defect words.
    const malformed = await packageSession(PKG, () =>
      Promise.resolve({ results: "not a list", warnings: [], executionTimeMs: 1, pageApplied: false }),
    );
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    let defect: unknown;
    try {
      defect = await failure(() => runReadOnlyExecute(malformed.target, callOf({ type: PKG })));
    } finally {
      error.mockRestore();
    }
    expect(defect).toBeInstanceOf(QueryError);
    expect((defect as Error).message.startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);

    // Studio's own failure passes as raised and is not logged as the package's.
    const studio = new StudioTimeBudgetRefusal(timeSentence(1));
    const own = await run(PKG, () => studio);
    expect(own.failed).toBe(studio);
    expect(own.logged).toEqual([]);
    expect(own.handed).toEqual([]);
  });

  test("a row budget whose one-row-past page is no safe integer is refused on a provider package's session before the package is called", async () => {
    const largest = Number.MAX_SAFE_INTEGER - 1;
    const sentence = `Read-only execution budget field maxResultRows must be a positive integer <= ${largest} on a provider package's read-only statement session, which Studio asks for one row past it`;
    const { seen, target } = await packageSession(PKG, () => answerOf([{ name: "n" }], [[1]]));
    const over = budgetOf({ maxResultRows: Number.MAX_SAFE_INTEGER });
    // Every mode and page: an executing statement, an estimating plan, and a paged call.
    const refusals = await Promise.all([
      failure(() => runReadOnlyExecute(target, callOf({ type: PKG, budget: over }))),
      failure(() => runReadOnlyExecute(target, callOf({ type: PKG, budget: over, mode: "estimate-plan" }))),
      failure(() => runReadOnlyPage(target, { ...callOf({ type: PKG, budget: over }), page: { limit: 1, offset: 0 } })),
    ]);
    for (const refused of refusals) {
      expect(refused).toBeInstanceOf(QueryError);
      expect((refused as Error).message).toBe(sentence);
      expect(errorOutcome(refused)).toBe("not-sent");
    }
    expect(seen).toEqual([]);
    // One below is sent, its page one row past it the largest safe integer.
    await runReadOnlyExecute(target, callOf({ type: PKG, budget: budgetOf({ maxResultRows: largest }) }));
    expect(seen.map(({ request }) => request.page)).toEqual([{ limit: Number.MAX_SAFE_INTEGER, offset: 0 }]);

    // The provider arm takes both, since its bridge asks for no page past the budget.
    const { provider, queryReadOnly } = providerOf(async () => resultOf([{ n: 1 }]));
    await Promise.all(
      [Number.MAX_SAFE_INTEGER, largest].map((maxResultRows) =>
        runReadOnlyExecute(providerReadOnlyTarget(provider), callOf({ budget: budgetOf({ maxResultRows }) })),
      ),
    );
    expect(queryReadOnly).toHaveBeenCalledTimes(2);
  });

  test("a read-only target is the session form only for a provider package's entry, and the facade refuses a target of another engine than its call's", async () => {
    const { target } = await packageSession(PKG, () => answerOf([{ name: "n" }], [[1]]));
    expect(target.form).toBe("session");
    // A legacy provider's entry reaches no read-only target: its statements go through the execution-profile acquisition.
    const legacyEntry = { opened: { form: "provider", provider: createMockProvider() } } as unknown as CachedSession;
    expect(() =>
      entryReadOnlyTarget(
        legacyEntry,
        packageConnection(PKG),
        connectionTextScrub(packageConnection(PKG), undefined, "any"),
      ),
    ).toThrow(
      "A legacy provider's cache entry reached the read-only statement target of a provider package's session: a host defect.",
    );
    // A call naming another engine than the session's is a host defect, refused before anything is sent.
    expect(await failure(() => runReadOnlyExecute(target, callOf({ type: WORDS })))).toBeInstanceOf(Error);
    expect(((await failure(() => runReadOnlyExecute(target, callOf({ type: WORDS })))) as Error).message).toBe(
      `A read-only execute named the engine "${WORDS}" on the read-only statement session of "${PKG}": a host defect.`,
    );
    // A provider target of a provider package's engine is a host defect too.
    const { provider, queryReadOnly } = providerOf(async () => resultOf([{ n: 1 }]));
    expect(
      ((await failure(() => runReadOnlyExecute(providerReadOnlyTarget(provider), callOf({ type: PKG })))) as Error)
        .message,
    ).toBe(
      `A read-only execute named the engine "${PKG}", which a provider package serves, on a legacy provider: a host defect.`,
    );
    expect(queryReadOnly).not.toHaveBeenCalled();
  });
});
