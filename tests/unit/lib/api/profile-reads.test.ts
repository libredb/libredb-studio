/**
 * The data profile's reads (src/lib/api/profile-reads.ts; docs/providers/CONTRACT.md, clause C-86): each read the
 * profile route composes runs through the host core's console execute on the legacy bridge's composed statement
 * session, exactly as written, and the sample on the bridge's console session asking a page of its own; each read under
 * a deadline of its own, the statement timeout plus the host's slack from that read's start, and the request's signal,
 * answering the accessor's classes when it does not answer.
 *
 * The real host core is installed for the file; a case that needs to see the call installs the recording core around
 * it. A deadline case sets the facade's clock so the deadline is 30 ms out and settles the read with a plain `await`
 * before asserting. `profile-reads-bounds.test.ts` holds a provider that never answers in a bounded Node child. A
 * `process.on("unhandledRejection")` counter must read zero after every abandoned read settled.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EXECUTE_SLACK_MS, executeViews } from "@/lib/api/editor-query";
import { openProfileReads } from "@/lib/api/profile-reads";
import { errorKind, errorOutcome } from "@/lib/db/error-record";
import { QueryCancelledError, StudioByteBudgetRefusal, StudioTimeoutRefusal } from "@/lib/db/errors";
import type { DatabaseProvider, PreparedQuery, QueryPrepareOptions } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, HostCoreBootOrderError, hostCore, installHostCore } from "@/lib/provider-host/instance";
import type { QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { withRecordingHostCore } from "../../../helpers/recording-host-core";

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

const ROUTE = "profile-reads-test";
/** The statement timeout every provider here is built with, so a deadline is known to the millisecond. */
const STATEMENT_TIMEOUT_MS = 1_000;
const marker = (): string => randomUUID();

const resultOf = (rows: Record<string, unknown>[]): QueryResult => ({
  rows,
  fields: Object.keys(rows[0] ?? { n: 1 }),
  rowCount: rows.length,
  executionTime: 2,
});

/** A limiter that honours the limit it is asked for, as a provider's own limiter does. */
const honouredLimit = (statement: string, options?: QueryPrepareOptions): PreparedQuery => ({
  query: `${statement} LIMIT ${options?.limit}`,
  wasLimited: true,
  limit: options?.limit ?? 0,
  offset: 0,
});

/** A provider whose plain query answers what `answer` gives, and whose prepare honours the limit it is asked for. */
function providerOf(answer: () => Promise<QueryResult>) {
  const reached = Promise.withResolvers<void>();
  const query = mock<(...args: unknown[]) => Promise<QueryResult>>(() => {
    reached.resolve();
    return answer();
  });
  const prepareQuery = mock(honouredLimit);
  const base = createMockProvider();
  const provider: DatabaseProvider = Object.assign(base, {
    query,
    prepareQuery,
    config: { ...base.config, queryTimeout: STATEMENT_TIMEOUT_MS },
  });
  return { provider, query, prepareQuery, reached: reached.promise };
}

/** A clock that reads so the deadline of a read starting now falls `ms` from now: negative for one already passed. */
const deadlineIn = (ms: number) => () => Date.now() - (STATEMENT_TIMEOUT_MS + EXECUTE_SLACK_MS) + ms;

/** What `run` threw; a run that does not throw fails the case. */
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("The read was expected to fail, and it answered.");
}

/** Every warning `body` logged. */
async function warningsOf(body: (warned: unknown[][]) => Promise<void>): Promise<unknown[][]> {
  const warned: unknown[][] = [];
  const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
    warned.push(args);
  });
  try {
    await body(warned);
  } finally {
    warn.mockRestore();
  }
  return warned;
}

/** Turns of the event loop until `done` holds, at most `turns`: a settled read's late port runs within a few. */
async function turnsUntil(done: () => boolean, turns = 20): Promise<void> {
  if (turns === 0 || done()) return;
  await new Promise((resolve) => setImmediate(resolve));
  await turnsUntil(done, turns - 1);
}

