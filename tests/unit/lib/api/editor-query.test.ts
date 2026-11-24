import { afterAll, beforeAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  BATCH_MAX_BYTES,
  type CallContext,
  CLEANUP_DEADLINE_MS,
  envReader,
  PAGE_MAX_BYTES,
  type ResultSource,
} from "@libredb/provider-sdk/calls";
import {
  checkEditorQuery,
  type EditorQueryRefusal,
  EXECUTE_SLACK_MS,
  executeDeadline,
  openWithinCall,
  runEditorQuery,
} from "@/lib/api/editor-query";
import { databaseErrorBody } from "@/lib/api/error-body";
import { probePastPage } from "@/lib/api/page-probe";
import { errorKind, errorOutcome } from "@/lib/db/error-record";
import type { OpenWait } from "@/lib/provider-host/core/open-once";
import {
  ConnectionError,
  markNotSent,
  QueryCancelledError,
  QueryError,
  StudioByteBudgetRefusal,
  StudioTimeoutRefusal,
  waitedSeconds,
} from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { PROVIDER_TEXT_WITHHELD, providerTextScrub } from "@/lib/db/operations/provider-text";
import type { DatabaseProvider, PreparedQuery, QueryPrepareOptions } from "@/lib/db/types";
import { appendedBoundNote, applyQueryLimit } from "@/lib/db/utils/query-limiter";
import type { DatabaseConnection, DatabaseType, QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { installStandInVocabulary, STAND_IN_TYPE } from "../../../helpers/stand-in-vocabulary";
import { serverOnlyReach, valueImportClosure } from "../../../helpers/value-import-closure";
import { HOST_DEFECT_PREFIX } from "@/lib/provider-host/access";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";

// The editor query reads the process's host core (src/lib/provider-host/instance.ts), so this file composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

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
const connectionWith = (fields: Partial<DatabaseConnection> = {}) =>
  ({
    id: "c1",
    name: "Prod",
    type: "postgres",
    host: "db.internal",
    createdAt: new Date(0),
    ...fields,
  }) as DatabaseConnection;
/** The scrub of a connection that holds no secret: it withholds nothing. */
const cleanScrub = providerTextScrub(connectionWith(), "any");
const runOf = (over: Partial<Parameters<typeof runEditorQuery>[1]> = {}) => ({
  statement: "SELECT n FROM t",
  options: { limit: 2 },
  signal: new AbortController().signal,
  route: "test",
  scrub: cleanScrub,
  ...over,
});
/** The mock behind a fake's method, read back for its recorded calls. */
const callsOf = (fn: unknown) => (fn as ReturnType<typeof mock>).mock.calls;
/** Studio's sentence for an end of a run's scope its cleanup deadline stopped. */
const END_SCOPE_SENTENCE =
  "Ending the transaction this request may have left open did not answer within 10 seconds, so Studio stopped waiting for it.";
/** The line a late end of a stopped run's scope that failed or was stopped is logged under. */
const END_LATE_LINE = "Ending the transaction a run Studio stopped waiting for may have left open failed";

/** Runs `body` with `core` installed in place of the file's own, and puts the file's own back after it. */
async function withCore<T>(core: HostCore, body: () => Promise<T>): Promise<T> {
  const real = hostCore();
  forgetHostCore();
  installHostCore(core, "test");
  try {
    return await body();
  } finally {
    forgetHostCore();
    installHostCore(real, "test");
  }
}

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
        queryTimeout: undefined,
      }),
    ).toBeNull();
  });

  // The `sql` and `queryId` field checks stay with each caller: a text bound is the only reason this
  // step reads the statement's type, so a caller that skips its own check gets no gate here.
  test("a statement that is not a string is not refused on an engine that declares no text bound", () => {
    expect(
      checkEditorQuery({ statement: { evil: 1 }, type: "postgres", options: {}, queryTimeout: undefined }),
    ).toBeNull();
    expect(checkEditorQuery({ statement: 42, type: "postgres", options: {}, queryTimeout: undefined })).toBeNull();
  });

  test("page bounds that are not non-negative safe integers are refused with the route's sentences", () => {
    const check = (options: unknown) =>
      checkEditorQuery({ statement: "SELECT 1", type: "postgres", options, queryTimeout: undefined });
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
    const check = (options: unknown) =>
      checkEditorQuery({ statement, type: "postgres", options, queryTimeout: undefined });
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

  // The connection dialog writes a whole number of milliseconds from 1 to 2147483647, or nothing; any other value would
  // make the host's deadline NaN or wrong, so it is refused by name before a provider is built.
  test("a statement timeout that is not a whole number of milliseconds from 1 to 2147483647 is refused by name", () => {
    const check = (queryTimeout: unknown) =>
      checkEditorQuery({ statement: "SELECT 1", type: "postgres", options: {}, queryTimeout });
    const refused: EditorQueryRefusal = {
      status: 400,
      error: "The connection's queryTimeout must be a whole number of milliseconds from 1 to 2147483647.",
    };
    for (const value of ["60000", "abc", Number.NaN, 1.5, 0, -1, 2_147_483_648, Number.POSITIVE_INFINITY, true, {}]) {
      expect(check(value)).toEqual(refused);
    }
    for (const value of [undefined, null, 1, 60_000, 2_147_483_647]) {
      expect(check(value)).toBeNull();
    }
  });

  test("a declared text bound refuses an oversize text in words and passes one at the bound", () => {
    remove = installStandInVocabulary({ maxTextBytes: 64 });
    const check = (statement: unknown, options: unknown = {}) =>
      checkEditorQuery({ statement, type: STAND_IN_TYPE, options, queryTimeout: undefined });
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
    expect(callsOf(provider.query)[0]).toEqual(["SELECT n FROM t LIMIT 3 OFFSET 0", undefined, undefined, undefined]);
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

  test("the run on a session that offers console.endScope is sent a scope of its own, and that scope is ended once after the run", async () => {
    const order: string[] = [];
    const endOpenQueryTransaction = mock(async () => {
      order.push("end");
      return "none";
    });
    const provider = fake(resultOf(rowsOf(1)), {
      endOpenQueryTransaction,
      query: mock(async () => {
        order.push("query");
        return resultOf(rowsOf(1));
      }),
    });

    const answer = await runEditorQuery(provider, runOf({ params: ["a"] }));
    await runEditorQuery(provider, runOf());

    const [first, second] = callsOf(provider.query);
    expect(first[1]).toEqual(["a"]);
    expect(typeof first[3]).toBe("string");
    expect(typeof second[3]).toBe("string");
    expect(second[3]).not.toBe(first[3]);
    expect(callsOf(endOpenQueryTransaction)).toEqual([[first[3]], [second[3]]]);
    expect(order).toEqual(["query", "end", "query", "end"]);
    expect("openTransaction" in answer.body).toBe(false);
  });

  test("a transaction the run left open and the provider rolled back is answered (D74)", async () => {
    const provider = fake(resultOf(rowsOf(1)), { endOpenQueryTransaction: mock(async () => "rolled-back") });
    const answer = await runEditorQuery(provider, runOf());
    expect(answer.body.openTransaction).toBe("rolled-back");
  });

  test("a provider that declares no transaction ender is sent no scope and asked to end none, and answers no openTransaction key", async () => {
    const real = hostCore();
    const ends: unknown[] = [];
    const provider = fake(resultOf(rowsOf(1)));
    const answer = await withCore(
      {
        ...real,
        endScopeCall: async (...args) => {
          ends.push(args);
          return real.endScopeCall(...args);
        },
      },
      () => runEditorQuery(provider, runOf()),
    );
    expect(callsOf(provider.query)[0]?.[3]).toBeUndefined();
    expect(ends).toEqual([]);
    expect("openTransaction" in answer.body).toBe(false);
  });

  test("the scope is ended when the statement throws, and the statement's error is answered", async () => {
    const boom = new Error("boom");
    const endOpenQueryTransaction = mock(async () => "rolled-back");
    const provider = fake(boom, { endOpenQueryTransaction });
    const caught = await runEditorQuery(provider, runOf()).catch((error: unknown) => error);
    expect(caught).toBe(boom);
    expect(callsOf(endOpenQueryTransaction)).toEqual([[callsOf(provider.query)[0]?.[3]]]);
  });

  test("an end that fails is answered in the run's place, its error by reference, and the page record is released once", async () => {
    const real = hostCore();
    let releases = 0;
    const counting: HostCore = {
      ...real,
      executeCall: async (...args) => {
        const record = await real.executeCall(...args);
        if (record.kind !== "page") return record;
        return {
          ...record,
          release: () => {
            releases += 1;
            record.release();
          },
        };
      },
    };
    const failing = new QueryError(`rollback failed ${crypto.randomUUID()}`, "postgres");
    const ender = mock(async () => {
      throw failing;
    });

    const afterPage = await withCore(counting, () =>
      runEditorQuery(fake(resultOf(rowsOf(1)), { endOpenQueryTransaction: ender }), runOf()).catch(
        (error: unknown) => error,
      ),
    );
    const afterThrow = await runEditorQuery(fake(new Error("boom"), { endOpenQueryTransaction: ender }), runOf()).catch(
      (error: unknown) => error,
    );

    expect(afterPage).toBe(failing);
    expect(releases).toBe(1);
    expect(afterThrow).toBe(failing);
    expect(callsOf(ender)).toHaveLength(2);
  });

  test("the scope's end is sent before the answer body is built", async () => {
    const real = hostCore();
    const order: string[] = [];
    const ordering: HostCore = {
      ...real,
      executeCall: async (...args) => {
        const record = await real.executeCall(...args);
        if (record.kind !== "page") return record;
        return {
          ...record,
          release: () => {
            order.push("release");
            record.release();
          },
        };
      },
    };
    const endOpenQueryTransaction = mock(async () => {
      order.push("end");
      return "rolled-back";
    });

    const answer = await withCore(ordering, () =>
      runEditorQuery(fake(resultOf(rowsOf(1)), { endOpenQueryTransaction }), runOf()),
    );

    expect(order).toEqual(["end", "release"]);
    expect(answer.body.openTransaction).toBe("rolled-back");
  });

  test("a page refused after the call ends its scope before the refusal is answered", async () => {
    const endOpenQueryTransaction = mock(async () => "rolled-back");
    const provider = fake(resultOf([{ n: "x".repeat(33 * 1_048_576) }]), { endOpenQueryTransaction });

    const caught = await runEditorQuery(provider, runOf({ statement: "SELECT n FROM t LIMIT 5" })).catch(
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(StudioByteBudgetRefusal);
    expect(callsOf(endOpenQueryTransaction)).toEqual([[callsOf(provider.query)[0]?.[3]]]);
  });

  test("a run refused before its call ends no scope", async () => {
    const endOpenQueryTransaction = mock(async () => "rolled-back");
    const late = Object.assign(fake(resultOf(rowsOf(1)), { endOpenQueryTransaction }), {
      config: connectionWith({ queryTimeout: -EXECUTE_SLACK_MS - 60_000 }),
    });
    const gone = new AbortController();
    gone.abort(new DOMException("The request went away.", "AbortError"));

    const pastDeadline = await runEditorQuery(late, runOf()).catch((error: unknown) => error);
    const callerGone = await runEditorQuery(
      fake(resultOf(rowsOf(1)), { endOpenQueryTransaction }),
      runOf({ signal: gone.signal }),
    ).catch((error: unknown) => error);

    expect(pastDeadline).toBeInstanceOf(StudioTimeoutRefusal);
    expect(errorOutcome(pastDeadline)).toBe("not-sent");
    expect(callerGone).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(callerGone)).toBe("not-sent");
    expect(callsOf(endOpenQueryTransaction)).toEqual([]);
  });

  test("the scope's end runs under a cleanup context of its own, ten seconds from its start, which the caller's leaving does not end", async () => {
    const real = hostCore();
    const seen: { ctx: CallContext; scope: string }[] = [];
    const spying: HostCore = {
      ...real,
      endScopeCall: (session, request, ctx, ports) => {
        seen.push({ ctx, scope: request.scope });
        return real.endScopeCall(session, request, ctx, ports);
      },
    };
    const caller = new AbortController();
    const provider = fake(resultOf(rowsOf(1)), { endOpenQueryTransaction: mock(async () => "none") });

    const before = Date.now();
    await withCore(spying, () => runEditorQuery(provider, runOf({ signal: caller.signal })));
    const after = Date.now();
    caller.abort(new DOMException("The request went away.", "AbortError"));

    expect(seen).toHaveLength(1);
    const { ctx, scope } = seen[0] as { ctx: CallContext; scope: string };
    expect(scope).toBe(callsOf(provider.query)[0]?.[3]);
    expect(ctx.deadline).toBeGreaterThanOrEqual(before + CLEANUP_DEADLINE_MS);
    expect(ctx.deadline).toBeLessThanOrEqual(after + CLEANUP_DEADLINE_MS);
    expect(ctx.signal).not.toBe(caller.signal);
    expect(ctx.signal.aborted).toBe(false);
  });

  test("an end its cleanup deadline stops answers StudioTimeoutRefusal naming the end, outcome unknown", async () => {
    const real = hostCore();
    let releases = 0;
    const stopping: HostCore = {
      ...real,
      executeCall: async (...args) => {
        const record = await real.executeCall(...args);
        if (record.kind !== "page") return record;
        return {
          ...record,
          release: () => {
            releases += 1;
            record.release();
          },
        };
      },
      endScopeCall: async () => ({
        kind: "stopped",
        reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
        settled: Promise.resolve(),
      }),
    };

    const caught = await withCore(stopping, () =>
      runEditorQuery(fake(resultOf(rowsOf(1)), { endOpenQueryTransaction: mock(async () => "none") }), runOf()).catch(
        (error: unknown) => error,
      ),
    );

    expect(caught).toBeInstanceOf(StudioTimeoutRefusal);
    expect((caught as Error).message).toBe(END_SCOPE_SENTENCE);
    expect(errorOutcome(caught)).toBe("unknown");
    expect(databaseErrorBody(caught)?.body).toMatchObject({
      code: "TIMEOUT_ERROR",
      statusCode: 504,
      kind: "studio-timeout-refusal",
      outcome: "unknown",
    });
    expect(releases).toBe(1);
  });

  test("an end the host refuses is answered as a defect of Studio's bridge, named by its rule", async () => {
    const real = hostCore();
    const refusing: HostCore = {
      ...real,
      endScopeCall: async () => ({
        kind: "refused",
        called: false,
        refusals: [{ rule: "facet-not-offered", pointer: "/console/endScope", name: "console.endScope" }],
      }),
    };

    const caught = await withCore(refusing, () =>
      runEditorQuery(fake(resultOf(rowsOf(1)), { endOpenQueryTransaction: mock(async () => "none") }), runOf()).catch(
        (error: unknown) => error,
      ),
    );

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.startsWith(HOST_DEFECT_PREFIX)).toBe(true);
    expect((caught as Error).message).toContain("console.endScope");
  });

  test("a caller that leaves while the statement runs is answered at once, and the scope is ended once the statement has settled", async () => {
    const statement = Promise.withResolvers<QueryResult>();
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const endOpenQueryTransaction = mock(async () => {
      ended.resolve();
      return "rolled-back";
    });
    const provider = fake(resultOf(rowsOf(1)), {
      endOpenQueryTransaction,
      query: mock(() => {
        started.resolve();
        return statement.promise;
      }),
    });
    const caller = new AbortController();

    const running = runEditorQuery(provider, runOf({ signal: caller.signal }));
    await started.promise;
    caller.abort(new DOMException("The request went away.", "AbortError"));
    const caught = await running.catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(QueryCancelledError);
    expect(callsOf(endOpenQueryTransaction)).toEqual([]);
    statement.resolve(resultOf(rowsOf(1)));
    await ended.promise;
    expect(callsOf(endOpenQueryTransaction)).toEqual([[callsOf(provider.query)[0]?.[3]]]);
  });

  test("the end of a stopped run's scope that fails or is stopped is logged by kind and code, never its text", async () => {
    const secret = crypto.randomUUID();
    const logged: unknown[][] = [];
    let onLog: () => void = () => {};
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      if (args[0] !== END_LATE_LINE) return;
      logged.push(args);
      onLog();
    });
    /** Runs a statement the caller leaves, settles it, and waits for the late end's log line. */
    const leaveThenSettle = async (provider: DatabaseProvider, statement: PromiseWithResolvers<QueryResult>) => {
      const line = Promise.withResolvers<void>();
      onLog = () => line.resolve();
      const caller = new AbortController();
      const running = runEditorQuery(provider, runOf({ signal: caller.signal, route: "end-route" }));
      await new Promise((resolve) => setImmediate(resolve));
      caller.abort(new DOMException("The request went away.", "AbortError"));
      expect(await running.catch((error: unknown) => error)).toBeInstanceOf(QueryCancelledError);
      statement.resolve(resultOf(rowsOf(1)));
      await line.promise;
    };
    try {
      const failingStatement = Promise.withResolvers<QueryResult>();
      await leaveThenSettle(
        fake(resultOf(rowsOf(1)), {
          query: mock(() => failingStatement.promise),
          endOpenQueryTransaction: mock(async () => {
            throw new QueryError(`rollback of ${secret} failed`, "postgres");
          }),
        }),
        failingStatement,
      );

      const real = hostCore();
      const stoppedStatement = Promise.withResolvers<QueryResult>();
      await withCore(
        {
          ...real,
          endScopeCall: async () => ({
            kind: "stopped",
            reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
            settled: Promise.resolve(),
          }),
        },
        () =>
          leaveThenSettle(
            fake(resultOf(rowsOf(1)), {
              query: mock(() => stoppedStatement.promise),
              endOpenQueryTransaction: mock(async () => "none"),
            }),
            stoppedStatement,
          ),
      );

      expect(logged).toEqual([
        [END_LATE_LINE, { route: "end-route", kind: "query", code: "QUERY_ERROR" }],
        [END_LATE_LINE, { route: "end-route", kind: "studio-timeout-refusal", code: "TIMEOUT_ERROR" }],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("an abort while the statement runs cancels it under the request's id", async () => {
    const controller = new AbortController();
    let settle: (value: QueryResult) => void = () => {};
    const held = new Promise<QueryResult>((resolve) => {
      settle = resolve;
    });
    const cancelQuery = mock(async () => true);
    const started = Promise.withResolvers<void>();
    const query = mock(() => {
      started.resolve();
      return held;
    });
    const provider = fake(resultOf(rowsOf(1)), { cancelQuery, query });
    const running = runEditorQuery(provider, runOf({ queryId: "q-1", signal: controller.signal }));
    await started.promise;
    controller.abort();
    const caught = await running.catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(caught)).toBe("unknown");
    expect(callsOf(cancelQuery)).toEqual([["q-1"]]);
    expect(callsOf(provider.query)[0][2]).toBe("q-1");
    settle(resultOf(rowsOf(1)));
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
    expect(errorOutcome(caught)).toBe("not-sent");
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

  test("warnings that hold the connection's credential are withheld field by field, and a numeric code is kept", async () => {
    const password = crypto.randomUUID();
    const scrub = providerTextScrub(connectionWith({ password }), "any");
    const provider = fake(
      resultOf(rowsOf(1), {
        warnings: [
          { message: `a notice about ${password}`, code: 42, severity: `NOTICE ${password}` },
          { message: "a clean notice", code: `C-${password}`, severity: "WARNING" },
          { message: "a second clean notice", code: "01000", severity: "WARNING" },
        ],
      }),
    );
    const answer = await runEditorQuery(provider, runOf({ statement: "SELECT n FROM t LIMIT 5", scrub }));
    expect(answer.body.warnings).toEqual([
      { message: PROVIDER_TEXT_WITHHELD, code: 42, severity: PROVIDER_TEXT_WITHHELD },
      { message: "a clean notice", code: PROVIDER_TEXT_WITHHELD, severity: "WARNING" },
      { message: "a second clean notice", code: "01000", severity: "WARNING" },
    ]);
    expect(JSON.stringify(answer.body)).not.toContain(password);
    const none = await runEditorQuery(
      fake(resultOf(rowsOf(1))),
      runOf({ statement: "SELECT n FROM t LIMIT 5", scrub }),
    );
    expect(Object.hasOwn(none.body, "warnings")).toBe(false);
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

describe("runEditorQuery on the host core", () => {
  const MIB = 1_048_576;
  /** One cell of exactly a MiB, shared by every row, so a 40 MiB result holds one string. */
  const mebibyte = "x".repeat(MIB);
  const bigRows = (count: number) => Array.from({ length: count }, () => ({ n: mebibyte }));
  /** How many such rows a 32 MiB page holds: each measures `["x...x"]`, its MiB and four bytes. */
  const PAGE_HOLDS = Math.floor(33_554_432 / (MIB + 4));

  test("the execute deadline is the statement timeout plus ten seconds, capped at the longest timer", () => {
    const now = Date.now();
    const withTimeout = createMockProvider({ config: connectionWith({ queryTimeout: 1_000 }) });
    const withDefault = createMockProvider({ config: connectionWith() });
    const huge = createMockProvider({ config: connectionWith({ queryTimeout: 2 ** 40 }) });

    expect(EXECUTE_SLACK_MS).toBe(10_000);
    expect(executeDeadline(withTimeout, now)).toBe(now + 11_000);
    expect(executeDeadline(withDefault, now)).toBe(now + 70_000);
    expect(executeDeadline(huge, now)).toBe(now + 2_147_483_647);
  });

  test("a run past its deadline is refused before the provider is called, not-sent", async () => {
    const provider = Object.assign(fake(resultOf(rowsOf(1))), {
      config: connectionWith({ queryTimeout: -EXECUTE_SLACK_MS - 60_000 }),
    });

    const caught = await runEditorQuery(provider, runOf()).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StudioTimeoutRefusal);
    expect(errorOutcome(caught)).toBe("not-sent");
    expect(databaseErrorBody(caught)?.body).toMatchObject({
      code: "TIMEOUT_ERROR",
      statusCode: 504,
      kind: "studio-timeout-refusal",
      outcome: "not-sent",
    });
    expect(callsOf(provider.prepareQuery)).toHaveLength(0);
    expect(callsOf(provider.query)).toHaveLength(0);
  });

  test("a page cut by bytes continues after its last row when Studio wrote the bound", async () => {
    const answer = await runEditorQuery(fake(resultOf(bigRows(40))), runOf({ options: { limit: 100 } }));

    expect(answer.body.rows).toHaveLength(PAGE_HOLDS);
    expect(answer.body.rowCount).toBe(PAGE_HOLDS);
    expect(answer.body.pagination).toEqual({
      limit: 100,
      offset: 0,
      hasMore: true,
      totalReturned: PAGE_HOLDS,
      wasLimited: true,
    });
  });

  test("a page cut by bytes of a statement Studio did not bound offers no next page and says Studio bounded it", async () => {
    const answer = await runEditorQuery(
      fake(resultOf(bigRows(40))),
      runOf({ statement: "SELECT n FROM t LIMIT 40", options: { limit: 100 } }),
    );

    expect(answer.body.rows).toHaveLength(PAGE_HOLDS);
    expect(answer.body.rowCount).toBe(PAGE_HOLDS);
    expect(answer.body.pagination).toEqual({
      limit: 100,
      offset: 0,
      hasMore: false,
      totalReturned: PAGE_HOLDS,
      wasLimited: true,
    });
  });

  test("a result Studio did not bound answers every row, as before", async () => {
    const answer = await runEditorQuery(
      fake(resultOf(rowsOf(700))),
      runOf({ statement: "SELECT n FROM t LIMIT 1000", options: { limit: 2 } }),
    );

    expect(answer.body.rows).toEqual(rowsOf(700));
    expect(answer.body.rowCount).toBe(700);
    expect(answer.body.pagination).toEqual({
      limit: 2,
      offset: 0,
      hasMore: false,
      totalReturned: 700,
      wasLimited: false,
    });
  });

  /** A fake whose result is `count` rows of a MiB each, so each batch holds one row and the page needs `count`. */
  const largeFake = (count: number, queryTimeout: number) =>
    Object.assign(fake(resultOf(bigRows(count))), { config: connectionWith({ queryTimeout }) });

  test("a large page's slot is released once its body is built, so the next large page does not wait", async () => {
    // A deadline a second ahead: a page that waited for a slot never released would answer the deadline's stop.
    const queryTimeout = 1_000 - EXECUTE_SLACK_MS;

    const first = await runEditorQuery(largeFake(3, queryTimeout), runOf({ options: { limit: 100 } }));
    const second = await runEditorQuery(largeFake(3, queryTimeout), runOf({ options: { limit: 100 } }));

    expect(first.body.rows).toEqual(bigRows(3));
    expect(second.body.rows).toEqual(bigRows(3));
    expect(second.body.pagination.hasMore).toBe(false);
  });

  test("two concurrent large pages each answer their whole page", async () => {
    // A deadline two seconds ahead, so a page left waiting fails the case well inside its timeout.
    const queryTimeout = 2_000 - EXECUTE_SLACK_MS;
    const alone = await runEditorQuery(largeFake(3, queryTimeout), runOf({ options: { limit: 100 } }));

    const [one, two] = await Promise.all([
      runEditorQuery(largeFake(3, queryTimeout), runOf({ options: { limit: 100 } })),
      runEditorQuery(largeFake(3, queryTimeout), runOf({ options: { limit: 100 } })),
    ]);

    expect(alone.body.rows).toHaveLength(3);
    expect(one.body).toEqual(alone.body);
    expect(two.body).toEqual(alone.body);
  });

  test("a large page that waits for the slot past its deadline answers StudioTimeoutRefusal naming that wait, outcome unknown", async () => {
    // A page run on the installed core holds the slot: its second batch is held by the test.
    const secondPull = Promise.withResolvers<void>();
    const secondBatch = Promise.withResolvers<void>();
    let pulls = 0;
    const holderSource: ResultSource = {
      columns: [{ name: "v" }],
      next: async () => {
        pulls += 1;
        if (pulls === 2) {
          secondPull.resolve();
          await secondBatch.promise;
        }
        return { rows: [[pulls]], done: pulls >= 2 };
      },
      close: async () => {},
    };
    const holder = hostCore().executeCall(
      {
        calls: {
          console: {
            execute: { honours: [] },
            cancel: "not-offered",
            endScope: "not-offered",
            transaction: "not-offered",
          },
          objects: { tree: "not-offered" },
          maintenance: { run: "not-offered", preview: "not-offered" },
        },
        execute: async () => ({ results: [holderSource], warnings: [], executionTimeMs: 1, pageApplied: true }),
      },
      { statement: "SELECT 1", page: { limit: 10, offset: 0 } },
      { deadline: Date.now() + 60_000, signal: new AbortController().signal, env: envReader([], () => undefined) },
      () => ({ maxRows: 10, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES }),
      { late: () => {}, cancelFailed: () => {} },
    );
    await secondPull.promise;
    // A deadline about 300 ms ahead, which the page spends waiting for the slot.
    const queryTimeout = 300 - EXECUTE_SLACK_MS;

    const caught = await runEditorQuery(largeFake(3, queryTimeout), runOf({ options: { limit: 100 } })).catch(
      (error: unknown) => error,
    );
    secondBatch.resolve();
    const held = await holder;

    expect(caught).toBeInstanceOf(StudioTimeoutRefusal);
    expect((caught as Error).message).toBe(
      `The statement answered, but its page waited for another large page to be answered past its timeout of ${waitedSeconds(queryTimeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more, so Studio stopped waiting for it.`,
    );
    expect(errorKind(caught)).toBe("studio-timeout-refusal");
    expect(errorOutcome(caught)).toBe("unknown");
    expect(databaseErrorBody(caught)?.body).toMatchObject({
      code: "TIMEOUT_ERROR",
      statusCode: 504,
      kind: "studio-timeout-refusal",
      outcome: "unknown",
    });
    expect(held.kind).toBe("page");
    if (held.kind === "page") held.release();
  });

  test("a page whose reading its deadline ends answers StudioTimeoutRefusal saying the statement answered, outcome unknown", async () => {
    // The facade's deadline is at least EXECUTE_SLACK_MS ahead and a bridged pull never blocks, so a core of the
    // test's answers the stop marked as waiting for the page; its cancel is the real core's.
    const real = hostCore();
    const deadlineReason = new DOMException("The call's deadline has passed.", "TimeoutError");
    const caller = new AbortController();
    const callerReason = new DOMException("The request went away.", "AbortError");
    caller.abort(callerReason);
    const answers = [deadlineReason, callerReason];
    const queryTimeout = 2_000;
    forgetHostCore();
    installHostCore(
      {
        executeCall: async () => ({
          kind: "stopped",
          reason: answers.shift(),
          waitingFor: "page",
          settled: Promise.resolve(),
        }),
        cancelCall: real.cancelCall,
        endScopeCall: real.endScopeCall,
        transactionCall: real.transactionCall,
        treeCall: real.treeCall,
        maintenanceRunCall: real.maintenanceRunCall,
        maintenancePreviewCall: real.maintenancePreviewCall,
      },
      "test",
    );
    let timedOut: unknown;
    let left: unknown;
    try {
      const provider = Object.assign(fake(resultOf(rowsOf(1))), { config: connectionWith({ queryTimeout }) });
      timedOut = await runEditorQuery(provider, runOf()).catch((error: unknown) => error);
      left = await runEditorQuery(provider, runOf({ signal: caller.signal })).catch((error: unknown) => error);
    } finally {
      forgetHostCore();
      installHostCore(real, "test");
    }

    expect(timedOut).toBeInstanceOf(StudioTimeoutRefusal);
    expect((timedOut as Error).message).toBe(
      `The statement answered, but Studio did not finish reading its page within its timeout of ${waitedSeconds(queryTimeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more, so it stopped waiting for it.`,
    );
    expect(errorKind(timedOut)).toBe("studio-timeout-refusal");
    expect(errorOutcome(timedOut)).toBe("unknown");
    expect(databaseErrorBody(timedOut)?.body).toMatchObject({
      code: "TIMEOUT_ERROR",
      statusCode: 504,
      kind: "studio-timeout-refusal",
      outcome: "unknown",
    });
    expect(left).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(left)).toBe("unknown");
  });

  test("a run whose closing of its other results its deadline ends answers StudioTimeoutRefusal saying the page was read, outcome unknown", async () => {
    // A bridged run closes its other results at once, so a core of the test's answers the stop marked as closing them.
    const real = hostCore();
    const deadlineReason = new DOMException("The call's deadline has passed.", "TimeoutError");
    const queryTimeout = 2_000;
    forgetHostCore();
    installHostCore(
      {
        executeCall: async () => ({
          kind: "stopped",
          reason: deadlineReason,
          waitingFor: "other-results",
          settled: Promise.resolve(),
        }),
        cancelCall: real.cancelCall,
        endScopeCall: real.endScopeCall,
        transactionCall: real.transactionCall,
        treeCall: real.treeCall,
        maintenanceRunCall: real.maintenanceRunCall,
        maintenancePreviewCall: real.maintenancePreviewCall,
      },
      "test",
    );
    let timedOut: unknown;
    try {
      const provider = Object.assign(fake(resultOf(rowsOf(1))), { config: connectionWith({ queryTimeout }) });
      timedOut = await runEditorQuery(provider, runOf()).catch((error: unknown) => error);
    } finally {
      forgetHostCore();
      installHostCore(real, "test");
    }

    expect(timedOut).toBeInstanceOf(StudioTimeoutRefusal);
    expect((timedOut as Error).message).toBe(
      `The statement answered and Studio read its page, but closing its other results did not finish within its timeout of ${waitedSeconds(queryTimeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more, so Studio stopped waiting for them.`,
    );
    expect(errorOutcome(timedOut)).toBe("unknown");
  });

  test("a row no page can hold is refused in Studio's words", async () => {
    const caught = await runEditorQuery(
      fake(resultOf([{ n: "x".repeat(33 * MIB) }])),
      runOf({ statement: "SELECT n FROM t LIMIT 5" }),
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StudioByteBudgetRefusal);
    expect((caught as Error).message).toBe(
      `A row of the result is ${33 * MIB + 4} bytes, over the 33554432 bytes one page of a result may hold, so Studio answers no page of it.`,
    );
    expect(errorKind(caught)).toBe("studio-byte-budget-refusal");
    expect(databaseErrorBody(caught)?.body).toMatchObject({ code: "QUERY_ERROR", statusCode: 400 });
  });

  test("a failure after the caller left is logged by kind and code, never its text", async () => {
    const secret = crypto.randomUUID();
    let fail: (error: unknown) => void = () => {};
    const held = new Promise<QueryResult>((_resolve, reject) => {
      fail = reject;
    });
    const started = Promise.withResolvers<void>();
    const provider = fake(resultOf(rowsOf(1)), {
      query: mock(() => {
        started.resolve();
        return held;
      }),
    });
    const logged = Promise.withResolvers<unknown[]>();
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      if (args[0] === "A statement Studio stopped waiting for failed afterwards") logged.resolve(args);
    });
    try {
      const controller = new AbortController();
      const running = runEditorQuery(provider, runOf({ signal: controller.signal, route: "late-route" }));
      await started.promise;
      controller.abort();
      expect(await running.catch((error: unknown) => error)).toBeInstanceOf(QueryCancelledError);
      fail(new QueryError(`relation ${secret} does not exist`, "postgres"));

      const args = await logged.promise;
      expect(args).toEqual([
        "A statement Studio stopped waiting for failed afterwards",
        { route: "late-route", kind: "query", code: "QUERY_ERROR" },
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  /** A run whose statement is held until the test settles it, on a provider that can cancel, with every warning kept. */
  async function leftRun(cancelable: boolean) {
    let fail: (error: unknown) => void = () => {};
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const provider = fake(resultOf(rowsOf(1)), {
      query: mock(() => {
        started.resolve();
        return new Promise<QueryResult>((_resolve, reject) => {
          fail = reject;
        });
      }),
      ...(cancelable
        ? {
            cancelQuery: mock(async () => {
              cancelled.resolve();
              return true;
            }),
          }
        : {}),
    });
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const controller = new AbortController();
    const running = runEditorQuery(provider, runOf({ signal: controller.signal, route: "left-route", queryId: "q-5" }));
    await started.promise;
    controller.abort();
    const answered = await running.catch((error: unknown) => error);
    if (cancelable) await cancelled.promise;
    /** Settles the held statement with `error`, then lets its late handler run. */
    const settle = async (error: unknown) => {
      fail(error);
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { answered, settle, warned, restore: () => warn.mockRestore() };
  }
  const LATE_LINE = "A statement Studio stopped waiting for failed afterwards";

  test("the cancellation answer of a run whose cancel the host sent is its expected end, and is not logged", async () => {
    const left = await leftRun(true);
    try {
      expect(left.answered).toBeInstanceOf(QueryCancelledError);
      await left.settle(new QueryCancelledError("canceling statement due to user request", "postgres"));
      expect(left.warned.filter((args) => args[0] === LATE_LINE)).toEqual([]);
    } finally {
      left.restore();
    }
  });

  test("any other late failure is still logged: another error after the cancel, or a cancellation with no cancel sent", async () => {
    const afterCancel = await leftRun(true);
    try {
      await afterCancel.settle(new QueryError("relation t does not exist", "postgres"));
      expect(afterCancel.warned.filter((args) => args[0] === LATE_LINE)).toEqual([
        [LATE_LINE, { route: "left-route", kind: "query", code: "QUERY_ERROR" }],
      ]);
    } finally {
      afterCancel.restore();
    }
    const noCancel = await leftRun(false);
    try {
      await noCancel.settle(new QueryCancelledError("The query was cancelled.", "postgres"));
      expect(noCancel.warned.filter((args) => args[0] === LATE_LINE)).toEqual([
        [LATE_LINE, { route: "left-route", kind: "cancelled", code: "QUERY_CANCELLED" }],
      ]);
    } finally {
      noCancel.restore();
    }
  });

  test("a cancel that fails after the caller left is logged by kind and code, never its text", async () => {
    const secret = crypto.randomUUID();
    const started = Promise.withResolvers<void>();
    const provider = fake(resultOf(rowsOf(1)), {
      query: mock(() => {
        started.resolve();
        return new Promise<QueryResult>(() => {});
      }),
      cancelQuery: mock(async () => {
        throw new ConnectionError(`connection to ${secret} refused`, "postgres");
      }),
    });
    const logged = Promise.withResolvers<unknown[]>();
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      if (args[0] === "The cancel sent after the request was aborted failed") logged.resolve(args);
    });
    try {
      const controller = new AbortController();
      const running = runEditorQuery(
        provider,
        runOf({ signal: controller.signal, route: "cancel-route", queryId: "q-9" }),
      );
      await started.promise;
      controller.abort();
      expect(await running.catch((error: unknown) => error)).toBeInstanceOf(QueryCancelledError);

      const args = await logged.promise;
      expect(args).toEqual([
        "The cancel sent after the request was aborted failed",
        { route: "cancel-route", kind: "connection", code: "CONNECTION_ERROR" },
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the editor call's open wait", () => {
  /** Studio's sentence for an open its engine's budget of `seconds` ended. */
  const OPEN_SENTENCE = (seconds: number) =>
    `The connection did not open within ${seconds} seconds, so Studio stopped waiting for it and sent nothing.`;
  /** An open that settles only when its wait ends, rejecting with the wait's reason, as `openOnce` does. */
  const openUntilWaitEnds = (seen: OpenWait[]) => (wait: OpenWait) => {
    seen.push(wait);
    return new Promise<never>((_resolve, reject) => {
      if (wait.signal.aborted) reject(wait.signal.reason);
      else wait.signal.addEventListener("abort", () => reject(wait.signal.reason), { once: true });
    });
  };
  /** A `now` far enough back that the open allowance of `budgetMs` has already passed. */
  const allowancePassed = (budgetMs = 70_000) => Date.now() - budgetMs - 1_000;

  test("the open allowance is the engine's connect budget", async () => {
    const opened = { opened: true };
    /** Whether the wait `type`'s open is handed, from a `now` `ago` ms back, had already aborted when it was handed. */
    const abortedAt = async (type: DatabaseType, ago: number): Promise<boolean> => {
      let aborted: boolean | undefined;
      await openWithinCall(
        new AbortController().signal,
        type,
        async (wait) => {
          aborted = wait.signal.aborted;
          return opened;
        },
        Date.now() - ago,
      );
      return aborted as boolean;
    };
    const budgets: readonly (readonly [DatabaseType, number])[] = [
      ["postgres", 70_000],
      ["bigquery", 140_000],
      ["snowflake", 80_000],
    ];

    const seen = await Promise.all(
      budgets.map(async ([type, budget]) => [await abortedAt(type, budget - 1_000), await abortedAt(type, budget + 1)]),
    );

    expect(seen).toEqual(budgets.map(() => [false, true]));
  });

  test("an open is handed the call's own wait, which the caller's leaving or the allowance ends", async () => {
    const opened = { opened: true };
    const seen: OpenWait[] = [];
    const answered = await openWithinCall(new AbortController().signal, "postgres", async (wait) => {
      seen.push(wait);
      return opened;
    });
    expect(answered).toBe(opened);
    expect(seen[0]?.signal.aborted).toBe(false);

    const caller = new AbortController();
    const leaving = openWithinCall(caller.signal, "postgres", openUntilWaitEnds(seen)).catch((error: unknown) => error);
    const reason = new Error(`left ${crypto.randomUUID()}`);
    caller.abort(reason);
    await leaving;
    expect(seen[1]?.signal.reason).toBe(reason);

    // An opener that ignores its wait is answered as it is; the allowance had passed before it was called.
    const late = await openWithinCall(
      new AbortController().signal,
      "postgres",
      async (wait) => {
        seen.push(wait);
        return opened;
      },
      allowancePassed(),
    );
    expect(late).toBe(opened);
    const passed = seen[2] as OpenWait;
    expect(passed.signal.aborted).toBe(true);
    expect((passed.signal.reason as Error).name).toBe("TimeoutError");
  });

  test("an open the caller left answers QueryCancelledError, not-sent", async () => {
    const caller = new AbortController();
    const leaving = openWithinCall(caller.signal, "postgres", openUntilWaitEnds([])).catch((error: unknown) => error);
    caller.abort(new DOMException("The request went away.", "AbortError"));

    const caught = await leaving;

    expect(caught).toBeInstanceOf(QueryCancelledError);
    expect((caught as Error).message).toBe("The query was cancelled.");
    expect(errorOutcome(caught)).toBe("not-sent");
    expect(errorKind(caught)).toBe("cancelled");
  });

  test("an open past its allowance answers StudioTimeoutRefusal naming the engine's budget, not-sent", async () => {
    const [bigquery, postgres] = await Promise.all(
      (
        [
          ["bigquery", 140_000],
          ["postgres", 70_000],
        ] as const
      ).map(([type, budget]) =>
        openWithinCall(new AbortController().signal, type, openUntilWaitEnds([]), allowancePassed(budget)).catch(
          (error: unknown) => error,
        ),
      ),
    );

    expect(bigquery).toBeInstanceOf(StudioTimeoutRefusal);
    expect((bigquery as Error).message).toBe(OPEN_SENTENCE(140));
    expect((postgres as Error).message).toBe(OPEN_SENTENCE(70));
    for (const caught of [bigquery, postgres]) {
      expect(errorOutcome(caught)).toBe("not-sent");
      expect(databaseErrorBody(caught)?.body).toMatchObject({
        code: "TIMEOUT_ERROR",
        statusCode: 504,
        kind: "studio-timeout-refusal",
        outcome: "not-sent",
      });
    }
  });

  test("an open's own failure passes as the same object", async () => {
    const refused = new ConnectionError(`refused by ${crypto.randomUUID()}`, "postgres");
    markNotSent(refused);
    const caught = await openWithinCall(new AbortController().signal, "postgres", async () => {
      throw refused;
    }).catch((error: unknown) => error);
    expect(caught).toBe(refused);
    expect(errorOutcome(caught)).toBe("not-sent");

    // A failure of its own after the caller left is still its own, not the caller's leaving.
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));
    const own = new ConnectionError(`refused by ${crypto.randomUUID()}`, "postgres");
    const ownCaught = await openWithinCall(caller.signal, "postgres", async () => {
      throw own;
    }).catch((error: unknown) => error);
    expect(ownCaught).toBe(own);
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
        "src/lib/api/first-result-set.ts",
        "src/lib/api/page-probe.ts",
        "src/lib/db/destructive-commands.ts",
        "src/lib/db/errors.ts",
        "src/lib/db/query-cancel.ts",
        "src/lib/db/types.ts",
        "src/lib/db/utils/query-limiter.ts",
        "src/lib/non-finite.ts",
        "src/lib/provider-host/access.ts",
        "src/lib/provider-host/instance.ts",
        "src/lib/provider-host/legacy-bridge.ts",
      ]),
    );
    expect(closure.modules).not.toContain("src/lib/api/abort-cancel.ts");
    // The facade reads the process's host core and holds no copy of the core's calls (clause C-52).
    expect(closure.modules).not.toContain("src/lib/provider-host/core/console.ts");
    expect(closure.modules).not.toContain("src/lib/provider-host/core/turns.ts");
  });

  test("a control: the same walk over the query route finds Next and governance", () => {
    expect(serverOnlyReach(valueImportClosure("src/app/api/db/query/route.ts"))).toEqual(
      expect.arrayContaining(["next/server", "src/lib/governance/config.ts"]),
    );
  });
});
