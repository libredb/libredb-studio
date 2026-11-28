/**
 * The transaction facade (src/lib/api/editor-transaction.ts; docs/providers/CONTRACT.md, clauses C-58 and C-59): each
 * transaction call of `POST /api/db/transaction` runs on a console target's session, the legacy bridge's or a provider
 * package's own, through the host core under a deadline the host owns and the caller's signal, answers an outcome the
 * route acts on, and reads the session state at once after a provider's failure, never a state the facade kept.
 *
 * The real host core is installed for the file; a case that needs a deadline reached in process installs a core of its
 * own around the real one and restores it. Every double signals when the call reaches it, and no assertion follows a
 * timer. `editor-transaction-bounds.test.ts` holds the real short deadlines in a bounded Node child.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import {
  CLEANUP_DEADLINE_MS,
  type CallContext,
  envReader,
  rowsSource,
  type TransactionAnswer,
} from "@libredb/provider-sdk/calls";
import type { SessionState } from "@libredb/provider-sdk/errors";
import type { Calls } from "@libredb/provider-sdk/manifest";
import { EXECUTE_SLACK_MS, executeDeadline, runEditorQuery } from "@/lib/api/editor-query";
import {
  beginInTransaction,
  CREDENTIAL_CHANGE_ROLLBACK_MS,
  endTransaction,
  inTransactionAnswer,
  readTransactionState,
  rollBackAfterCredentialChange,
  runInTransaction,
  transactionOffered,
  type UnansweredCall,
} from "@/lib/api/editor-transaction";
import { entryConsoleTarget, providerConsoleTarget } from "@/lib/api/session-target";
import type { CachedSession } from "@/lib/db/factory";
import type { EngineConnection } from "@/lib/db/server-catalog";
import { errorOutcome } from "@/lib/db/error-record";
import {
  QueryCancelledError,
  QueryError,
  StudioByteBudgetRefusal,
  StudioTimeoutRefusal,
  waitedSeconds,
} from "@/lib/db/errors";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import type { DatabaseProvider, PreparedQuery, QueryPrepareOptions } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX } from "@/lib/provider-host/access";
import type { ConsoleSession } from "@/lib/provider-host/core/console";
import type { HostCore } from "@/lib/provider-host/core/host-core";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const ROUTE = "transaction-test";
const MIB = 1_048_576;
const marker = (): string => crypto.randomUUID();

/** The limiter's rule as a SQL provider applies it: a bound of ours, unless the text carries its own LIMIT. */
function limiter(sql: string, options: QueryPrepareOptions = {}): PreparedQuery {
  const limit = options.limit ?? 500;
  const offset = options.offset ?? 0;
  if (options.unlimited === true || /\blimit\b/i.test(sql)) return { query: sql, wasLimited: false, limit, offset };
  return { query: `${sql} LIMIT ${limit} OFFSET ${offset}`, wasLimited: true, limit, offset };
}

const resultOf = (rows: Record<string, unknown>[]): QueryResult => ({
  rows,
  fields: ["n"],
  rowCount: rows.length,
  executionTime: 3,
});

const connectionWith = (fields: Partial<DatabaseConnection> = {}) =>
  ({
    id: "c1",
    name: "Prod",
    type: "postgres",
    host: "db.internal",
    createdAt: new Date(0),
    ...fields,
  }) as DatabaseConnection;

const scrub = providerTextScrub(connectionWith(), "any");

/** The mock behind a fake's method, read back for its recorded calls. */
const callsOf = (fn: unknown) => (fn as ReturnType<typeof mock>).mock.calls;
/** One turn of the event loop: what a promise already settled has run its reactions by. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A transaction provider over a session whose state the test sets through `open`: a begin opens it, a COMMIT or
 * ROLLBACK closes it, `isInTransaction` reads it. `queryTimeout` sets the statement timeout the deadlines read.
 */
