/**
 * The provider host's rules for the query, cancel and transaction surface (docs/providers/CONTRACT.md, clauses C-27,
 * C-28, C-30, C-48 and E-5), held through the caller facades (src/lib/api/editor-query.ts and
 * src/lib/api/editor-transaction.ts), the legacy bridge and the host core together: no statement starts once the call's
 * signal aborted, a cancel answers what the engine did, an engine that cannot cancel is called for nothing, every
 * provider promise the host abandons keeps a rejection handler, and a failure's outcome says whether the statement can
 * have reached the database; and the protected read path is never left for the plain one (E21-K8, clause C-39).
 *
 * Every provider is a fake the test drives through promises it settles itself; no assertion follows a timer. A
 * `process.on("unhandledRejection")` counter, registered for the file, must read zero after every abandoned promise
 * has settled.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BATCH_MAX_BYTES, envReader, PAGE_MAX_BYTES, rowsSource } from "@libredb/provider-sdk/calls";
import { cancelEditorRun, runEditorQuery } from "@/lib/api/editor-query";
import { beginInTransaction, runInTransaction } from "@/lib/api/editor-transaction";
import { databaseErrorBody } from "@/lib/api/error-body";
import { errorOutcome } from "@/lib/db/error-record";
import { checkoutPhase, ConnectionError, connectPhase, QueryCancelledError } from "@/lib/db/errors";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { consoleCalls, type ExecuteRecord } from "@/lib/provider-host/core/console";
import { createPageBudget, LARGE_PAGE_SLOTS } from "@/lib/provider-host/core/page-budget";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";
import { bridgedReadOnlyStatements } from "@/lib/provider-host/legacy-bridge";
import { StudioProfileRefusal } from "@/lib/db/errors";

// The editor query reads the process's host core (src/lib/provider-host/instance.ts), so this file composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const marker = (): string => randomUUID();

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
});

const connection = {
  id: "c1",
  name: "Prod",
  type: "postgres",
  host: "db.internal",
  createdAt: new Date(0),
} as DatabaseConnection;
const scrub = providerTextScrub(connection, "any");

const resultOf = (count: number): QueryResult => ({
  rows: Array.from({ length: count }, (_, n) => ({ n: n + 1 })),
  fields: ["n"],
  rowCount: count,
  executionTime: 1,
});

/** A provider whose `query` is held until the test settles it, resolving `started` when it is called. */
function heldProvider(extra: Record<string, unknown> = {}) {
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<QueryResult>();
  const provider: DatabaseProvider = Object.assign(
    createMockProvider({ config: connection }),
    {
      query: mock(() => {
        started.resolve();
        return answer.promise;
      }),
    },
    extra,
  );
  return { provider, started: started.promise, answer };
}

const runOf = (signal: AbortSignal, queryId?: string) => ({
  statement: "SELECT n FROM t",
  options: { limit: 2 },
  signal,
  route: "host-rules",
  scrub,
  ...(queryId === undefined ? {} : { queryId }),
});

const callsOf = (fn: unknown) => (fn as ReturnType<typeof mock>).mock.calls;