describe("openProfileReads: the composed reads", () => {
  test("a profile's composed read is one host core execute call on a composed statement session, its statement exactly as written, every row, and a context of its own deadline, the request's signal and env alone", async () => {
    const result = resultOf([{ total: 3 }]);
    const { provider, query, prepareQuery } = providerOf(async () => result);
    const caller = new AbortController();
    const start = Date.now();
    const statement = `SELECT COUNT(*) AS total FROM ${marker()}`;

    const record = await withRecordingHostCore(async (recorded) => {
      const answer = await openProfileReads(provider, caller.signal, ROUTE, () => start).composed(statement);
      expect(answer).toBe(result);
      return recorded;
    });

    expect(query.mock.calls).toEqual([[statement]]);
    expect(prepareQuery).not.toHaveBeenCalled();
    expect(record.executes).toHaveLength(1);
    const [execute] = record.executes;
    expect(execute?.readOnlyStatements).toBe(false);
    expect(execute?.request).toEqual({ statement, page: { unlimited: true } });
    expect(Reflect.ownKeys(execute?.ctx ?? {}).sort()).toEqual(["deadline", "env", "signal"]);
    expect(execute?.ctx.deadline).toBe(start + STATEMENT_TIMEOUT_MS + EXECUTE_SLACK_MS);
    expect(execute?.ctx.signal.aborted).toBe(false);
    caller.abort();
    expect(execute?.ctx.signal.aborted).toBe(true);
  });

  test("each composed read takes a deadline of its own from its start", async () => {
    const { provider } = providerOf(async () => resultOf([{ n: 1 }]));
    const start = Date.now();
    const starts = [start, start + 500];
    const clock = mock(() => starts.shift() as number);

    const record = await withRecordingHostCore(async (recorded) => {
      const reads = openProfileReads(provider, new AbortController().signal, ROUTE, clock);
      expect(clock).not.toHaveBeenCalled();
      await reads.composed("SELECT 1");
      await reads.composed("SELECT 2");
      return recorded;
    });

    expect(record.executes.map((execute) => execute.ctx.deadline)).toEqual([
      start + STATEMENT_TIMEOUT_MS + EXECUTE_SLACK_MS,
      start + 500 + STATEMENT_TIMEOUT_MS + EXECUTE_SLACK_MS,
    ]);
    expect(record.executes[0]?.ctx.signal).not.toBe(record.executes[1]?.ctx.signal);
  });

  test("a composed read answers the provider's result by reference, and its page is released", async () => {
    // Two answers over 1 MiB each wait for the host's large-page slot in turn, so the second answers only once the
    // first released its page; unreleased, it would wait until its deadline, past the test's own timeout.
    const wide = (): QueryResult => resultOf([{ wide: "x".repeat(1_100_000) }, { wide: "y".repeat(1_100_000) }]);
    const first = wide();
    const second = wide();
    const answers = [first, second];
    const { provider } = providerOf(async () => answers.shift() as QueryResult);
    const reads = openProfileReads(provider, new AbortController().signal, ROUTE);

    expect(await reads.composed("SELECT wide FROM t")).toBe(first);
    expect(await reads.composed("SELECT wide FROM t")).toBe(second);
  });

  test("a composed read its deadline stopped answers Studio's timeout refusal naming the statement timeout, and a later failure is logged by kind and code only", async () => {
    const secret = marker();
    const pending = Promise.withResolvers<QueryResult>();
    const { provider } = providerOf(() => pending.promise);
    const caller = new AbortController();

    const warned = await warningsOf(async (seen) => {
      // A plain await of the read, which its real deadline, 30 ms out, ends.
      const stopped = await failure(() =>
        openProfileReads(provider, caller.signal, ROUTE, deadlineIn(30)).composed("SELECT 1"),
      );

      expect(stopped).toBeInstanceOf(StudioTimeoutRefusal);
      expect((stopped as Error).message).toBe(executeViews(provider, caller.signal).view.deadlineSentence);
      expect(errorKind(stopped)).toBe("studio-timeout-refusal");
      expect(errorOutcome(stopped)).toBe("unknown");
      pending.reject(new Error(secret));
      await turnsUntil(() => seen.length > 0);
    });

    expect(warned).toEqual([
      [
        "A statement Studio stopped waiting for failed afterwards",
        { route: ROUTE, kind: "internal", code: "INTERNAL_ERROR" },
      ],
    ]);
    expect(JSON.stringify(warned)).not.toContain(secret);
  });

  test("a composed read whose request leaves answers the cancel at once", async () => {
    const pending = Promise.withResolvers<QueryResult>();
    const { provider, reached } = providerOf(() => pending.promise);
    const caller = new AbortController();

    const read = failure(() => openProfileReads(provider, caller.signal, ROUTE).composed("SELECT 1"));
    await reached;
    caller.abort();
    const cancelled = await read;
    pending.resolve(resultOf([{ n: 1 }]));
    await pending.promise;

    expect(cancelled).toBeInstanceOf(QueryCancelledError);
    expect(errorKind(cancelled)).toBe("cancelled");
    expect(errorOutcome(cancelled)).toBe("unknown");
  });

  test("a composed read after the request left or past its deadline is refused before the call, not-sent, and never reaches the provider", async () => {
    const { provider, query } = providerOf(async () => resultOf([]));
    const left = new AbortController();
    left.abort();
    const caller = new AbortController();

    const cancelled = await failure(() => openProfileReads(provider, left.signal, ROUTE).composed("SELECT 1"));
    const late = await failure(() =>
      openProfileReads(provider, caller.signal, ROUTE, deadlineIn(-1)).composed("SELECT 1"),
    );

    expect(cancelled).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(cancelled)).toBe("not-sent");
    expect(late).toBeInstanceOf(StudioTimeoutRefusal);
    expect((late as Error).message).toBe(executeViews(provider, caller.signal).view.deadlineSentence);
    expect(errorOutcome(late)).toBe("not-sent");
    expect(query).not.toHaveBeenCalled();
  });

  test("a composed read's row larger than one page is refused by the host's page budget", async () => {
    const wide = "x".repeat(33 * 1024 * 1024);
    const { provider } = providerOf(async () => resultOf([{ wide }]));

    const refused = await failure(() =>
      openProfileReads(provider, new AbortController().signal, ROUTE).composed("SELECT wide FROM t"),
    );

    expect(refused).toBeInstanceOf(StudioByteBudgetRefusal);
    expect((refused as Error).message).toMatch(
      /^A row of the result is \d+ bytes, over the 33554432 bytes one page of a result may hold, so Studio answers no page of it\.$/,
    );
    expect(errorOutcome(refused)).toBe("unknown");
  });

  test("a composed read passes the provider's error as the same object", async () => {
    const thrown = new Error(marker());
    const { provider } = providerOf(async () => {
      throw thrown;
    });

    expect(
      await failure(() => openProfileReads(provider, new AbortController().signal, ROUTE).composed("SELECT 1")),
    ).toBe(thrown);
  });

  test("opening the profile's reads before the host core is installed throws by name and calls no provider", () => {
    const { provider, query, prepareQuery } = providerOf(async () => resultOf([]));
    const real = hostCore();
    forgetHostCore();
    let thrown: unknown;
    try {
      openProfileReads(provider, new AbortController().signal, ROUTE);
    } catch (error) {
      thrown = error;
    } finally {
      installHostCore(real, "test");
    }

    expect(thrown).toBeInstanceOf(HostCoreBootOrderError);
    expect(query).not.toHaveBeenCalled();
    expect(prepareQuery).not.toHaveBeenCalled();
  });
});