function transactional(queryTimeout?: number) {
  const fx = {
    open: false,
    provider: undefined as unknown as DatabaseProvider &
      Record<
        "beginTransaction" | "commitTransaction" | "rollbackTransaction" | "isInTransaction" | "queryInTransaction",
        ReturnType<typeof mock>
      >,
  };
  fx.provider = Object.assign(createMockProvider({ config: connectionWith({ queryTimeout }) }), {
    prepareQuery: mock(limiter),
    beginTransaction: mock(async (): Promise<{ stateReported: boolean } | undefined> => {
      fx.open = true;
      return undefined;
    }),
    commitTransaction: mock(async () => {
      fx.open = false;
    }),
    rollbackTransaction: mock(async () => {
      fx.open = false;
    }),
    isInTransaction: mock(() => fx.open),
    queryInTransaction: mock(async () => resultOf([{ n: 1 }])),
  });
  return fx;
}

const callerOf = (signal: AbortSignal = new AbortController().signal) => ({ signal, route: ROUTE });

/** A held promise and a signal that the call reached it. */
function held<T>() {
  const answer = Promise.withResolvers<T>();
  const reached = Promise.withResolvers<void>();
  return {
    answer,
    reached: reached.promise,
    call: () => {
      reached.resolve();
      return answer.promise;
    },
  };
}

/** Runs `body` with `core` installed in place of the real one, then puts the real one back. */
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

const TIMEOUT_REASON = () => new DOMException("The call's deadline has passed.", "TimeoutError");