/** Lets every callback already queued run: one turn of the event loop. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("E21-K10: cancellation and abandonment", () => {
  test("no statement starts once the call's signal aborted", async () => {
    const { provider } = heldProvider({ cancelQuery: mock(async () => true) });
    const controller = new AbortController();
    controller.abort();

    const caught = await runEditorQuery({ form: "provider", provider }, runOf(controller.signal, "q-1")).catch(
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(caught)).toBe("not-sent");
    expect(callsOf(provider.prepareQuery)).toHaveLength(0);
    expect(callsOf(provider.query)).toHaveLength(0);
    expect(callsOf((provider as unknown as { cancelQuery: unknown }).cancelQuery)).toHaveLength(0);
  });

  test("a cancel of an unknown run answers cancelled false", async () => {
    const cancelQuery = mock(async (id: string) => id === "known");
    const provider = Object.assign(createMockProvider({ config: connection }), { cancelQuery });

    const answer = await cancelEditorRun(provider, marker(), new AbortController().signal, "host-rules");

    expect(answer).toEqual({ offered: true, cancelled: false });
    expect(callsOf(cancelQuery)).toHaveLength(1);
  });

  test("an engine that cannot cancel is reported still running, and nothing is called", async () => {
    const provider = createMockProvider({ config: connection });

    const answer = await cancelEditorRun(provider, marker(), new AbortController().signal, "host-rules");

    expect(answer).toEqual({ offered: false });
    expect("cancelQuery" in provider).toBe(false);
    expect(callsOf(provider.query)).toHaveLength(0);
  });

  test("an answer the host abandoned keeps its handler", async () => {
    const cancelQuery = mock(async () => true);
    const late = heldProvider({ cancelQuery });
    const controller = new AbortController();

    const running = runEditorQuery({ form: "provider", provider: late.provider }, runOf(controller.signal, "q-2"));
    await late.started;
    controller.abort();
    const caught = await running.catch((error: unknown) => error);
    late.answer.resolve(resultOf(3));
    await turn();
    await turn();

    expect(caught).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(caught)).toBe("unknown");
    expect(callsOf(cancelQuery)).toEqual([["q-2"]]);
    expect(unhandled).toEqual([]);
  });
});

describe("E21-K8: the protected read path", () => {
  test("the host never falls back from the protected read path to the plain one: a read-only statement session without queryReadOnly is refused at its open, a plain statement on one is refused before the call, and query() is never called", async () => {
    const without = Object.assign(createMockProvider({ config: connection }), {
      query: mock(async () => resultOf(1)),
      prepareQuery: mock(() => ({ query: "SELECT 1", wasLimited: false, limit: 1, offset: 0 })),
    });
    let refused: unknown;
    try {
      bridgedReadOnlyStatements(without, { type: "postgres", statementTimeoutMs: 1_000 });
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(StudioProfileRefusal);
    expect((refused as StudioProfileRefusal).reasonCode).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
    expect(without.query).not.toHaveBeenCalled();
    expect(without.prepareQuery).not.toHaveBeenCalled();

    const queryReadOnly = mock(async () => resultOf(1));
    const withPath = Object.assign(createMockProvider({ config: connection }), {
      query: mock(async () => resultOf(1)),
      prepareQuery: mock(() => ({ query: "SELECT 1", wasLimited: false, limit: 1, offset: 0 })),
      queryReadOnly,
    });
    const bridged = bridgedReadOnlyStatements(withPath, { type: "postgres", statementTimeoutMs: 1_000 });
    const record = await hostCore().executeCall(
      bridged.session,
      { statement: `SELECT ${marker()}`, page: { unlimited: true } },
      { deadline: Date.now() + 60_000, signal: new AbortController().signal, env: envReader([], () => undefined) },
      bridged.pumpLimits,
      { late: () => {}, cancelFailed: () => {} },
    );

    expect(record).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "request-read-only-missing", pointer: "/readOnly" }],
    });
    expect(queryReadOnly).not.toHaveBeenCalled();
    expect(withPath.query).not.toHaveBeenCalled();
    expect(withPath.prepareQuery).not.toHaveBeenCalled();
  });
});

describe("E21-K16: abandoned promises", () => {
  test("every provider promise the host abandons keeps a rejection handler", async () => {
    const warned = Promise.withResolvers<void>();
    const lines: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args);
      if (lines.length === 2) warned.resolve();
    });
    try {
      // The stopped execute, and the cancel it sends, each reject after the stop.
      const cancelFailure = new Error(marker());
      const held = heldProvider({
        cancelQuery: mock(async () => {
          throw cancelFailure;
        }),
      });
      const controller = new AbortController();
      const running = runEditorQuery({ form: "provider", provider: held.provider }, runOf(controller.signal, "q-3"));
      await held.started;
      controller.abort();
      expect(await running.catch((error: unknown) => error)).toBeInstanceOf(QueryCancelledError);
      held.answer.reject(new Error(marker()));
      await warned.promise;

      // A source whose close rejects, answered after the stop, reaches the core's late handler.
      const closeFailure = new Error(marker());
      const reachedLate = Promise.withResolvers<unknown>();
      const answer = Promise.withResolvers<never>();
      const executeStarted = Promise.withResolvers<void>();
      const coreController = new AbortController();
      const { executeCall } = consoleCalls(createPageBudget(LARGE_PAGE_SLOTS));
      const stopped: Promise<ExecuteRecord> = executeCall(
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
          execute: () => {
            executeStarted.resolve();
            return answer.promise;
          },
        },
        { statement: "SELECT 1", page: { limit: 1, offset: 0 } },
        { deadline: Date.now() + 60_000, signal: coreController.signal, env: envReader([], () => undefined) },
        () => ({ maxRows: 1, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES }),
        { late: (error) => reachedLate.resolve(error), cancelFailed: () => {} },
      );
      await executeStarted.promise;
      coreController.abort();
      expect((await stopped).kind).toBe("stopped");
      const source = rowsSource([{ name: "n" }], [[1]]);
      answer.resolve({
        results: [{ ...source, close: async () => Promise.reject(closeFailure) }],
        warnings: [],
        executionTimeMs: 0,
        pageApplied: false,
      } as never);
      const lateError = await reachedLate.promise;
      await turn();

      expect(lines.map((line) => line[0]).sort()).toEqual([
        "A statement Studio stopped waiting for failed afterwards",
        "The cancel sent after the request was aborted failed",
      ]);
      expect(lateError).toBeInstanceOf(AggregateError);
      expect((lateError as AggregateError).errors).toEqual([closeFailure]);
      expect(unhandled).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("E23-K1: what a lost or failed connection answers", () => {
  test("a socket lost mid-statement answers CONNECTION_ERROR with outcome unknown", async () => {
    const lost = new ConnectionError("Connection terminated unexpectedly", "postgres");
    const provider = Object.assign(createMockProvider({ config: connection }), {
      query: mock(async () => {
        throw lost;
      }),
    });

    const caught = await runEditorQuery({ form: "provider", provider }, runOf(new AbortController().signal)).catch(
      (error: unknown) => error,
    );

    expect(caught).toBe(lost);
    expect(databaseErrorBody(caught)?.body).toMatchObject({
      code: "CONNECTION_ERROR",
      statusCode: 503,
      outcome: "unknown",
    });
  });

  test("a connect that fails answers not-sent", async () => {
    const refused = new ConnectionError("connect ECONNREFUSED", "postgres");

    const caught = await connectPhase(async () => {
      throw refused;
    }).catch((error: unknown) => error);

    expect(caught).toBe(refused);
    expect(databaseErrorBody(caught)?.body).toMatchObject({
      code: "CONNECTION_ERROR",
      statusCode: 503,
      outcome: "not-sent",
    });
  });

  test("a checkout failure inside execute answers not-sent", async () => {
    const refused = new ConnectionError("connect ECONNREFUSED 127.0.0.1:5432", "postgres");
    const provider = Object.assign(createMockProvider({ config: connection }), {
      query: mock(() =>
        checkoutPhase(
          () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
          () => refused,
        ),
      ),
    });

    const caught = await runEditorQuery({ form: "provider", provider }, runOf(new AbortController().signal)).catch(
      (error: unknown) => error,
    );

    expect(caught).toBe(refused);
    expect(databaseErrorBody(caught)?.body).toMatchObject({
      code: "CONNECTION_ERROR",
      statusCode: 503,
      kind: "connection",
      outcome: "not-sent",
    });
  });

  /** A transaction provider whose session state the test sets through `open`. */
  function transactionProvider(extra: Record<string, unknown>) {
    const session = { open: false };
    const provider: DatabaseProvider = Object.assign(
      createMockProvider({ config: connection }),
      {
        beginTransaction: mock(async () => {
          session.open = true;
        }),
        commitTransaction: mock(async () => {}),
        rollbackTransaction: mock(async () => {}),
        isInTransaction: mock(() => session.open),
        queryInTransaction: mock(async () => resultOf(1)),
      },
      extra,
    );
    return { provider, session };
  }

  test("a begin whose checkout failed answers not-sent, and holds no transaction", async () => {
    const refused = new ConnectionError("connect ECONNREFUSED 127.0.0.1:5432", "postgres");
    const { provider, session } = transactionProvider({
      // The provider takes its connection through `checkoutPhase` before it sends BEGIN, as the pooled providers do.
      beginTransaction: mock(() =>
        checkoutPhase(
          () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
          () => refused,
        ),
      ),
    });

    const outcome = await beginInTransaction(provider, false, {
      signal: new AbortController().signal,
      route: "host-rules",
    });

    expect(outcome.kind).toBe("failed");
    const caught = (outcome as { error: unknown }).error;
    expect(caught).toBe(refused);
    expect(databaseErrorBody(caught)?.body).toMatchObject({
      code: "CONNECTION_ERROR",
      statusCode: 503,
      kind: "connection",
      outcome: "not-sent",
    });
    expect(session.open).toBe(false);
  });

  test("a socket lost mid-statement inside a transaction answers CONNECTION_ERROR with outcome unknown", async () => {
    const lost = new ConnectionError("Connection terminated unexpectedly", "postgres");
    const { provider, session } = transactionProvider({
      queryInTransaction: mock(async () => {
        throw lost;
      }),
    });
    session.open = true;

    const outcome = await runInTransaction(
      provider,
      { statement: "UPDATE t SET n = 1", options: {}, scrub },
      { signal: new AbortController().signal, route: "host-rules" },
    );

    expect(outcome).toEqual({ kind: "failed", error: lost, sessionState: "in-transaction" });
    const caught = (outcome as { error: unknown }).error;
    expect(caught).toBe(lost);
    expect(databaseErrorBody(caught)?.body).toMatchObject({
      code: "CONNECTION_ERROR",
      statusCode: 503,
      outcome: "unknown",
    });
    expect(callsOf((provider as DatabaseProvider & { isInTransaction: unknown }).isInTransaction)).toHaveLength(1);
  });
});
