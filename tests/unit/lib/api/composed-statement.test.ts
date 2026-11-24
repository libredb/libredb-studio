/**
 * The composed statement facade (src/lib/api/composed-statement.ts; docs/providers/CONTRACT.md, clause C-80): one
 * statement Studio composed runs through the host core's console execute on the legacy bridge's composed statement
 * session, exactly as composed, under the deadline its call was granted and the drive's caller signal that never
 * aborts, and answers the provider's result by reference or the grant's own time refusal at every wait a stop ends.
 *
 * The real host core is installed for the file; a case that needs to see the call, or a record the real core would
 * answer only at a real deadline, installs a core of its own around the real one and restores it. A deadline case runs
 * a short real grant settled with a plain `await` before asserting. `composed-statement-bounds.test.ts` holds a
 * provider that never answers in a bounded Node child. A `process.on("unhandledRejection")` counter must read zero
 * after every abandoned call settled.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, ExecuteRequest } from "@libredb/provider-sdk/calls";
import { type ComposedStatementCall, runComposedStatement } from "@/lib/api/composed-statement";
import { errorKind, errorOutcome } from "@/lib/db/error-record";
import { StudioByteBudgetRefusal, StudioTimeoutRefusal } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
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

const ROUTE = "composed-statement-test";
const marker = (): string => randomUUID();

const resultOf = (rows: Record<string, unknown>[]): QueryResult => ({
  rows,
  fields: Object.keys(rows[0] ?? { n: 1 }),
  rowCount: rows.length,
  executionTime: 2,
});

/** A provider whose plain query answers what `answer` gives, beside a prepare that is never to be called. */
function providerOf(answer: () => Promise<QueryResult>) {
  const reached = Promise.withResolvers<void>();
  const query = mock<(...args: unknown[]) => Promise<QueryResult>>(() => {
    reached.resolve();
    return answer();
  });
  const provider: DatabaseProvider = Object.assign(createMockProvider({ type: "mssql" }), { query });
  return { provider, query, reached: reached.promise };
}

/** The grant's own time refusal, a `DatabaseError` as the statistics read's is. */
const timeRefusalOf = (ms: number) => () =>
  new StudioTimeoutRefusal("the statistics read did not answer in time", "mssql", ms);

