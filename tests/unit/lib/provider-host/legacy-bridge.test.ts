/**
 * The legacy bridge (src/lib/provider-host/legacy-bridge.ts; docs/providers/CONTRACT.md, clause C-50): a legacy
 * `DatabaseProvider` served as a session of console execute, cancel, endScope and transaction, its declared calls, the
 * copies it hands the provider, today's provider steps, one source per result set, the measured form of a row and the
 * page's row limit.
 *
 * Every provider here is a fake the test builds; every marker is generated at run time and no timer runs.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BATCH_MAX_BYTES,
  type CallContext,
  encodedRowBytes,
  envReader,
  type ExecuteAnswer,
  type ExecuteRequest,
  freezeData,
  PAGE_MAX_BYTES,
  pumpPage,
  type ResultSource,
} from "@libredb/provider-sdk/calls";
import {
  type BeginTransactionResult,
  type DatabaseProvider,
  isTransactionProvider,
  type PreparedQuery,
  type QueryPrepareOptions,
} from "@/lib/db/types";
import type { ConsoleSession } from "@/lib/provider-host/core/console";
import { runEditorQuery } from "@/lib/api/editor-query";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { appendedBoundNote } from "@/lib/db/utils/query-limiter";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";
import type { QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";

// The editor query reads the process's host core (src/lib/provider-host/instance.ts), so this file composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const HOUR = 3_600_000;
const marker = (): string => randomUUID();

/** The limiter's rule as a SQL provider applies it: a bound of ours, unless the text carries its own LIMIT. */
function limiter(sql: string, options: QueryPrepareOptions = {}): PreparedQuery {
  const limit = options.limit ?? 500;
  const offset = options.offset ?? 0;
  if (options.unlimited === true || /\blimit\b/i.test(sql)) return { query: sql, wasLimited: false, limit, offset };
  return { query: `${sql} LIMIT ${limit} OFFSET ${offset}`, wasLimited: true, limit, offset };
}

const resultOf = (rows: Record<string, unknown>[], more: Partial<QueryResult> = {}): QueryResult => ({
  rows,
  fields: ["n"],
  rowCount: rows.length,
  executionTime: 3,
  ...more,
});
const rowsOf = (count: number) => Array.from({ length: count }, (_, n) => ({ n: n + 1 }));

function fake(answer: QueryResult | Error, extra: Record<string, unknown> = {}): DatabaseProvider {
  return Object.assign(
    createMockProvider(),
    {
      prepareQuery: mock(limiter),
      query: mock(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    },
    extra,
  );
}

const callsOf = (fn: unknown) => (fn as ReturnType<typeof mock>).mock.calls;

/**
 * A provider with the five transaction methods, over a session whose state the test sets through `open`: a begin opens
 * it, a COMMIT or ROLLBACK closes it, and `isInTransaction` reads it. A begin answers `begun` when given.
 */
function transactionalFake(begun?: BeginTransactionResult, extra: Record<string, unknown> = {}) {
  const fx = {
    open: false,
    provider: undefined as unknown as DatabaseProvider & {
      beginTransaction: ReturnType<typeof mock>;
      commitTransaction: ReturnType<typeof mock>;
      rollbackTransaction: ReturnType<typeof mock>;
      isInTransaction: ReturnType<typeof mock>;
      queryInTransaction: ReturnType<typeof mock>;
    },
  };
  fx.provider = Object.assign(fake(resultOf([])), {
    beginTransaction: mock(async () => {
      fx.open = true;
      return begun;
    }),
    commitTransaction: mock(async () => {
      fx.open = false;
    }),
    rollbackTransaction: mock(async () => {
      fx.open = false;
    }),
    isInTransaction: mock(() => fx.open),
    queryInTransaction: mock(async () => resultOf([])),
    ...extra,
  });
  return fx;
}

function contextOf(): CallContext {
  return { deadline: Date.now() + HOUR, signal: new AbortController().signal, env: envReader([], () => undefined) };
}

function requestOf(over: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return freezeData({ statement: "SELECT n FROM t", page: { limit: 2, offset: 0 }, ...over });
}

const PAGE = { maxRows: 1_000, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES } as const;

/** What `run` threw; a run that does not throw fails the case. */
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("The call was expected to fail, and it answered.");
}