describe("the transaction facade's calls", () => {
  test("each transaction call's deadline is the statement timeout plus ten seconds, and a state read's the cleanup deadline", async () => {
    const fx = transactional(2_000);
    const now = Date.now();
    const deadlines: [string, number][] = [];
    await withCore(
      (real) => ({
        ...real,
        executeCall: (session, request, ctx, limits, ports) => {
          deadlines.push(["statement", ctx.deadline]);
          return real.executeCall(session, request, ctx, limits, ports);
        },
        transactionCall: (session, request, ctx: CallContext, ports) => {
          deadlines.push([request.action, ctx.deadline]);
          return real.transactionCall(session, request, ctx, ports);
        },
      }),
      async () => {
        await beginInTransaction(providerConsoleTarget(fx.provider), false, callerOf(), now);
        await runInTransaction(
          providerConsoleTarget(fx.provider),
          { statement: "SELECT n FROM t", options: {}, scrub },
          callerOf(),
          now,
        );
        await endTransaction(providerConsoleTarget(fx.provider), "commit", callerOf(), now);
        await endTransaction(providerConsoleTarget(fx.provider), "rollback", callerOf(), now);
        await readTransactionState(providerConsoleTarget(fx.provider), callerOf(), now);
      },
    );

    const execute = executeDeadline(fx.provider, now);
    expect(execute).toBe(now + 2_000 + EXECUTE_SLACK_MS);
    expect(deadlines).toEqual([
      ["begin", execute],
      ["statement", execute],
      ["commit", execute],
      ["rollback", execute],
      ["state", now + CLEANUP_DEADLINE_MS],
    ]);
  });

  test("a begin answers the session state and what the server reported", async () => {
    const fx = transactional();
    fx.provider.beginTransaction.mockImplementation(async () => {
      fx.open = true;
      return { stateReported: false };
    });
    const silent = transactional();

    const reported = await beginInTransaction(providerConsoleTarget(fx.provider), true, callerOf());
    const plain = await beginInTransaction(providerConsoleTarget(silent.provider), false, callerOf());

    expect(reported).toEqual({ kind: "answered", sessionState: "in-transaction", stateReported: false });
    expect(plain).toEqual({ kind: "answered", sessionState: "in-transaction" });
    expect(callsOf(fx.provider.beginTransaction)).toEqual([[{ requireReportedState: true }]]);
    expect(callsOf(silent.provider.beginTransaction)).toEqual([[{ requireReportedState: false }]]);
  });

  test("a begin past its deadline is refused before the provider is called, not-sent", async () => {
    const fx = transactional(-EXECUTE_SLACK_MS - 60_000);

    const outcome = await beginInTransaction(providerConsoleTarget(fx.provider), false, callerOf());

    expect(outcome.kind).toBe("not-sent");
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(StudioTimeoutRefusal);
    expect(errorOutcome(error)).toBe("not-sent");
    expect(callsOf(fx.provider.beginTransaction)).toHaveLength(0);
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(0);
  });

  test("a COMMIT the caller leaves answers QueryCancelledError outcome unknown and an unknown state, with no state read", async () => {
    const fx = transactional();
    fx.open = true;
    const commit = held<void>();
    fx.provider.commitTransaction.mockImplementation(commit.call);
    const controller = new AbortController();

    const running = endTransaction(providerConsoleTarget(fx.provider), "commit", callerOf(controller.signal));
    await commit.reached;
    controller.abort();
    const outcome = await running;

    expect(outcome.kind).toBe("unanswered");
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(error)).toBe("unknown");
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(0);
    // The COMMIT Studio stopped waiting for still runs: its outcome settles only once the COMMIT itself does.
    let settled = false;
    const watched = (outcome as UnansweredCall).settled.then(() => {
      settled = true;
    });
    await turn();
    expect(settled).toBe(false);
    commit.answer.resolve();
    await watched;
    expect(settled).toBe(true);
  });

  test("a BEGIN, COMMIT or ROLLBACK past its deadline answers StudioTimeoutRefusal naming it, outcome unknown, state unknown", async () => {
    const queryTimeout = 2_000;
    const fx = transactional(queryTimeout);
    const waited = `${waitedSeconds(queryTimeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer`;

    const outcomes = await withCore(
      (real) => ({
        ...real,
        transactionCall: async () => ({ kind: "stopped", reason: TIMEOUT_REASON(), settled: Promise.resolve() }),
      }),
      async () => [
        await beginInTransaction(providerConsoleTarget(fx.provider), false, callerOf()),
        await endTransaction(providerConsoleTarget(fx.provider), "commit", callerOf()),
        await endTransaction(providerConsoleTarget(fx.provider), "rollback", callerOf()),
      ],
    );

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["unanswered", "unanswered", "unanswered"]);
    const errors = outcomes.map((outcome) => (outcome as { error: unknown }).error);
    for (const error of errors) {
      expect(error).toBeInstanceOf(StudioTimeoutRefusal);
      expect(errorOutcome(error)).toBe("unknown");
    }
    expect(errors.map((error) => (error as Error).message)).toEqual([
      `The BEGIN did not answer within the statement timeout of ${waited}, so Studio stopped waiting for it, and the transaction may be open.`,
      `The COMMIT did not answer within the statement timeout of ${waited}, so Studio stopped waiting for it, and the transaction may have been committed or rolled back.`,
      `The ROLLBACK did not answer within the statement timeout of ${waited}, so Studio stopped waiting for it, and the transaction may still be open.`,
    ]);
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(0);
  });

  test("a COMMIT or ROLLBACK the provider fails answers its error by reference and the state read at once after it", async () => {
    const commitFailure = new QueryError(marker(), "postgres");
    const rollbackFailure = new Error(marker());
    const committing = transactional();
    committing.open = true;
    committing.provider.commitTransaction.mockImplementation(async () => {
      // PostgreSQL ends a transaction whose COMMIT failed.
      committing.open = false;
      throw commitFailure;
    });
    const rollingBack = transactional();
    rollingBack.open = true;
    rollingBack.provider.rollbackTransaction.mockImplementation(async () => {
      throw rollbackFailure;
    });
    const beginFailure = new Error(marker());
    const beginning = transactional();
    beginning.provider.beginTransaction.mockImplementation(async () => {
      throw beginFailure;
    });

    const commit = await endTransaction(providerConsoleTarget(committing.provider), "commit", callerOf());
    const rollback = await endTransaction(providerConsoleTarget(rollingBack.provider), "rollback", callerOf());
    const begin = await beginInTransaction(providerConsoleTarget(beginning.provider), false, callerOf());

    expect(commit).toEqual({ kind: "failed", error: commitFailure, sessionState: "not-in-transaction" });
    expect((commit as { error: unknown }).error).toBe(commitFailure);
    expect(rollback).toEqual({ kind: "failed", error: rollbackFailure, sessionState: "in-transaction" });
    expect((rollback as { error: unknown }).error).toBe(rollbackFailure);
    expect(begin).toEqual({ kind: "failed", error: beginFailure });
    expect((begin as { error: unknown }).error).toBe(beginFailure);
    expect(callsOf(beginning.provider.isInTransaction)).toHaveLength(0);
  });

  test("a state read after a failure that is stopped or fails answers unknown, and a failing read is logged by kind and code", async () => {
    const secret = marker();
    const stoppedRead = transactional();
    stoppedRead.provider.commitTransaction.mockImplementation(async () => {
      throw new Error(marker());
    });
    const failingRead = transactional();
    failingRead.provider.commitTransaction.mockImplementation(async () => {
      throw new Error(marker());
    });
    failingRead.provider.isInTransaction.mockImplementation(() => {
      throw new QueryError(`server closed the connection ${secret}`, "postgres");
    });
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    try {
      const stopped = await withCore(
        (real) => ({
          ...real,
          transactionCall: async (session, request, ctx, ports) =>
            request.action === "state"
              ? { kind: "stopped", reason: TIMEOUT_REASON(), settled: Promise.resolve() }
              : real.transactionCall(session, request, ctx, ports),
        }),
        () => endTransaction(providerConsoleTarget(stoppedRead.provider), "commit", callerOf()),
      );
      const failed = await endTransaction(providerConsoleTarget(failingRead.provider), "commit", callerOf());

      expect(stopped.kind).toBe("failed");
      expect((stopped as { sessionState: unknown }).sessionState).toBe("unknown");
      expect(failed.kind).toBe("failed");
      expect((failed as { sessionState: unknown }).sessionState).toBe("unknown");
      expect(warned).toEqual([
        [
          `The transaction state read did not answer within ${waitedSeconds(CLEANUP_DEADLINE_MS)}, so Studio stopped waiting for it.`,
          { route: ROUTE, kind: "studio-timeout-refusal", code: "TIMEOUT_ERROR" },
        ],
        [
          "A transaction state read failed, so the state is unknown",
          { route: ROUTE, kind: "query", code: "QUERY_ERROR" },
        ],
      ]);
      expect(JSON.stringify(warned)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("a statement inside the transaction answers its page as runEditorQuery does, with the session state after it", async () => {
    const mebibyte = "x".repeat(MIB);
    const bigRows = Array.from({ length: 40 }, () => ({ n: mebibyte }));
    const fx = transactional();
    fx.open = true;
    fx.provider.queryInTransaction.mockImplementation(async () => resultOf(bigRows));
    const plain = Object.assign(createMockProvider({ config: connectionWith() }), {
      prepareQuery: mock(limiter),
      query: mock(async () => resultOf(bigRows)),
    });
    const value = marker();

    const outcome = await runInTransaction(
      providerConsoleTarget(fx.provider),
      { statement: "SELECT n FROM t", params: [value], options: { limit: 100 }, scrub },
      callerOf(),
    );
    const editor = await runEditorQuery(providerConsoleTarget(plain), {
      statement: "SELECT n FROM t",
      options: { limit: 100 },
      signal: new AbortController().signal,
      route: ROUTE,
      scrub,
    });

    expect(outcome.kind).toBe("answered");
    const answered = outcome as { body: unknown; sessionState: unknown };
    expect(answered.body).toEqual(editor.body);
    expect(answered.sessionState).toBe("in-transaction");
    expect(editor.body.pagination.hasMore).toBe(true);
    expect(callsOf(fx.provider.queryInTransaction)).toEqual([["SELECT n FROM t LIMIT 101 OFFSET 0", [value]]]);
  });

  test("a statement inside the transaction whose caller leaves answers a stop, state unknown, and its later failure is logged once", async () => {
    const fx = transactional();
    fx.open = true;
    const statement = held<QueryResult>();
    fx.provider.queryInTransaction.mockImplementation(statement.call);
    const logged = Promise.withResolvers<void>();
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
      logged.resolve();
    });
    try {
      const controller = new AbortController();
      const running = runInTransaction(
        providerConsoleTarget(fx.provider),
        { statement: "UPDATE t SET n = 1", options: {}, scrub },
        callerOf(controller.signal),
      );
      await statement.reached;
      controller.abort();
      const outcome = await running;
      statement.answer.reject(new QueryError(marker(), "postgres"));
      await logged.promise;

      expect(outcome.kind).toBe("unanswered");
      expect((outcome as { error: unknown }).error).toBeInstanceOf(QueryCancelledError);
      expect(errorOutcome((outcome as { error: unknown }).error)).toBe("unknown");
      expect(callsOf(fx.provider.isInTransaction)).toHaveLength(0);
      expect(warned).toEqual([
        [
          "A statement Studio stopped waiting for failed afterwards",
          { route: ROUTE, kind: "query", code: "QUERY_ERROR" },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a statement inside the transaction the provider fails or the host refuses answers its error, not-sent before the call", async () => {
    const failure = new QueryError(marker(), "postgres");
    const fx = transactional();
    fx.open = true;
    fx.provider.queryInTransaction.mockImplementation(async () => {
      fx.open = false;
      throw failure;
    });
    const late = transactional(-EXECUTE_SLACK_MS - 60_000);
    const huge = transactional();
    huge.provider.queryInTransaction.mockImplementation(async () => resultOf([{ n: "x".repeat(33 * MIB) }]));

    const failed = await runInTransaction(
      providerConsoleTarget(fx.provider),
      { statement: "UPDATE t SET n = 1", options: {}, scrub },
      callerOf(),
    );
    const notSent = await runInTransaction(
      providerConsoleTarget(late.provider),
      { statement: "SELECT 1", options: {}, scrub },
      callerOf(),
    );
    const refused = await runInTransaction(
      providerConsoleTarget(huge.provider),
      { statement: "SELECT n FROM t LIMIT 5", options: {}, scrub },
      callerOf(),
    );

    expect(failed).toEqual({ kind: "failed", error: failure, sessionState: "not-in-transaction" });
    expect(notSent.kind).toBe("not-sent");
    expect(errorOutcome((notSent as { error: unknown }).error)).toBe("not-sent");
    expect(callsOf(late.provider.queryInTransaction)).toHaveLength(0);
    expect(refused.kind).toBe("unanswered");
    expect((refused as { error: unknown }).error).toBeInstanceOf(StudioByteBudgetRefusal);
    // The host could not read what the statement answered, so the statement has settled already.
    expect((refused as UnansweredCall).settled).toBeInstanceOf(Promise);
    expect(await (refused as UnansweredCall).settled).toBeUndefined();
  });

  test("a state read answers the session's state, and a stopped read answers unknown", async () => {
    const fx = transactional();
    fx.open = true;
    const left = new AbortController();
    left.abort();

    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    let open: unknown;
    let closed: unknown;
    let refused: unknown;
    let stopped: unknown;
    try {
      open = await readTransactionState(providerConsoleTarget(fx.provider), callerOf());
      fx.open = false;
      closed = await readTransactionState(providerConsoleTarget(fx.provider), callerOf());
      refused = await readTransactionState(providerConsoleTarget(fx.provider), callerOf(left.signal));
      stopped = await withCore(
        (real) => ({
          ...real,
          transactionCall: async () => ({ kind: "stopped", reason: TIMEOUT_REASON(), settled: Promise.resolve() }),
        }),
        () => readTransactionState(providerConsoleTarget(fx.provider), callerOf()),
      );
    } finally {
      warn.mockRestore();
    }

    expect([open, closed, refused, stopped]).toEqual(["in-transaction", "not-in-transaction", "unknown", "unknown"]);
    expect(callsOf(fx.provider.isInTransaction)).toHaveLength(2);
  });

  test("a state read whose provider throws, or whose answer the host cannot read, raises that error", async () => {
    const thrown = new Error(marker());
    const fx = transactional();
    fx.provider.isInTransaction.mockImplementation(() => {
      throw thrown;
    });

    const caught = await readTransactionState(providerConsoleTarget(fx.provider), callerOf()).catch(
      (error: unknown) => error,
    );
    const defect = await withCore(
      (real) => ({
        ...real,
        transactionCall: async () => ({
          kind: "refused",
          called: true,
          refusals: [{ rule: "transaction-answer-unreadable", pointer: "/sessionState" }],
        }),
      }),
      () =>
        readTransactionState(providerConsoleTarget(transactional().provider), callerOf()).catch(
          (error: unknown) => error,
        ),
    );

    expect(caught).toBe(thrown);
    expect((defect as Error).message.startsWith(HOST_DEFECT_PREFIX)).toBe(true);
  });

  test("an unknown state is answered as inTransaction null, never false", () => {
    expect(inTransactionAnswer("in-transaction")).toBe(true);
    expect(inTransactionAnswer("not-in-transaction")).toBe(false);
    expect(inTransactionAnswer("unknown")).toBeNull();
  });
});

describe("the rollback after a credential change", () => {
  test("a rollback after a credential change is confirmed when it answered, and none is sent to a session with no transaction", async () => {
    const open = transactional();
    open.open = true;
    const closed = transactional();

    const rolledBack = await rollBackAfterCredentialChange(providerConsoleTarget(open.provider), ROUTE);
    const noneOpen = await rollBackAfterCredentialChange(providerConsoleTarget(closed.provider), ROUTE);
    const unknownState = transactional();
    unknownState.open = true;
    const afterUnknown = await withCore(
      (real) => ({
        ...real,
        transactionCall: async (session, request, ctx, ports) =>
          request.action === "state"
            ? { kind: "answered", sessionState: "unknown" }
            : real.transactionCall(session, request, ctx, ports),
      }),
      () => rollBackAfterCredentialChange(providerConsoleTarget(unknownState.provider), ROUTE),
    );

    expect(rolledBack).toEqual({ kind: "rolled-back" });
    expect(callsOf(open.provider.rollbackTransaction)).toHaveLength(1);
    expect(noneOpen).toEqual({ kind: "none-open" });
    expect(callsOf(closed.provider.rollbackTransaction)).toHaveLength(0);
    // A state the session cannot tell is never read as closed: the rollback is sent.
    expect(afterUnknown).toEqual({ kind: "rolled-back" });
    expect(callsOf(unknownState.provider.rollbackTransaction)).toHaveLength(1);
  });

  test("a rollback after a credential change that fails is unconfirmed with its error", async () => {
    const thrown = new Error(marker());
    const failing = transactional();
    failing.open = true;
    failing.provider.rollbackTransaction.mockImplementation(async () => {
      throw thrown;
    });
    const readFailure = new Error(marker());
    const unreadable = transactional();
    unreadable.provider.isInTransaction.mockImplementation(() => {
      throw readFailure;
    });
    const stopped = transactional();
    stopped.open = true;

    const failed = await rollBackAfterCredentialChange(providerConsoleTarget(failing.provider), ROUTE);
    const notRead = await rollBackAfterCredentialChange(providerConsoleTarget(unreadable.provider), ROUTE);
    const cut = await withCore(
      (real) => ({
        ...real,
        transactionCall: async (session, request, ctx, ports) =>
          request.action === "state"
            ? real.transactionCall(session, request, ctx, ports)
            : { kind: "stopped", reason: TIMEOUT_REASON(), settled: Promise.resolve() },
      }),
      () => rollBackAfterCredentialChange(providerConsoleTarget(stopped.provider), ROUTE),
    );
    const late = await rollBackAfterCredentialChange(
      providerConsoleTarget(stopped.provider),
      ROUTE,
      Date.now() - CREDENTIAL_CHANGE_ROLLBACK_MS,
    );

    expect(failed).toEqual({ kind: "unconfirmed", error: thrown });
    expect(notRead).toEqual({ kind: "unconfirmed", error: readFailure });
    expect(cut.kind).toBe("unconfirmed");
    const cutError = (cut as { error: unknown }).error;
    expect(cutError).toBeInstanceOf(StudioTimeoutRefusal);
    expect((cutError as Error).message).toBe(
      "The rollback after a credential change did not answer within 5 seconds, so Studio stopped waiting for it.",
    );
    // An allowance already spent: the state read answers unknown, so the rollback is tried, and refused before the call.
    expect(late.kind).toBe("unconfirmed");
    expect(errorOutcome((late as { error: unknown }).error)).toBe("not-sent");
  });

  test("the rollback after a credential change runs on Studio's own 5 s allowance, never the caller's", async () => {
    const fx = transactional();
    fx.open = true;
    const now = Date.now();
    const seen: { action: string; deadline: number; aborted: boolean }[] = [];

    const outcome = await withCore(
      (real) => ({
        ...real,
        transactionCall: (session, request, ctx, ports) => {
          seen.push({ action: request.action, deadline: ctx.deadline, aborted: ctx.signal.aborted });
          return real.transactionCall(session, request, ctx, ports);
        },
      }),
      () => rollBackAfterCredentialChange(providerConsoleTarget(fx.provider), ROUTE, now),
    );

    expect(CREDENTIAL_CHANGE_ROLLBACK_MS).toBe(5_000);
    expect(outcome).toEqual({ kind: "rolled-back" });
    expect(seen).toEqual([
      { action: "state", deadline: now + 5_000, aborted: false },
      { action: "rollback", deadline: now + 5_000, aborted: false },
    ]);
  });
});

describe("the transaction facade on a provider package's session", () => {
  /** A session's calls: execute honouring `offset`, and the transaction facet. */
  const CALLS: Calls = {
    console: {
      execute: { honours: ["offset"] },
      cancel: "not-offered",
      endScope: "not-offered",
      transaction: "offered",
    },
    objects: { tree: "not-offered", source: "not-offered" },
    maintenance: { run: "not-offered", preview: "not-offered" },
    monitoring: { panel: "not-offered", poolStats: "not-offered" },
  };
  const connection = { id: "p", name: "p", type: "acmetx", queryTimeout: 2_000 } as unknown as EngineConnection;

  /**
   * A provider package's cache entry over a session holding one transaction, whose state its calls set, and the
   * console target of it. Each transaction call and execute is recorded with the entry's running count as the call saw
   * it; `transaction` answers what `hold` gives where set, so a case decides when a call settles.
   */
  function packageTransactional() {
    const fx = {
      state: "not-in-transaction" as SessionState,
      seen: [] as { request: unknown; ctx: CallContext; running: number }[],
      hold: undefined as (() => Promise<TransactionAnswer>) | undefined,
    };
    const env = envReader([], () => undefined);
    const session: ConsoleSession = {
      calls: CALLS,
      readOnlyStatements: false,
      execute: async (request, ctx) => {
        fx.seen.push({ request, ctx, running: entry.running });
        return {
          results: [rowsSource([{ name: "n", type: "int4" }], [[1], [2], [3]], 3)],
          warnings: [],
          executionTimeMs: 5,
          pageApplied: false,
          ...(request.transaction === true ? { sessionState: fx.state } : {}),
        };
      },
      transaction: async (request, ctx) => {
        fx.seen.push({ request, ctx, running: entry.running });
        if (fx.hold !== undefined) return fx.hold();
        if (request.action === "begin") fx.state = "in-transaction";
        if (request.action === "commit" || request.action === "rollback") fx.state = "not-in-transaction";
        return {
          sessionState: fx.state,
          ...(request.action === "begin" && request.requireReportedState === true ? { stateReported: true } : {}),
        };
      },
    };
    const entry = {
      opened: { form: "session", session, env },
      engine: { grants: { ownWords: "scrubbed" } },
      running: 0,
      lastUsed: 0,
    } as unknown as CachedSession;
    return { fx, env, entry, target: entryConsoleTarget(entry, connection) };
  }

  test("transactionOffered answers whether the target's session offers console.transaction, a package's and the bridge's alike", () => {
    expect(transactionOffered(packageTransactional().target)).toBe(true);
    const { entry } = packageTransactional();
    const opened = entry.opened as unknown as { session: ConsoleSession; env: unknown };
    const withdrawn = { console: { ...CALLS.console, transaction: "not-offered" } };
    const bare = {
      ...entry,
      opened: { ...opened, session: { ...opened.session, calls: { ...CALLS, ...withdrawn } } },
    } as unknown as CachedSession;
    expect(transactionOffered(entryConsoleTarget(bare, connection))).toBe(false);

    // A legacy provider's bridged session offers it exactly where the provider holds a transaction session.
    expect(transactionOffered(providerConsoleTarget(transactional().provider))).toBe(true);
    expect(transactionOffered(providerConsoleTarget(createMockProvider()))).toBe(false);
  });

  test("a begin, COMMIT, ROLLBACK and state read on a package entry's console target call the package's transaction with its declared environment, each counted on the entry until it answered", async () => {
    const { fx, env, entry, target } = packageTransactional();

    const begun = await beginInTransaction(target, true, callerOf());
    const state = await readTransactionState(target, callerOf());
    const committed = await endTransaction(target, "commit", callerOf());
    const again = await beginInTransaction(target, false, callerOf());
    const rolledBack = await endTransaction(target, "rollback", callerOf());
    fx.state = "in-transaction";
    const afterCredential = await rollBackAfterCredentialChange(target, ROUTE);

    expect(begun).toEqual({ kind: "answered", sessionState: "in-transaction", stateReported: true });
    expect(state).toBe("in-transaction");
    expect(committed).toEqual({ kind: "answered", sessionState: "not-in-transaction" });
    expect(again).toEqual({ kind: "answered", sessionState: "in-transaction" });
    expect(rolledBack).toEqual({ kind: "answered", sessionState: "not-in-transaction" });
    expect(afterCredential).toEqual({ kind: "rolled-back" });
    expect(fx.seen.map((call) => call.request)).toEqual([
      { action: "begin", requireReportedState: true },
      { action: "state" },
      { action: "commit" },
      { action: "begin" },
      { action: "rollback" },
      { action: "state" },
      { action: "rollback" },
    ]);
    for (const call of fx.seen) {
      expect(call.ctx.env).toBe(env);
      expect(call.running).toBe(1);
    }
    // The deadlines read the connection's own statement timeout.
    expect(fx.seen[0]?.ctx.deadline).toBeLessThanOrEqual(Date.now() + 2_000 + EXECUTE_SLACK_MS);
    expect([entry.running, entry.lastUsed > 0]).toEqual([0, true]);
  });

  test("a statement inside a package's transaction is sent with transaction and answers its page as the query route's package run does, with the session state the execute answered", async () => {
    const { fx, entry, target } = packageTransactional();
    fx.state = "in-transaction";

    const outcome = await runInTransaction(
      target,
      { statement: "SELECT n FROM t", options: { limit: 2 }, scrub },
      callerOf(),
    );
    const editor = await runEditorQuery(target, {
      statement: "SELECT n FROM t",
      options: { limit: 2 },
      signal: new AbortController().signal,
      route: ROUTE,
      scrub,
    });

    expect(outcome.kind).toBe("answered");
    const answered = outcome as { body: unknown; sessionState: unknown };
    expect(answered.sessionState).toBe("in-transaction");
    expect(answered.body).toEqual(editor.body);
    expect(editor.body.pagination.hasMore).toBe(true);
    expect(fx.seen.map((call) => call.request)).toEqual([
      { statement: "SELECT n FROM t", page: { limit: 3, offset: 0 }, transaction: true },
      { statement: "SELECT n FROM t", page: { limit: 3, offset: 0 } },
    ]);
    expect(fx.seen[0]?.running).toBe(1);
    expect(entry.running).toBe(0);
  });

  test("a package transaction call Studio stopped waiting for stays counted on the entry until the call it stopped waiting for settled", async () => {
    const { fx, entry, target } = packageTransactional();
    const commit = held<TransactionAnswer>();
    fx.hold = commit.call;
    const controller = new AbortController();

    const running = endTransaction(target, "commit", callerOf(controller.signal));
    await commit.reached;
    controller.abort();
    const outcome = await running;

    expect(outcome.kind).toBe("unanswered");
    expect((outcome as { error: unknown }).error).toBeInstanceOf(QueryCancelledError);
    expect(entry.running).toBe(1);
    commit.answer.resolve({ sessionState: "not-in-transaction" });
    await (outcome as UnansweredCall).settled;
    await Promise.resolve();
    expect(entry.running).toBe(0);
  });
});