/** One call of the facade, a statement and a grant of its own, each member overridable. */
function callOf(over: Partial<ComposedStatementCall> = {}): ComposedStatementCall & { readonly held: Promise<void>[] } {
  const held: Promise<void>[] = [];
  return {
    statement: `SELECT ${marker()} FROM sys.tables`,
    deadline: Date.now() + 60_000,
    timeRefusal: timeRefusalOf(60_000),
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

describe("runComposedStatement", () => {
  test("a composed statement runs once through one host core execute call on a composed statement session, on a fresh request of its statement and every row and a context of deadline, signal and env alone", async () => {
    const result = resultOf([{ n: 1 }]);
    const { provider, query } = providerOf(async () => result);
    const seen: { request: ExecuteRequest; ctx: CallContext; honours: unknown }[] = [];
    const call = callOf({ deadline: Date.now() + 5_000 });

    await withCore(
      (real) => ({
        ...real,
        executeCall: (session, request, ctx, limits, ports) => {
          seen.push({ request, ctx, honours: session.calls.console.execute.honours });
          return real.executeCall(session, request, ctx, limits, ports);
        },
      }),
      () => runComposedStatement(provider, call),
    );

    expect(query.mock.calls).toEqual([[call.statement]]);
    expect(provider.prepareQuery).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request).toEqual({ statement: call.statement, page: { unlimited: true } });
    expect(seen[0]?.honours).toEqual([]);
    expect(Reflect.ownKeys(seen[0]?.ctx ?? {}).sort()).toEqual(["deadline", "env", "signal"]);
    expect(seen[0]?.ctx.deadline).toBe(call.deadline);
    expect(seen[0]?.ctx.signal.aborted).toBe(false);
    expect(call.held).toEqual([]);
  });

  test("its answer is the provider's result by reference, and its page is released", async () => {
    const result = resultOf([{ n: 1 }, { n: 2 }]);
    const { provider } = providerOf(async () => result);
    // Two answers over 1 MiB each wait for the host's large-page slot in turn, so the second answers only once the
    // first released its page.
    const wide = (): QueryResult => resultOf([{ wide: "x".repeat(1_100_000) }, { wide: "y".repeat(1_100_000) }]);
    const first = wide();
    const second = wide();
    const answers = [first, second];
    const large = providerOf(async () => answers.shift() as QueryResult);

    expect(await runComposedStatement(provider, callOf())).toBe(result);
    expect(await runComposedStatement(large.provider, callOf({ deadline: Date.now() + 2_000 }))).toBe(first);
    expect(await runComposedStatement(large.provider, callOf({ deadline: Date.now() + 2_000 }))).toBe(second);
  });

  test("a composed statement its deadline stopped answers the grant's own time refusal, its settlement handed to the hold, and a later failure is logged by kind and code only", async () => {
    const secret = marker();
    const pending = Promise.withResolvers<QueryResult>();
    const { provider } = providerOf(() => pending.promise);
    const refusal = new StudioTimeoutRefusal("the statistics read did not answer in time", "mssql", 50);
    const call = callOf({ deadline: Date.now() + 50, timeRefusal: () => refusal });
    let settledSeen = false;

    const warned = await warningsOf(async () => {
      // A plain await of the call, which the grant's real deadline ends.
      const stopped = await failure(() => runComposedStatement(provider, call));

      expect(stopped).toBe(refusal);
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

  test("a stop at any wait of the run answers the grant's time refusal", async () => {
    const { provider, query } = providerOf(async () => resultOf([]));
    const reason = new DOMException("The call's deadline has passed.", "TimeoutError");
    const waits = [undefined, "large-page-slot", "page", "other-results"] as const;
    const calls = waits.map(() => callOf({ timeRefusal: timeRefusalOf(1_234) }));
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
      () => Promise.all(calls.map((call) => failure(() => runComposedStatement(provider, call)))),
    );

    expect(pending).toEqual([]);
    for (const error of stopped) {
      expect(error).toBeInstanceOf(StudioTimeoutRefusal);
      expect((error as Error).message).toBe("the statistics read did not answer in time");
      expect(errorOutcome(error)).toBe("unknown");
    }
    expect(calls.map((call) => call.held.length)).toEqual([1, 1, 1, 1]);
    expect(query).not.toHaveBeenCalled();
  });

  test("a composed statement whose deadline passed before its call is refused with the grant's time refusal, not-sent, and never reaches the provider", async () => {
    const { provider, query } = providerOf(async () => resultOf([]));
    const call = callOf({ deadline: Date.now() - 1, timeRefusal: timeRefusalOf(1) });

    const refused = await failure(() => runComposedStatement(provider, call));

    expect(refused).toBeInstanceOf(StudioTimeoutRefusal);
    expect((refused as Error).message).toBe("the statistics read did not answer in time");
    expect(errorKind(refused)).toBe("studio-timeout-refusal");
    expect(errorOutcome(refused)).toBe("not-sent");
    expect(query).not.toHaveBeenCalled();
    expect(call.held).toEqual([]);
  });

  test("a row larger than one page is refused by the host's page budget", async () => {
    const wide = "x".repeat(33 * 1024 * 1024);
    const { provider } = providerOf(async () => resultOf([{ wide }]));

    const refused = await failure(() => runComposedStatement(provider, callOf()));

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

    expect(await failure(() => runComposedStatement(provider, call))).toBe(thrown);
    expect(call.held).toEqual([]);
  });

  test("before the host core is installed it throws by name and calls no provider", () => {
    const { provider, query } = providerOf(async () => resultOf([]));
    const real = hostCore();
    forgetHostCore();
    let thrown: unknown;
    try {
      void runComposedStatement(provider, callOf());
    } catch (error) {
      thrown = error;
    } finally {
      installHostCore(real, "test");
    }

    expect(thrown).toBeInstanceOf(HostCoreBootOrderError);
    expect(query).not.toHaveBeenCalled();
  });
});