describe("openProfileReads: the sample", () => {
  test("the sample is one host core execute call on the console session asking a page of the given rows: the provider's own bound one row past it, and at most that many rows answered by reference", async () => {
    const six = Array.from({ length: 6 }, (_, id) => ({ id }));
    const three = six.slice(0, 3);
    const answers = [resultOf(six), resultOf(three)];
    const { provider, query, prepareQuery } = providerOf(async () => answers.shift() as QueryResult);
    const caller = new AbortController();
    const start = Date.now();
    const statement = 'SELECT "id" FROM public.users';

    const { record, rows, few } = await withRecordingHostCore(async (recorded) => {
      const reads = openProfileReads(provider, caller.signal, ROUTE, () => start);
      return { record: recorded, rows: await reads.sample(statement, 5), few: await reads.sample(statement, 5) };
    });

    expect(record.executes).toHaveLength(2);
    const [execute] = record.executes;
    expect(execute?.readOnlyStatements).toBe(false);
    expect(execute?.request).toEqual({ statement, page: { limit: 5, offset: 0 } });
    expect(Reflect.ownKeys(execute?.request ?? {}).sort()).toEqual(["page", "statement"]);
    expect(Reflect.ownKeys(execute?.ctx ?? {}).sort()).toEqual(["deadline", "env", "signal"]);
    expect(execute?.ctx.deadline).toBe(start + STATEMENT_TIMEOUT_MS + EXECUTE_SLACK_MS);
    caller.abort();
    expect(execute?.ctx.signal.aborted).toBe(true);
    expect(prepareQuery.mock.calls.slice(0, 2)).toEqual([
      [statement, { limit: 5 }],
      [statement, { limit: 6, unlimited: false }],
    ]);
    expect(query.mock.calls[0]?.[0]).toBe(`${statement} LIMIT 6`);
    expect(rows).toHaveLength(5);
    rows.forEach((row, index) => expect(row).toBe(six[index] as Record<string, unknown>));
    expect(few).toHaveLength(3);
    few.forEach((row, index) => expect(row).toBe(three[index] as Record<string, unknown>));
  });

  test("a sample its deadline stopped or whose request left answers the accessor's class", async () => {
    const held = [Promise.withResolvers<QueryResult>(), Promise.withResolvers<QueryResult>()];
    const pending = [...held];
    const secondReached = Promise.withResolvers<void>();
    const { provider } = providerOf(() => {
      if (pending.length === 1) secondReached.resolve();
      return (pending.shift() as PromiseWithResolvers<QueryResult>).promise;
    });
    const caller = new AbortController();

    // A plain await of the sample, which its real deadline, 30 ms out, ends.
    const stopped = await failure(() =>
      openProfileReads(provider, caller.signal, ROUTE, deadlineIn(30)).sample("SELECT 1", 5),
    );
    const leaving = new AbortController();
    const read = failure(() => openProfileReads(provider, leaving.signal, ROUTE).sample("SELECT 1", 5));
    await secondReached.promise;
    leaving.abort();
    const cancelled = await read;
    for (const each of held) each.resolve(resultOf([{ n: 1 }]));
    await Promise.all(held.map((each) => each.promise));

    expect(stopped).toBeInstanceOf(StudioTimeoutRefusal);
    expect((stopped as Error).message).toBe(executeViews(provider, caller.signal).view.deadlineSentence);
    expect(errorOutcome(stopped)).toBe("unknown");
    expect(cancelled).toBeInstanceOf(QueryCancelledError);
    expect(errorOutcome(cancelled)).toBe("unknown");
  });
});
