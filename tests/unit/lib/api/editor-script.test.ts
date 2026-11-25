/**
 * The editor's script facade (src/lib/api/editor-script.ts; docs/providers/CONTRACT.md, clause C-83): every unit of a
 * script of `POST /api/db/multi-query` runs through one host core console execute on a script unit session of its
 * own, under its own deadline and the request's signal, its answer built from the provider's result by reference
 * before its page record is released, and the script's scope ended once after the last unit it ran.
 *
 * The real host core is installed for the file; a case that needs to see the call installs a core of its own around
 * the real one and restores it. A deadline case hands the facade a unit start that puts the deadline a few tens of
 * milliseconds out and settles the facade's outcome with a plain `await`, which never rejects for a stop.
 * `editor-script-bounds.test.ts` holds a provider that never answers in a bounded Node child. A
 * `process.on("unhandledRejection")` counter must read zero after every abandoned call settled.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BATCH_MAX_BYTES,
  type CallContext,
  CLEANUP_DEADLINE_MS,
  envReader,
  type EndScopeRequest,
  type ExecuteRequest,
  PAGE_MAX_BYTES,
  type ResultSource,
} from "@libredb/provider-sdk/calls";
import { EXECUTE_SLACK_MS, executeViews } from "@/lib/api/editor-query";
import { type EditorScriptRun, openEditorScript, type ScriptUnitOutcome } from "@/lib/api/editor-script";
import { errorOutcome } from "@/lib/db/error-record";
import { QueryCancelledError, StudioByteBudgetRefusal, StudioTimeoutRefusal } from "@/lib/db/errors";
import { DEFAULT_QUERY_TIMEOUT, type DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { ConsoleSession, ExecuteRecord } from "@/lib/provider-host/core/console";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, HostCoreBootOrderError, hostCore, installHostCore } from "@/lib/provider-host/instance";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { splitExecutionUnits } from "@/lib/sql/statement-splitter";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
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

const ROUTE = "api/db/multi-query";
const MIB = 1024 * 1024;
const marker = (): string => randomUUID();

const resultOf = (rows: Record<string, unknown>[]): QueryResult => ({
  rows,
  fields: Object.keys(rows[0] ?? { n: 1 }),
  rowCount: rows.length,
  executionTime: 2,
});

/** The limiter's rule as a SQL provider applies it: a bound of ours on a read. */
const limiter = (sql: string, options: { limit?: number } = {}) => ({
  query: `${sql} LIMIT ${options.limit ?? 500}`,
  wasLimited: true,
  limit: options.limit ?? 500,
  offset: 0,
});

/** A postgres provider whose query answers what `answer` gives, with `extra` laid over it. */
function providerOf(
  answer: (sql: string) => Promise<QueryResult>,
  extra: Record<string, unknown> = {},
): DatabaseProvider & { query: ReturnType<typeof mock>; prepareQuery: ReturnType<typeof mock> } {
  return Object.assign(
    createMockProvider({ type: "postgres" }),
    {
      query: mock<(sql: string) => Promise<QueryResult>>((sql) => answer(sql)),
      prepareQuery: mock(limiter),
    },
    extra,
  ) as never;
}

/** A provider configured with `queryTimeout`. */
function withTimeout<P extends DatabaseProvider>(provider: P, queryTimeout: number): P {
  return Object.assign(provider, { config: { ...provider.config, queryTimeout } as DatabaseConnection });
}

/** A script of `sql` as the route opens it, each member overridable. */
function scriptOf(sql: string, over: Partial<EditorScriptRun> = {}): EditorScriptRun {
  return {
    units: splitExecutionUnits(sql, resolveSqlGrammar("postgres")),
    dialect: "postgres",
    options: { limit: 50 },
    signal: new AbortController().signal,
    route: ROUTE,
    ...over,
  };
}

/** The unit's result, by reference, as its answer. */
const asIs = (result: QueryResult): QueryResult => result;