describe("bridgedConsole", () => {
  test("a bridged session honours params and offset, offers cancel only where the provider cancels, and endScope only where the provider ends its query path's transactions", () => {
    const cancelling = bridgedConsole(fake(resultOf([]), { cancelQuery: mock(async () => true) }), {});
    const plain = bridgedConsole(fake(resultOf([])), {});
    const ending = bridgedConsole(fake(resultOf([]), { endOpenQueryTransaction: mock(async () => "none") }), {});

    expect(cancelling.session.calls).toEqual({
      console: {
        execute: { honours: ["params", "offset"] },
        cancel: "offered",
        endScope: "not-offered",
        transaction: "not-offered",
      },
    });
    expect(plain.session.calls.console.cancel).toBe("not-offered");
    expect(typeof cancelling.session.cancel).toBe("function");
    expect(plain.session.cancel).toBeUndefined();
    expect(plain.session.calls.console.endScope).toBe("not-offered");
    expect(plain.session.endScope).toBeUndefined();
    expect(cancelling.session.endScope).toBeUndefined();
    expect(ending.session.calls).toEqual({
      console: {
        execute: { honours: ["params", "offset"] },
        cancel: "not-offered",
        endScope: "offered",
        transaction: "not-offered",
      },
    });
    expect(typeof ending.session.endScope).toBe("function");
    expect(Object.isFrozen(cancelling.session.calls)).toBe(true);
    expect(Object.isFrozen(cancelling.session.calls.console.execute.honours)).toBe(true);
  });

  test("a bridged session offers the transaction facet exactly where the provider is a TransactionProvider", () => {
    const transactional = transactionalFake();
    const missingOne = fake(resultOf([]), {
      beginTransaction: mock(async () => {}),
      commitTransaction: mock(async () => {}),
      isInTransaction: mock(() => false),
    });

    const bridged = bridgedConsole(transactional.provider, {});
    expect(bridged.session.calls.console.transaction).toBe("offered");
    expect(typeof bridged.session.transaction).toBe("function");
    for (const provider of [missingOne, fake(resultOf([]))]) {
      const plain = bridgedConsole(provider, {});
      expect(plain.session.calls.console.transaction).toBe("not-offered");
      expect(Object.hasOwn(plain.session, "transaction")).toBe(false);
    }
    expect(isTransactionProvider(transactional.provider)).toBe(true);
    expect(isTransactionProvider(missingOne)).toBe(false);
    expect(isTransactionProvider(null)).toBe(false);
    expect(isTransactionProvider("provider")).toBe(false);
  });

  test("a bridged begin, COMMIT, ROLLBACK and state read call the provider's methods and answer its state after each", async () => {
    const fx = transactionalFake();
    const { session } = bridgedConsole(fx.provider, {});
    const transaction = session.transaction as NonNullable<typeof session.transaction>;

    const begin = await transaction({ action: "begin" }, contextOf());
    const state = await transaction({ action: "state" }, contextOf());
    const commit = await transaction({ action: "commit" }, contextOf());
    fx.open = true;
    const rollback = await transaction({ action: "rollback" }, contextOf());

    expect(begin).toEqual({ sessionState: "in-transaction" });
    expect(state).toEqual({ sessionState: "in-transaction" });
    expect(commit).toEqual({ sessionState: "not-in-transaction" });
    expect(rollback).toEqual({ sessionState: "not-in-transaction" });
    expect(callsOf(fx.provider.beginTransaction)).toHaveLength(1);
    expect(callsOf(fx.provider.commitTransaction)).toHaveLength(1);
    expect(callsOf(fx.provider.rollbackTransaction)).toHaveLength(1);
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(4);
    expect(callsOf(fx.provider.query)).toHaveLength(0);
    expect(callsOf(fx.provider.queryInTransaction)).toHaveLength(0);
  });

  test("a bridged begin hands the provider requireReportedState as the route always did, true only when asked", async () => {
    const reporting = transactionalFake({ stateReported: false });
    const silent = transactionalFake();
    const reportingTransaction = bridgedConsole(reporting.provider, {}).session.transaction as NonNullable<
      ConsoleSession["transaction"]
    >;
    const silentTransaction = bridgedConsole(silent.provider, {}).session.transaction as NonNullable<
      ConsoleSession["transaction"]
    >;

    const asked = await reportingTransaction({ action: "begin", requireReportedState: true }, contextOf());
    const plain = await silentTransaction({ action: "begin" }, contextOf());

    expect(callsOf(reporting.provider.beginTransaction)).toEqual([[{ requireReportedState: true }]]);
    expect(callsOf(silent.provider.beginTransaction)).toEqual([[{ requireReportedState: false }]]);
    expect(asked).toEqual({ sessionState: "in-transaction", stateReported: false });
    expect(plain).toEqual({ sessionState: "in-transaction" });
  });

  test("a bridged statement inside the transaction prepares, probes and runs queryInTransaction, with no run id, no scope and no ender, and answers the state after it", async () => {
    const endOpenQueryTransaction = mock(async () => "rolled-back");
    const fx = transactionalFake(undefined, { endOpenQueryTransaction, cancelQuery: mock(async () => true) });
    fx.open = true;
    fx.provider.queryInTransaction.mockImplementation(async () => {
      // The statement was a COMMIT the server ended the transaction with.
      fx.open = false;
      return resultOf(rowsOf(3));
    });
    const bridged = bridgedConsole(fx.provider, { limit: 2 });
    const value = marker();

    const answer = await bridged.session.execute(
      requestOf({ params: [value], runId: marker(), transaction: true }),
      contextOf(),
    );

    expect(callsOf(fx.provider.prepareQuery)).toEqual([
      ["SELECT n FROM t", { limit: 2 }],
      ["SELECT n FROM t", { limit: 3, unlimited: false }],
    ]);
    expect(callsOf(fx.provider.queryInTransaction)).toEqual([["SELECT n FROM t LIMIT 3 OFFSET 0", [value]]]);
    expect(callsOf(fx.provider.query)).toHaveLength(0);
    expect(callsOf(endOpenQueryTransaction)).toHaveLength(0);
    expect(answer.sessionState).toBe("not-in-transaction");
    expect(answer.pageApplied).toBe(true);
    expect(bridged.answered().result.rows).toEqual(rowsOf(3));
    expect(bridged.pumpLimits(answer).maxRows).toBe(3);

    const failing = new Error('syntax error at or near "LIMIT"');
    const thrower = transactionalFake();
    thrower.provider.queryInTransaction.mockImplementation(async () => {
      throw failing;
    });
    const caught = await failure(() =>
      bridgedConsole(thrower.provider, { limit: 2 }).session.execute(requestOf({ transaction: true }), contextOf()),
    );
    expect(caught).toBe(failing);
    expect(failing.message).toBe(`syntax error at or near "LIMIT" ${appendedBoundNote("LIMIT 3 OFFSET 0")}`);
    expect(callsOf(thrower.provider.queryInTransaction)[0]).toEqual(["SELECT n FROM t LIMIT 3 OFFSET 0", undefined]);

    // A provider that holds no transaction session is never sent a statement inside one: the host's check refuses it
    // before the call, so reaching the bridge with one is a defect of the host.
    const defect = await failure(() =>
      bridgedConsole(fake(resultOf([])), {}).session.execute(requestOf({ transaction: true }), contextOf()),
    );
    expect((defect as Error).message).toBe(
      "The bridge was sent a statement inside a transaction for a provider that holds no transaction session, a defect of the host.",
    );
  });

  test("a bridged transaction call whose provider throws passes the error by reference", async () => {
    const fx = transactionalFake();
    const thrown = new Error(marker());
    fx.provider.commitTransaction.mockImplementation(async () => {
      throw thrown;
    });
    const transaction = bridgedConsole(fx.provider, {}).session.transaction as NonNullable<
      ConsoleSession["transaction"]
    >;

    const caught = await failure(() => transaction({ action: "commit" }, contextOf()));

    expect(caught).toBe(thrown);
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(0);
  });

  test("a bridged session reads the provider's state on every call, and keeps none", async () => {
    const fx = transactionalFake();
    const transaction = bridgedConsole(fx.provider, {}).session.transaction as NonNullable<
      ConsoleSession["transaction"]
    >;

    fx.open = true;
    const first = await transaction({ action: "state" }, contextOf());
    // The provider ended the transaction on its own timer, with no call of the session behind it.
    fx.open = false;
    const second = await transaction({ action: "state" }, contextOf());

    expect([first, second]).toEqual([{ sessionState: "in-transaction" }, { sessionState: "not-in-transaction" }]);
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(2);
  });

  test("a legacy provider that writes what it receives changes nothing the host froze", async () => {
    const options: QueryPrepareOptions = { limit: 2 };
    const received: { options?: QueryPrepareOptions; params?: unknown[] } = {};
    const provider = fake(resultOf(rowsOf(1)), {
      prepareQuery: mock((sql: string, given: QueryPrepareOptions = {}) => {
        received.options ??= given;
        const prepared = limiter(sql, given);
        given.limit = 99;
        return prepared;
      }),
      query: mock(async (_sql: string, params?: unknown[]) => {
        received.params = params;
        params?.push(marker());
        return resultOf(rowsOf(1));
      }),
    });
    const value = marker();
    const request = requestOf({ params: [value], page: { limit: 5, offset: 0 } });

    await bridgedConsole(provider, options).session.execute(request, contextOf());

    expect(received.options).not.toBe(options);
    expect(received.options?.limit).toBe(99);
    expect(options).toEqual({ limit: 2 });
    expect(callsOf(provider.prepareQuery)[0]?.[1]).not.toBe(request.page);
    expect(received.params).toHaveLength(2);
    expect(received.params?.[0]).toBe(value);
    expect(request.params).toEqual([value]);
    expect(Object.isFrozen(request.params)).toBe(true);
  });

  test("the run prepares, probes and queries with the request's own scope, and ends nothing itself", async () => {
    const endOpenQueryTransaction = mock(async () => "rolled-back");
    const cancelQuery = mock(async () => true);
    const provider = fake(resultOf(rowsOf(3)), { endOpenQueryTransaction, cancelQuery });
    const bridged = bridgedConsole(provider, { limit: 2 });
    const scope = marker();

    const answer = await bridged.session.execute(requestOf({ params: ["a"], runId: "q-1", scope }), contextOf());

    expect(callsOf(provider.prepareQuery)).toEqual([
      ["SELECT n FROM t", { limit: 2 }],
      ["SELECT n FROM t", { limit: 3, unlimited: false }],
    ]);
    expect(callsOf(provider.query)).toEqual([["SELECT n FROM t LIMIT 3 OFFSET 0", ["a"], "q-1", scope]]);
    expect(callsOf(endOpenQueryTransaction)).toHaveLength(0);
    expect(bridged.run.prepared).toEqual({
      query: "SELECT n FROM t LIMIT 2 OFFSET 0",
      wasLimited: true,
      limit: 2,
      offset: 0,
    });
    expect(bridged.run.result?.rows).toEqual(rowsOf(3));
    expect(answer.pageApplied).toBe(true);
    expect(answer.executionTimeMs).toBe(3);

    const plain = fake(resultOf(rowsOf(1)));
    await bridgedConsole(plain, {}).session.execute(requestOf({ runId: "q-2" }), contextOf());
    // A request that carries no scope hands the provider none.
    expect(callsOf(plain.query)[0]?.slice(1)).toEqual([undefined, undefined, undefined]);

    const failing = new Error('syntax error at or near "LIMIT"');
    const ender = mock(async () => "rolled-back");
    const thrower = bridgedConsole(fake(failing, { endOpenQueryTransaction: ender }), { limit: 2 });
    const caught = await failure(() => thrower.session.execute(requestOf({ scope: marker() }), contextOf()));
    expect(caught).toBe(failing);
    expect(failing.message).toBe(`syntax error at or near "LIMIT" ${appendedBoundNote("LIMIT 3 OFFSET 0")}`);
    expect(callsOf(ender)).toHaveLength(0);
    expect(thrower.run.result).toBeUndefined();
  });

  test("a bridged endScope runs the provider's ender on the scope it is sent and answers its outcome, its failure by reference", async () => {
    const outcomes = ["rolled-back", "none"] as const;
    const endOpenQueryTransaction = mock(async () => outcomes[callsOf(endOpenQueryTransaction).length - 1]);
    const { session } = bridgedConsole(fake(resultOf([]), { endOpenQueryTransaction }), {});
    const first = marker();
    const second = marker();

    const rolledBack = await session.endScope?.({ scope: first }, contextOf());
    const none = await session.endScope?.({ scope: second }, contextOf());

    expect(rolledBack).toEqual({ openTransaction: "rolled-back" });
    expect(none).toEqual({ openTransaction: "none" });
    expect(callsOf(endOpenQueryTransaction)).toEqual([[first], [second]]);

    const failing = new Error(marker());
    const thrower = bridgedConsole(
      fake(resultOf([]), {
        endOpenQueryTransaction: mock(async () => {
          throw failing;
        }),
      }),
      {},
    );
    expect(await failure(async () => thrower.session.endScope?.({ scope: marker() }, contextOf()))).toBe(failing);
  });

  test("every result set is a source, the main rows first", async () => {
    const warning = { message: marker(), code: 42, severity: "NOTICE" };
    const plain = { message: marker() };
    const explainPlan = { plan: marker() };
    const provider = fake(
      resultOf([{ n: 1 }], {
        resultSets: [
          { rows: [{ n: 1 }], fields: ["n"] },
          { rows: [{ m: 2 }, { m: 3 }], fields: ["m"] },
        ],
        warnings: [warning, plain],
        explainPlan,
        pagination: { limit: 1, offset: 0, hasMore: false, totalReturned: 1, wasLimited: true },
      }),
    );

    const answer: ExecuteAnswer = await bridgedConsole(provider, {}).session.execute(
      requestOf({ statement: "SELECT n FROM t LIMIT 1" }),
      contextOf(),
    );

    expect(answer.results.map((source) => source.columns)).toEqual([[{ name: "n" }], [{ name: "m" }]]);
    expect(answer.results[0]?.rowCount).toBe(1);
    expect(Object.hasOwn(answer.results[1] as object, "rowCount")).toBe(false);
    const pages = await Promise.all(answer.results.map((source) => pumpPage(source, PAGE, contextOf())));
    expect(pages.map((page) => page.rows)).toEqual([[[1]], [[2], [3]]]);
    expect(answer.warnings).toEqual([warning, plain]);
    expect(answer.pageApplied).toBe(false);
    expect(answer.boundApplied).toBe(true);
    expect(answer.explainPlan).toBe(explainPlan);

    const single = await bridgedConsole(fake(resultOf([{ n: 1 }])), {}).session.execute(requestOf(), contextOf());
    expect(single.results).toHaveLength(1);
    expect(single.warnings).toEqual([]);
    expect(Object.hasOwn(single, "boundApplied")).toBe(false);
    expect(Object.hasOwn(single, "explainPlan")).toBe(false);
    const closed = single.results[0];
    await closed?.close();
    expect(
      await failure(async () => closed?.next({ maxRows: 1, maxBytes: 1, measure: encodedRowBytes })),
    ).toBeInstanceOf(Error);
  });

  test("a cell outside the value codec is measured in its JSON form and answered unchanged", async () => {
    class Point {
      constructor(readonly at: string) {}
      toJSON(): string {
        return this.at;
      }
    }
    const at = marker();
    const row = { a: undefined, b: new Point(at), c: new Map([[1, 2]]), d: 7 };
    const clean = { a: 1, b: "x", c: null, d: 7 };
    const provider = fake(resultOf([row, clean], { fields: ["a", "b", "c", "d"] }));
    const bridged = bridgedConsole(provider, {});

    const answer = await bridged.session.execute(requestOf({ statement: "SELECT * FROM t LIMIT 5" }), contextOf());
    const page = await pumpPage(answer.results[0] as never, PAGE, contextOf());

    expect(page.rows).toEqual([
      [null, at, {}, 7],
      [1, "x", null, 7],
    ]);
    expect(page.bytes).toBe(encodedRowBytes([null, at, {}, 7]) + encodedRowBytes([1, "x", null, 7]));
    expect(bridged.run.result?.rows[0]).toBe(row);
    expect(bridged.run.result?.rows[1]).toBe(clean);

    const { body } = await runEditorQuery(fake(resultOf([row, clean], { fields: ["a", "b", "c", "d"] })), {
      statement: "SELECT * FROM t LIMIT 5",
      options: {},
      signal: new AbortController().signal,
      route: "test",
      scrub: providerTextScrub({ id: "c", name: "c", type: "postgres", createdAt: new Date(0) }, "any"),
    });
    expect(JSON.stringify(body.rows)).toBe(JSON.stringify([row, clean]));
  });

  test("the bridge sizes every row it answers with the pull's measure, and answers that same array", async () => {
    const rows = Array.from({ length: 5 }, () => ({ n: marker() }));
    const answer = await bridgedConsole(fake(resultOf(rows)), {}).session.execute(requestOf(), contextOf());
    const inner = answer.results[0] as ResultSource;
    const measured: (readonly unknown[])[] = [];
    const recording: ResultSource = {
      columns: inner.columns,
      next: (limit) =>
        inner.next({
          maxRows: limit.maxRows,
          maxBytes: limit.maxBytes,
          measure: (row) => {
            measured.push(row);
            return limit.measure(row);
          },
        }),
      close: () => inner.close(),
    };

    // Each row is 40 bytes, so a 100-byte batch holds two and measures a third it does not answer.
    const page = await pumpPage(recording, { ...PAGE, batchMaxBytes: 100 }, contextOf());

    expect(page.end).toBe("done");
    expect(page.rows).toEqual(rows.map((row) => [row.n]));
    expect(page.bytes).toBe(rows.length * 40);
    expect(measured).toHaveLength(rows.length + 2);
    for (const row of page.rows) expect(measured.includes(row)).toBe(true);
  });

  test("a measuring error other than the codec's passes as the same object", async () => {
    const thrown = new Error(marker());
    const failing = {
      toJSON(): never {
        throw thrown;
      },
    };
    const provider = fake(resultOf([{ a: undefined, b: failing }], { fields: ["a", "b"] }));

    const answer = await bridgedConsole(provider, {}).session.execute(
      requestOf({ statement: "SELECT * FROM t LIMIT 5" }),
      contextOf(),
    );
    const caught = await failure(() => pumpPage(answer.results[0] as never, PAGE, contextOf()));

    expect(caught).toBe(thrown);
  });

  test("the page's row limit is the probe limit for a bound Studio wrote, and every returned row otherwise", async () => {
    const limited = bridgedConsole(fake(resultOf(rowsOf(3))), { limit: 2 });
    const unbound = bridgedConsole(fake(resultOf(rowsOf(7))), { limit: 2 });
    const empty = bridgedConsole(fake(resultOf([])), { limit: 2 });

    const limitedAnswer = await limited.session.execute(requestOf(), contextOf());
    const unboundAnswer = await unbound.session.execute(
      requestOf({ statement: "SELECT n FROM t LIMIT 9" }),
      contextOf(),
    );
    const emptyAnswer = await empty.session.execute(requestOf({ statement: "SELECT n FROM t LIMIT 9" }), contextOf());

    expect(limited.pumpLimits(limitedAnswer)).toEqual({
      maxRows: 3,
      maxBytes: PAGE_MAX_BYTES,
      batchMaxBytes: BATCH_MAX_BYTES,
    });
    expect(unbound.pumpLimits(unboundAnswer).maxRows).toBe(7);
    expect(empty.pumpLimits(emptyAnswer).maxRows).toBe(1);
    const early = bridgedConsole(fake(resultOf([])), {});
    expect(() => early.pumpLimits(emptyAnswer)).toThrow(
      "The bridge's run was read before its execute answered, a defect of the host.",
    );
    expect(() => early.answered()).toThrow(
      "The bridge's run was read before its execute answered, a defect of the host.",
    );
    const answered = limited.answered();
    expect(answered.prepared).toBe(limited.run.prepared as PreparedQuery);
    expect(answered.result).toBe(limited.run.result as QueryResult);
    expect(Object.keys(answered).sort()).toEqual(["prepared", "result"]);
  });

  test("a bridged cancel names the run and answers the provider's boolean", async () => {
    const cancelQuery = mock(async (id: string) => id === "known");
    const { session } = bridgedConsole(fake(resultOf([]), { cancelQuery }), {});

    const known = await session.cancel?.({ runId: "known" }, contextOf());
    const unknown = await session.cancel?.({ runId: marker() }, contextOf());

    expect(known).toEqual({ cancelled: true });
    expect(unknown).toEqual({ cancelled: false });
    expect(callsOf(cancelQuery)[0]).toEqual(["known"]);
  });
});

describe("the one ender", () => {
  const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");

  /** Every tracked `.ts` and `.tsx` source of Studio and the VS Code extension outside the providers, repository-relative. */
  function trackedSources(): string[] {
    return execFileSync("git", ["ls-files", "--", "src", "vscode-extension/src"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((file) => /\.tsx?$/.test(file) && !file.startsWith("src/lib/db/providers/"));
  }

  test("only the legacy bridge calls a provider's endOpenQueryTransaction, so a run's open transaction ends through console.endScope alone", () => {
    const callers = trackedSources().filter((file) =>
      /\.endOpenQueryTransaction\s*\(/.test(readFileSync(path.join(ROOT, file), "utf8")),
    );

    expect(callers).toEqual(["src/lib/provider-host/legacy-bridge.ts"]);
  });
});
