import { afterEach, describe, expect, mock, test } from "bun:test";
import { checkEditorQuery, runEditorQuery } from "@/lib/api/editor-query";
import { probePastPage } from "@/lib/api/page-probe";
import { QueryCancelledError } from "@/lib/db/errors";
import type { DatabaseProvider, PreparedQuery, QueryPrepareOptions } from "@/lib/db/types";
import { appendedBoundNote, applyQueryLimit } from "@/lib/db/utils/query-limiter";
import type { QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { installStandInVocabulary, STAND_IN_TYPE } from "../../../helpers/stand-in-vocabulary";
import { serverOnlyReach, valueImportClosure } from "../../../helpers/value-import-closure";

/** The limiter's rule as a SQL provider applies it: a bound of ours, unless the text carries its own LIMIT. */
function limiter(sql: string, options: QueryPrepareOptions = {}): PreparedQuery {
  const limit = options.limit ?? 500;
  const offset = options.offset ?? 0;
  if (options.unlimited === true || /\blimit\b/i.test(sql)) return { query: sql, wasLimited: false, limit, offset };
  return { query: `${sql} LIMIT ${limit} OFFSET ${offset}`, wasLimited: true, limit, offset };
}
const rowsOf = (count: number) => Array.from({ length: count }, (_, n) => ({ n: n + 1 }));
const resultOf = (rows: Record<string, unknown>[], more: Partial<QueryResult> = {}): QueryResult => ({
  rows,
  fields: ["n"],
  rowCount: rows.length,
  executionTime: 3,
  ...more,
});
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
const runOf = (over: Partial<Parameters<typeof runEditorQuery>[1]> = {}) => ({
  statement: "SELECT n FROM t",
  options: { limit: 2 },
  signal: new AbortController().signal,
  route: "test",
  ...over,
});
/** The mock behind a fake's method, read back for its recorded calls. */
const callsOf = (fn: unknown) => (fn as ReturnType<typeof mock>).mock.calls;

describe("checkEditorQuery", () => {
  let remove: (() => void) | undefined;
  afterEach(() => {
    remove?.();
    remove = undefined;
  });

  test("a large text passes on an engine that declares no text bound", () => {
    expect(
      checkEditorQuery({
        statement: "x".repeat(9 * 1024 * 1024),
        type: "postgres",
        options: { limit: 500, offset: 0 },
      }),
    ).toBeNull();
  });

  // The `sql` and `queryId` field checks stay with each caller: a text bound is the only reason this
  // step reads the statement's type, so a caller that skips its own check gets no gate here.
  test("a statement that is not a string is not refused on an engine that declares no text bound", () => {
    expect(checkEditorQuery({ statement: { evil: 1 }, type: "postgres", options: {} })).toBeNull();
    expect(checkEditorQuery({ statement: 42, type: "postgres", options: {} })).toBeNull();
  });

  test("page bounds that are not non-negative safe integers are refused with the route's sentences", () => {
    const check = (options: unknown) => checkEditorQuery({ statement: "SELECT 1", type: "postgres", options });
    expect(check("500")).toEqual({ status: 400, error: "options must be an object" });
    expect(check({ limit: -1 })).toEqual({ status: 400, error: "options.limit must be a non-negative integer" });
    expect(check({ offset: 1.5 })).toEqual({ status: 400, error: "options.offset must be a non-negative integer" });
    expect(check({ limit: "500" })).toEqual({ status: 400, error: "options.limit must be a non-negative integer" });
    expect(check({ limit: 2 ** 53 })).toEqual({ status: 400, error: "options.limit must be a non-negative integer" });
    expect(check({ offset: 1e21 })).toEqual({ status: 400, error: "options.offset must be a non-negative integer" });
    expect(check({ offset: Number.MAX_SAFE_INTEGER })).toEqual({
      status: 400,
      error: "options.offset must be a non-negative integer",
    });
  });

  // The probe asks for one row more than the page, so the largest limit taken leaves that row a row bound too.
  test("the largest page bounds taken are one below Number.MAX_SAFE_INTEGER, and the probe past them runs", () => {
    const largest = Number.MAX_SAFE_INTEGER - 1;
    const statement = "SELECT n FROM t";
    const check = (options: unknown) => checkEditorQuery({ statement, type: "postgres", options });
    expect(check({ limit: largest, offset: largest })).toBeNull();
    expect(check({ limit: largest + 1 })).toEqual({
      status: 400,
      error: "options.limit must be a non-negative integer",
    });

    const limiting = {
      prepareQuery: (sql: string, options: QueryPrepareOptions = {}): PreparedQuery => {
        const { limit = 500, offset = 0 } = options;
        const { sql: query, wasLimited } = applyQueryLimit(sql, limit, offset);
        return { query, wasLimited, limit, offset };
      },
    };
    const options = { limit: largest };
    const probed = probePastPage(limiting, statement, options, limiting.prepareQuery(statement, options));
    expect(probed.query).toBe(`${statement} LIMIT ${Number.MAX_SAFE_INTEGER}`);
  });

  test("a declared text bound refuses an oversize text in words and passes one at the bound", () => {
    remove = installStandInVocabulary({ maxTextBytes: 64 });
    const check = (statement: unknown, options: unknown = {}) =>
      checkEditorQuery({ statement, type: STAND_IN_TYPE, options });
    expect(check("x".repeat(65))).toEqual({
      status: 413,
      error:
        "The statement is 65 bytes in UTF-8, over the 64-byte limit for this connection type. Shorten it to run it.",
    });
    expect(check("x".repeat(64))).toBeNull();
    expect(check(["x"])).toEqual({ status: 400, error: "sql must be a string" });
    expect(check("x".repeat(65), { limit: -1 })).toEqual({
      status: 400,
      error: "options.limit must be a non-negative integer",
    });
  });
});

describe("runEditorQuery", () => {
  test("a limited run probes one row past the page and cuts it back", async () => {
    const provider = fake(resultOf(rowsOf(3)));
    const answer = await runEditorQuery(provider, runOf());
    expect(callsOf(provider.prepareQuery)).toEqual([
      ["SELECT n FROM t", { limit: 2 }],
      ["SELECT n FROM t", { limit: 3, unlimited: false }],
    ]);
    expect(callsOf(provider.query)[0]).toEqual([
      "SELECT n FROM t LIMIT 3 OFFSET 0",
      undefined,
      undefined,
      expect.any(String),
    ]);
    expect(answer).toEqual({
      body: {
        rows: [{ n: 1 }, { n: 2 }],
        fields: ["n"],
        rowCount: 2,
        executionTime: 3,
        pagination: { limit: 2, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
      },
      resultSetCount: 1,
    });
  });

  test("a full last page offers no next page", async () => {
    const answer = await runEditorQuery(fake(resultOf(rowsOf(2))), runOf());
    expect(answer.body.rowCount).toBe(2);
    expect(answer.body.pagination).toEqual({
      limit: 2,
      offset: 0,
      hasMore: false,
      totalReturned: 2,
      wasLimited: false,
    });
  });

  test("a page read runs at its offset", async () => {
    const provider = fake(resultOf(rowsOf(1)));
    const answer = await runEditorQuery(provider, runOf({ options: { limit: 2, offset: 2 } }));
    expect(callsOf(provider.query)[0][0]).toBe("SELECT n FROM t LIMIT 3 OFFSET 2");
    expect(answer.body.pagination.offset).toBe(2);
    expect(answer.body.pagination.hasMore).toBe(false);
  });

  test("a text carrying its own bound runs unprobed and offers no page", async () => {
    const provider = fake(resultOf(rowsOf(5)));
    const answer = await runEditorQuery(provider, runOf({ statement: "SELECT n FROM t LIMIT 5" }));
    expect(callsOf(provider.prepareQuery)).toHaveLength(1);
    expect(callsOf(provider.query)[0][0]).toBe("SELECT n FROM t LIMIT 5");
    expect(answer.body.rowCount).toBe(5);
    expect(answer.body.pagination).toEqual({
      limit: 2,
      offset: 0,
      hasMore: false,
      totalReturned: 5,
      wasLimited: false,
    });
  });

  test("a bound the provider applied itself is reported (#1085)", async () => {
    const provider = fake(
      resultOf(rowsOf(1), { pagination: { limit: 1, offset: 0, hasMore: false, totalReturned: 1, wasLimited: true } }),
    );
    const answer = await runEditorQuery(provider, runOf({ statement: "SELECT n FROM t LIMIT 5" }));
    expect(answer.body.pagination.wasLimited).toBe(true);
    expect(answer.body.pagination.hasMore).toBe(false);
  });

  test("the run gets a call scope and the bound params, and the scope's transaction is ended", async () => {
    const endOpenQueryTransaction = mock(async () => "none");
    const provider = fake(resultOf(rowsOf(1)), { endOpenQueryTransaction });
    const answer = await runEditorQuery(provider, runOf({ params: ["a"] }));
    const call = callsOf(provider.query)[0];
    expect(call[1]).toEqual(["a"]);
    expect(typeof call[3]).toBe("string");
    expect(callsOf(endOpenQueryTransaction)).toEqual([[call[3]]]);
    expect("openTransaction" in answer.body).toBe(false);
  });

  test("a transaction the run left open and the provider rolled back is answered (D74)", async () => {
    const provider = fake(resultOf(rowsOf(1)), { endOpenQueryTransaction: mock(async () => "rolled-back") });
    const answer = await runEditorQuery(provider, runOf());
    expect(answer.body.openTransaction).toBe("rolled-back");
  });

  test("a provider that declares no transaction ender answers no openTransaction key", async () => {
    const answer = await runEditorQuery(fake(resultOf(rowsOf(1))), runOf());
    expect("openTransaction" in answer.body).toBe(false);
  });

  test("the transaction ender runs when the statement throws", async () => {
    const boom = new Error("boom");
    const endOpenQueryTransaction = mock(async () => "rolled-back");
    const provider = fake(boom, { endOpenQueryTransaction });
    await expect(runEditorQuery(provider, runOf())).rejects.toBe(boom);
    expect(callsOf(endOpenQueryTransaction)).toHaveLength(1);
  });

  test("an abort while the statement runs cancels it under the request's id", async () => {
    const controller = new AbortController();
    let settle: (value: QueryResult) => void = () => {};
    const held = new Promise<QueryResult>((resolve) => {
      settle = resolve;
    });
    const cancelQuery = mock(async () => true);
    const provider = fake(resultOf(rowsOf(1)), { cancelQuery, query: mock(() => held) });
    const running = runEditorQuery(provider, runOf({ queryId: "q-1", signal: controller.signal }));
    controller.abort();
    settle(resultOf(rowsOf(1)));
    await running;
    expect(callsOf(cancelQuery)).toEqual([["q-1"]]);
    expect(callsOf(provider.query)[0][2]).toBe("q-1");
  });

  test("an abort after the run answered cancels nothing", async () => {
    const controller = new AbortController();
    const cancelQuery = mock(async () => true);
    const provider = fake(resultOf(rowsOf(1)), { cancelQuery });
    await runEditorQuery(provider, runOf({ queryId: "q-1", signal: controller.signal }));
    controller.abort();
    expect(callsOf(provider.query)[0][2]).toBe("q-1");
    expect(callsOf(cancelQuery)).toEqual([]);
  });

  test("an abort after the run failed cancels nothing", async () => {
    const controller = new AbortController();
    const boom = new Error("boom");
    const cancelQuery = mock(async () => true);
    const provider = fake(boom, { cancelQuery });
    await expect(runEditorQuery(provider, runOf({ queryId: "q-1", signal: controller.signal }))).rejects.toBe(boom);
    controller.abort();
    expect(callsOf(provider.query)[0][2]).toBe("q-1");
    expect(callsOf(cancelQuery)).toEqual([]);
  });

  test("a request already aborted starts nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = fake(resultOf(rowsOf(1)));
    const caught = await runEditorQuery(provider, runOf({ signal: controller.signal })).catch((error) => error);
    expect(caught).toBeInstanceOf(QueryCancelledError);
    expect((caught as Error).message).toBe("The query was cancelled.");
    expect(callsOf(provider.query)).toHaveLength(0);
  });

  test("a provider without cancel support gets no cancel id", async () => {
    const provider = fake(resultOf(rowsOf(1)));
    await runEditorQuery(provider, runOf({ queryId: "q-1" }));
    expect(callsOf(provider.query)[0][2]).toBeUndefined();
  });

  test("an error naming the appended bound says the bound was Studio's", async () => {
    const error = new Error('syntax error at or near "LIMIT"');
    const caught = await runEditorQuery(fake(error), runOf()).catch((thrown) => thrown);
    expect(caught).toBe(error);
    expect(error.message).toBe(`syntax error at or near "LIMIT" ${appendedBoundNote("LIMIT 3 OFFSET 0")}`);
  });

  test("NaN and the infinities are answered as words", async () => {
    const provider = fake(resultOf([{ v: Number.NaN }, { v: Infinity }, { v: -Infinity }]));
    const answer = await runEditorQuery(provider, runOf({ statement: "SELECT v FROM t LIMIT 5" }));
    expect(answer.body.rows).toEqual([{ v: "NaN" }, { v: "Infinity" }, { v: "-Infinity" }]);
  });

  test("several result sets answer the first and count them all", async () => {
    const provider = fake(
      resultOf(rowsOf(1), {
        resultSets: [
          { rows: [{ n: 1 }], fields: ["n"] },
          { rows: [{ m: 2 }], fields: ["m"] },
        ],
      } as Partial<QueryResult>),
    );
    const answer = await runEditorQuery(provider, runOf());
    expect(answer.resultSetCount).toBe(2);
    expect("resultSets" in answer.body).toBe(false);
  });
});

describe("the core's import closure stays free of Next", () => {
  // The VS Code extension's backend child runs this module outside Next, so no value import anywhere
  // in what it reaches may pull in Next, query events or governance.
  test("no value import in the closure reaches next, query events or governance", () => {
    const closure = valueImportClosure("src/lib/api/editor-query.ts");
    expect(closure.unresolved).toEqual([]);
    expect(serverOnlyReach(closure)).toEqual([]);
    // A control on the walk: every module this core imports by value is in it.
    expect(closure.modules).toEqual(
      expect.arrayContaining([
        "src/lib/api/abort-cancel.ts",
        "src/lib/api/first-result-set.ts",
        "src/lib/api/page-probe.ts",
        "src/lib/db/destructive-commands.ts",
        "src/lib/db/errors.ts",
        "src/lib/db/query-cancel.ts",
        "src/lib/db/types.ts",
        "src/lib/db/utils/query-limiter.ts",
        "src/lib/non-finite.ts",
      ]),
    );
  });

  test("a control: the same walk over the query route finds Next and governance", () => {
    expect(serverOnlyReach(valueImportClosure("src/app/api/db/query/route.ts"))).toEqual(
      expect.arrayContaining(["next/server", "src/lib/governance/config.ts"]),
    );
  });
});
