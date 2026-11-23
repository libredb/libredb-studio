/**
 * The legacy bridge (src/lib/provider-host/legacy-bridge.ts; docs/providers/CONTRACT.md, clause C-50): a legacy
 * `DatabaseProvider` served as a session of console execute and cancel, its declared calls, the copies it hands the
 * provider, today's provider steps, one source per result set, the measured form of a row and the page's row limit.
 *
 * Every provider here is a fake the test builds; every marker is generated at run time and no timer runs.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
} from "@libredb/provider-sdk/calls";
import type { DatabaseProvider, PreparedQuery, QueryPrepareOptions } from "@/lib/db/types";
import { runEditorQuery } from "@/lib/api/editor-query";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { appendedBoundNote } from "@/lib/db/utils/query-limiter";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";
import type { QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";

// The editor query reads the process's host core (src/lib/provider-host/instance.ts), so this file composes its own.
beforeAll(() => installHostCore(createHostCore()));
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
  test("a bridged session honours params and offset, offers cancel only where the provider cancels, and offers no scope", () => {
    const cancelling = bridgedConsole(fake(resultOf([]), { cancelQuery: mock(async () => true) }), {});
    const plain = bridgedConsole(fake(resultOf([])), {});

    expect(cancelling.session.calls).toEqual({
      console: { execute: { honours: ["params", "offset"] }, cancel: "offered", endScope: "not-offered" },
    });
    expect(plain.session.calls.console.cancel).toBe("not-offered");
    expect(typeof cancelling.session.cancel).toBe("function");
    expect(plain.session.cancel).toBeUndefined();
    expect(Object.isFrozen(cancelling.session.calls)).toBe(true);
    expect(Object.isFrozen(cancelling.session.calls.console.execute.honours)).toBe(true);
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

  test("the run prepares, probes, queries and ends its transaction as runEditorQuery did", async () => {
    const endOpenQueryTransaction = mock(async () => "rolled-back");
    const cancelQuery = mock(async () => true);
    const provider = fake(resultOf(rowsOf(3)), { endOpenQueryTransaction, cancelQuery });
    const bridged = bridgedConsole(provider, { limit: 2 });

    const answer = await bridged.session.execute(requestOf({ params: ["a"], runId: "q-1" }), contextOf());

    expect(callsOf(provider.prepareQuery)).toEqual([
      ["SELECT n FROM t", { limit: 2 }],
      ["SELECT n FROM t", { limit: 3, unlimited: false }],
    ]);
    const call = callsOf(provider.query)[0] as unknown[];
    expect(call.slice(0, 3)).toEqual(["SELECT n FROM t LIMIT 3 OFFSET 0", ["a"], "q-1"]);
    expect(typeof call[3]).toBe("string");
    expect(callsOf(endOpenQueryTransaction)).toEqual([[call[3]]]);
    expect(bridged.run.openTransaction).toBe("rolled-back");
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
    expect(callsOf(plain.query)[0]?.slice(1, 3)).toEqual([undefined, undefined]);

    const failing = new Error('syntax error at or near "LIMIT"');
    const ender = mock(async () => "rolled-back");
    const thrower = bridgedConsole(fake(failing, { endOpenQueryTransaction: ender }), { limit: 2 });
    const caught = await failure(() => thrower.session.execute(requestOf(), contextOf()));
    expect(caught).toBe(failing);
    expect(failing.message).toBe(`syntax error at or near "LIMIT" ${appendedBoundNote("LIMIT 3 OFFSET 0")}`);
    expect(callsOf(ender)).toHaveLength(1);
    expect(thrower.run.openTransaction).toBe("rolled-back");
    expect(thrower.run.result).toBeUndefined();
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
    expect(await failure(async () => closed?.next({ maxRows: 1, maxBytes: 1 }))).toBeInstanceOf(Error);
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
    expect(answered.openTransaction).toBe("none");
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