/** Runs every unit of `script` on `provider` in order, stopping at the first failure, and answers each outcome. */
async function runAll(provider: DatabaseProvider, script: EditorScriptRun): Promise<ScriptUnitOutcome<QueryResult>[]> {
  const opened = openEditorScript(provider, script);
  const outcomes: ScriptUnitOutcome<QueryResult>[] = [];
  for (let index = 0; index < script.units.length; index++) {
    // oxlint-disable-next-line no-await-in-loop -- the units run in order, as the route runs them.
    const outcome = await opened.runUnit(index, asIs);
    outcomes.push(outcome);
    if (outcome.kind === "failed") break;
  }
  return outcomes;
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

/** One execute the counting core saw. */
interface SeenCall {
  readonly session: ConsoleSession;
  readonly request: ExecuteRequest;
  readonly ctx: CallContext;
}

/** A core around the real one that records every execute call and end call it is handed. */
function countingCore(seen: SeenCall[], ends: { request: EndScopeRequest; ctx: CallContext }[] = []) {
  return (real: HostCore): HostCore => ({
    ...real,
    executeCall: (session, request, ctx, limits, ports) => {
      seen.push({ session, request, ctx });
      return real.executeCall(session, request, ctx, limits, ports);
    },
    endScopeCall: (session, request, ctx, ports) => {
      ends.push({ request, ctx });
      return real.endScopeCall(session, request, ctx, ports);
    },
  });
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

/** The error of a failed outcome; an answered one fails the case. */
function failedWith<T>(outcome: ScriptUnitOutcome<T>): unknown {
  if (outcome.kind !== "failed") throw new Error("The unit was expected to fail, and it answered.");
  return outcome.error;
}

/** A unit start that puts a unit's deadline `ms` out on `provider`. */
const startFor = (provider: DatabaseProvider, ms: number): number =>
  Date.now() - ((provider.config.queryTimeout ?? DEFAULT_QUERY_TIMEOUT) + EXECUTE_SLACK_MS) + ms;

/** A turn of the event loop, so a settled call's handlers have run. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("openEditorScript", () => {
  test("each unit is one host core execute call on a script unit session of its own, on a fresh request and a context of deadline, signal and env alone", async () => {
    const provider = providerOf(async () => resultOf([{ n: 1 }]));
    const seen: SeenCall[] = [];

    const outcomes = await withCore(countingCore(seen), () =>
      runAll(provider, scriptOf("SELECT 1; SELECT 2; SELECT 3")),
    );

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["answered", "answered", "answered"]);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((call) => call.session)).size).toBe(3);
    expect(new Set(seen.map((call) => call.request)).size).toBe(3);
    expect(new Set(seen.map((call) => call.ctx)).size).toBe(3);
    for (const call of seen) {
      expect(call.session.calls.console.execute.honours).toEqual(["offset"]);
      expect(Object.isFrozen(call.request)).toBe(true);
      expect(Object.isFrozen(call.ctx)).toBe(true);
      expect(Reflect.ownKeys(call.ctx).sort()).toEqual(["deadline", "env", "signal"]);
      expect(call.ctx.signal.aborted).toBe(false);
    }
    expect(seen.map((call) => call.request.statement)).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
    expect(provider.query.mock.calls.map((call) => call[0])).toEqual(["SELECT 1", "SELECT 2", "SELECT 3 LIMIT 50"]);

    const opened = openEditorScript(provider, scriptOf("SELECT 1"));
    expect(() => opened.runUnit(1, asIs)).toThrow(
      "The editor's script was asked for its unit at index 1, and it holds 1, a defect of the caller.",
    );
  });

  test("every unit but the last asks every row, and the last asks the request's page", async () => {
    const seen: SeenCall[] = [];
    const provider = providerOf(async () => resultOf([{ n: 1 }]));

    await withCore(countingCore(seen), () =>
      runAll(provider, scriptOf("SELECT 1; SELECT 2; SELECT 3", { options: { limit: 50, offset: 100 } })),
    );

    expect(seen.map((call) => call.request.page)).toEqual([
      { unlimited: true },
      { unlimited: true },
      { limit: 50, offset: 100 },
    ]);
    expect(provider.prepareQuery.mock.calls).toEqual([["SELECT 3", { limit: 50, offset: 100 }]]);
  });

  test("the request names the run by its queryId, and carries the script's scope only on a session that offers console.endScope", async () => {
    const queryId = marker();
    const ending = providerOf(async () => resultOf([{ n: 1 }]), {
      endOpenQueryTransaction: mock<(scope: string) => Promise<string>>(async () => "none"),
    });
    const named: SeenCall[] = [];
    const plain: SeenCall[] = [];

    await withCore(countingCore(named), () => runAll(ending, scriptOf("SELECT 1; SELECT 2", { queryId })));
    await withCore(countingCore(plain), () =>
      runAll(
        providerOf(async () => resultOf([])),
        scriptOf("SELECT 1"),
      ),
    );

    expect(named.map((call) => call.request.runId)).toEqual([queryId, queryId]);
    const scopes = named.map((call) => call.request.scope);
    expect(typeof scopes[0]).toBe("string");
    expect(new Set(scopes).size).toBe(1);
    expect(Object.keys(plain[0]?.request ?? {}).sort()).toEqual(["page", "statement"]);
  });

  test("a unit's answer is built from the provider's result by reference before its page record is released exactly once", async () => {
    const result = resultOf([{ n: 1 }, { n: 2 }]);
    const provider = providerOf(async () => result);
    let releases = 0;
    let releasedAtBuild: number | undefined;

    const outcome = await withCore(
      (real) => ({
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
      }),
      () =>
        openEditorScript(provider, scriptOf("SELECT n FROM t")).runUnit(0, (answered) => {
          releasedAtBuild = releases;
          return answered;
        }),
    );

    expect(outcome).toEqual({ kind: "answered", value: result });
    expect(outcome.kind === "answered" && outcome.value).toBe(result);
    expect(releasedAtBuild).toBe(0);
    expect(releases).toBe(1);
  });

  test("a page record is released once even when building the unit's answer throws", async () => {
    const provider = providerOf(async () => resultOf([{ n: 1 }]));
    const thrown = new Error(marker());
    let releases = 0;

    const outcome = await withCore(
      (real) => ({
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
      }),
      () =>
        openEditorScript(provider, scriptOf("SELECT n FROM t")).runUnit(0, () => {
          throw thrown;
        }),
    );

    expect(failedWith(outcome)).toBe(thrown);
    expect(releases).toBe(1);
  });

  test("a unit's answer keeps every row, however many pages its rows would fill", async () => {
    const mebibyte = "x".repeat(MIB);
    const rows = Array.from({ length: 40 }, () => ({ n: mebibyte }));
    const result = resultOf(rows);
    const provider = providerOf(async () => result);

    const outcome = await openEditorScript(provider, scriptOf("SELECT n FROM t; SELECT 1")).runUnit(0, asIs);

    expect(outcome.kind === "answered" && outcome.value).toBe(result);
    expect(result.rows).toHaveLength(40);
  });

  test("a unit row larger than one page is refused as StudioByteBudgetRefusal, outcome unknown", async () => {
    const wide = "x".repeat(33 * MIB);
    const provider = providerOf(async () => resultOf([{ wide }]));

    const refused = failedWith(await openEditorScript(provider, scriptOf("SELECT wide FROM t")).runUnit(0, asIs));

    expect(refused).toBeInstanceOf(StudioByteBudgetRefusal);
    expect((refused as Error).message).toMatch(
      /^A row of the result is \d+ bytes, over the 33554432 bytes one page of a result may hold, so Studio answers no page of it\.$/,
    );
    expect(errorOutcome(refused)).toBe("unknown");
  });

  test("a value nested past the value codec's depth bound in a unit's first result is the unit's error in the codec's sentence", async () => {
    let deep: unknown = 1;
    for (let depth = 0; depth < 300; depth++) deep = { d: deep };
    const provider = providerOf(async () => resultOf([{ n: deep }]));

    const refused = failedWith(await openEditorScript(provider, scriptOf("SELECT n FROM t")).runUnit(0, asIs));

    expect((refused as Error).name).toBe("ValueCodecError");
    expect((refused as Error).message).toStartWith(
      "The value codec cannot encode a value nested deeper than 256 arrays and objects",
    );
  });

  test("a script opened before the host core is installed throws by name and calls no provider", () => {
    const provider = providerOf(async () => resultOf([]), {
      endOpenQueryTransaction: mock<(scope: string) => Promise<string>>(async () => "none"),
    });
    const real = hostCore();
    forgetHostCore();
    let thrown: unknown;
    try {
      openEditorScript(provider, scriptOf("SELECT 1"));
    } catch (error) {
      thrown = error;
    } finally {
      installHostCore(real, "test");
    }

    expect(thrown).toBeInstanceOf(HostCoreBootOrderError);
    expect(provider.query).not.toHaveBeenCalled();
    expect(provider.prepareQuery).not.toHaveBeenCalled();
  });
});

describe("a script unit's wait", () => {
  test("a unit's deadline is its connection's statement timeout plus ten seconds from the unit's start", async () => {
    const seen: SeenCall[] = [];
    const configured = withTimeout(
      providerOf(async () => resultOf([])),
      5_000,
    );
    const defaulted = providerOf(async () => resultOf([]));
    const now = Date.now();

    await withCore(countingCore(seen), async () => {
      await openEditorScript(configured, scriptOf("SELECT 1")).runUnit(0, asIs, now);
      await openEditorScript(defaulted, scriptOf("SELECT 1")).runUnit(0, asIs, now);
    });

    expect(seen.map((call) => call.ctx.deadline)).toEqual([
      now + 5_000 + EXECUTE_SLACK_MS,
      now + DEFAULT_QUERY_TIMEOUT + EXECUTE_SLACK_MS,
    ]);
  });

  test("a unit its deadline stops answers StudioTimeoutRefusal in the statement's sentence, outcome unknown, and its later failure is logged by kind and code only", async () => {
    const secret = marker();
    const pending = Promise.withResolvers<QueryResult>();
    const provider = withTimeout(
      providerOf(() => pending.promise),
      1,
    );
    const script = scriptOf("SELECT 1; SELECT 2");

    const warned = await warningsOf(async () => {
      const outcome = await openEditorScript(provider, script).runUnit(0, asIs, startFor(provider, 30));
      const stopped = failedWith(outcome);

      expect(stopped).toBeInstanceOf(StudioTimeoutRefusal);
      expect((stopped as Error).message).toBe(executeViews(provider, script.signal).view.deadlineSentence);
      expect(errorOutcome(stopped)).toBe("unknown");
      pending.reject(new Error(secret));
      await turn();
      await turn();
    });

    expect(warned).toEqual([
      [
        "A statement Studio stopped waiting for failed afterwards",
        { route: ROUTE, kind: "internal", code: "INTERNAL_ERROR" },
      ],
    ]);
    expect(JSON.stringify(warned)).not.toContain(secret);
  });

  test("a unit whose request leaves answers QueryCancelledError at once, and the core sends its run's cancel once", async () => {
    const reached = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<QueryResult>();
    const cancelQuery = mock<(runId: string) => Promise<boolean>>(async () => {
      pending.reject(new QueryCancelledError("The query was cancelled."));
      return true;
    });
    const provider = providerOf(
      () => {
        reached.resolve();
        return pending.promise;
      },
      { cancelQuery },
    );
    const controller = new AbortController();
    const queryId = marker();

    const warned = await warningsOf(async () => {
      const running = openEditorScript(provider, scriptOf("SELECT 1", { signal: controller.signal, queryId })).runUnit(
        0,
        asIs,
      );
      await reached.promise;
      controller.abort(new DOMException("The request went away.", "AbortError"));
      const stopped = failedWith(await running);

      expect(stopped).toBeInstanceOf(QueryCancelledError);
      expect(errorOutcome(stopped)).toBe("unknown");
      await turn();
      await turn();
    });

    expect(cancelQuery.mock.calls).toEqual([[queryId]]);
    expect(warned).toEqual([]);
  });

  test("a unit whose page waits for the large-page slot past its deadline answers the slot's sentence", async () => {
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
          monitoring: { panel: "not-offered", poolStats: "not-offered" },
        },
        readOnlyStatements: false,
        execute: async () => ({ results: [holderSource], warnings: [], executionTimeMs: 1, pageApplied: true }),
      },
      { statement: "SELECT 1", page: { limit: 10, offset: 0 } },
      { deadline: Date.now() + 60_000, signal: new AbortController().signal, env: envReader([], () => undefined) },
      () => ({ maxRows: 10, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES }),
      { late: () => {}, cancelFailed: () => {} },
    );
    await secondPull.promise;
    const mebibyte = "x".repeat(MIB);
    const provider = providerOf(async () => resultOf([{ n: mebibyte }, { n: mebibyte }, { n: mebibyte }]));
    const script = scriptOf("SELECT n FROM t; SELECT 1");

    // A deadline about 300 ms out, which the page spends waiting for the slot.
    const outcome = await openEditorScript(provider, script).runUnit(0, asIs, startFor(provider, 300));
    secondBatch.resolve();
    const held: ExecuteRecord = await holder;
    if (held.kind === "page") held.release();
    const stopped = failedWith(outcome);

    expect(stopped).toBeInstanceOf(StudioTimeoutRefusal);
    expect((stopped as Error).message).toBe(
      executeViews(provider, script.signal).stopView({
        kind: "stopped",
        reason: undefined,
        waitingFor: "large-page-slot",
        settled: Promise.resolve(),
      }).deadlineSentence,
    );
    expect((stopped as Error).message).toContain("waited for another large page");
    expect(errorOutcome(stopped)).toBe("unknown");
  });

  test("a unit started after its request left is refused before the call and reaches no provider", async () => {
    const endOpenQueryTransaction = mock<(scope: string) => Promise<string>>(async () => "rolled-back");
    const provider = providerOf(async () => resultOf([]), { endOpenQueryTransaction });
    const controller = new AbortController();
    controller.abort(new DOMException("The request went away.", "AbortError"));
    const opened = openEditorScript(provider, scriptOf("SELECT 1; SELECT 2", { signal: controller.signal }));

    const refused = failedWith(await opened.runUnit(0, asIs));

    expect(refused).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(refused)).toBe("not-sent");
    expect(provider.query).not.toHaveBeenCalled();
    // A script none of whose units reached its provider ends no scope.
    expect(await opened.end()).toEqual({ offered: true, openTransaction: "none" });
    expect(endOpenQueryTransaction).not.toHaveBeenCalled();
  });

  test("a provider's error passes as the same object", async () => {
    const thrown = new Error(marker());
    const provider = providerOf(async () => {
      throw thrown;
    });

    expect(failedWith(await openEditorScript(provider, scriptOf("SELECT 1")).runUnit(0, asIs))).toBe(thrown);
  });
});

describe("a script's scope", () => {
  test("the script's scope is ended once after its last unit, under a cleanup context of its own", async () => {
    const endOpenQueryTransaction = mock<(scope: string) => Promise<string>>(async () => "rolled-back");
    const provider = providerOf(async () => resultOf([]), { endOpenQueryTransaction });
    const controller = new AbortController();
    const seen: SeenCall[] = [];
    const ends: { request: EndScopeRequest; ctx: CallContext }[] = [];
    const script = scriptOf("BEGIN; INSERT INTO t VALUES (1)", { signal: controller.signal });

    const before = Date.now();
    const ended = await withCore(countingCore(seen, ends), async () => {
      const opened = openEditorScript(provider, script);
      await opened.runUnit(0, asIs);
      await opened.runUnit(1, asIs);
      expect(endOpenQueryTransaction).not.toHaveBeenCalled();
      controller.abort(new DOMException("The request went away.", "AbortError"));
      return opened.end();
    });
    const after = Date.now();

    expect(ended).toEqual({ offered: true, openTransaction: "rolled-back" });
    expect(ends).toHaveLength(1);
    expect(ends[0]?.request).toEqual({ scope: seen[0]?.request.scope as string });
    expect(seen[1]?.request.scope).toBe(seen[0]?.request.scope as string);
    expect(endOpenQueryTransaction.mock.calls).toEqual([[seen[0]?.request.scope as string]]);
    expect(ends[0]?.ctx.deadline).toBeGreaterThanOrEqual(before + CLEANUP_DEADLINE_MS);
    expect(ends[0]?.ctx.deadline).toBeLessThanOrEqual(after + CLEANUP_DEADLINE_MS);
    expect(ends[0]?.ctx.signal.aborted).toBe(false);
  });

  test("a provider that ends nothing is sent no scope and asked to end none", async () => {
    const provider = providerOf(async () => resultOf([]));
    const seen: SeenCall[] = [];
    const ends: { request: EndScopeRequest; ctx: CallContext }[] = [];

    const ended = await withCore(countingCore(seen, ends), async () => {
      const opened = openEditorScript(provider, scriptOf("SELECT 1; SELECT 2"));
      await opened.runUnit(0, asIs);
      await opened.runUnit(1, asIs);
      return opened.end();
    });

    expect(ended).toEqual({ offered: false });
    expect(seen.map((call) => Object.hasOwn(call.request, "scope"))).toEqual([false, false]);
    expect(ends).toEqual([]);
  });

  test("after a unit Studio stopped waiting for, the scope is ended once that unit settled, and an end that fails is logged by kind and code only", async () => {
    const secret = marker();
    const reached = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<QueryResult>();
    const endReached = Promise.withResolvers<void>();
    const endOpenQueryTransaction = mock<(scope: string) => Promise<string>>(async () => {
      endReached.resolve();
      throw new Error(secret);
    });
    const provider = providerOf(
      () => {
        reached.resolve();
        return pending.promise;
      },
      { endOpenQueryTransaction },
    );
    const controller = new AbortController();
    const ends: { request: EndScopeRequest; ctx: CallContext }[] = [];

    const warned = await warningsOf(async () => {
      await withCore(countingCore([], ends), async () => {
        const opened = openEditorScript(provider, scriptOf("BEGIN; SELECT 1", { signal: controller.signal }));
        const running = opened.runUnit(0, asIs);
        await reached.promise;
        controller.abort(new DOMException("The request went away.", "AbortError"));
        expect(failedWith(await running)).toBeInstanceOf(QueryCancelledError);

        expect(await opened.end()).toEqual({ offered: true, openTransaction: "none" });
        await turn();
        expect(endOpenQueryTransaction).not.toHaveBeenCalled();
        pending.resolve(resultOf([]));
        await endReached.promise;
        await turn();
        await turn();
      });
    });

    expect(ends).toHaveLength(1);
    expect(endOpenQueryTransaction).toHaveBeenCalledTimes(1);
    expect(warned).toEqual([
      [
        "Ending the transaction a run Studio stopped waiting for may have left open failed",
        { route: ROUTE, kind: "internal", code: "INTERNAL_ERROR" },
      ],
    ]);
    expect(JSON.stringify(warned)).not.toContain(secret);
  });
});
