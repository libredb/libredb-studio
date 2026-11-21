import { describe, expect, mock, spyOn, test } from "bun:test";
import path from "node:path";
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import {
  byteBudgetSentence,
  MAX_STATEMENT_TIMEOUT_MS,
  measureResultBytes,
  measureRowBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import { runReadOnlyReading, runReadOnlyStatement } from "@/lib/db/operations/read-only-statement";
import type { DatabaseProvider, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";

/**
 * The one core call of a provider's read-only statement path: core holds the provider's answer to the row, byte and
 * time budget it handed out, with the two exceptions the module docblock names: an estimating plan's rows are held to
 * the byte budget only, and a provider that runs its statement synchronously on the event loop (LibreDB, SQLite
 * without its worker) is not stopped by core's timer.
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");
const MODULE = path.join(ROOT, "src/lib/db/operations/read-only-statement.ts");

const budget: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 10, maxResultBytes: 10_000 };

function answer(rows: Record<string, unknown>[]): QueryResult {
  return { rows, fields: Object.keys(rows[0] ?? {}), rowCount: rows.length, executionTime: 1 };
}

function providerAnswering(queryReadOnly: DatabaseProvider["queryReadOnly"]) {
  const query = mock(async () => answer([]));
  return { provider: { queryReadOnly, query } as unknown as DatabaseProvider, query };
}

/** Settles `promise` as its value or its error, so a refusal is asserted after a plain await. */
function settled<T>(promise: Promise<T>): Promise<T | unknown> {
  return promise.then(
    (value) => value,
    (error: unknown) => error,
  );
}

describe("runReadOnlyStatement", () => {
  test("hands the statement, the budget and the mode to the provider's read-only path, and returns its answer unchanged when it is within the budget", async () => {
    const served = answer([{ id: 1 }]);
    const queryReadOnly = mock(async () => served);
    const { provider } = providerAnswering(queryReadOnly);
    const result = await runReadOnlyStatement(provider, {
      type: "postgres",
      statement: "SELECT 1",
      budget,
      mode: "estimate-plan",
      wait: "statement-timeout",
    });
    expect(result).toBe(served);
    expect(queryReadOnly).toHaveBeenCalledWith("SELECT 1", budget, "estimate-plan");
  });

  test("hands an absent mode to the provider as the third argument, so every caller makes the one call form", async () => {
    const queryReadOnly = mock(async () => answer([]));
    const { provider } = providerAnswering(queryReadOnly);
    await runReadOnlyStatement(provider, { type: "postgres", statement: "SELECT 1", budget, wait: "caller-deadline" });
    expect(queryReadOnly).toHaveBeenCalledWith("SELECT 1", budget, undefined);
  });

  test("refuses an answer with more rows than the budget, in the row sentence every provider uses", async () => {
    const { provider } = providerAnswering(async () => answer([{ id: 1 }, { id: 2 }, { id: 3 }]));
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "postgres",
        statement: "SELECT id FROM t",
        budget: { ...budget, maxResultRows: 2 },
        wait: "statement-timeout",
      }),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toBe(rowBudgetSentence(3, 2));
    expect((error as QueryError).provider).toBe("postgres");
  });

  test("refuses an answer whose rows carry more UTF-8 JSON bytes than the budget, in the byte sentence every provider uses", async () => {
    const rows = [{ text: "a".repeat(60) }, { text: "b".repeat(60) }];
    const { provider } = providerAnswering(async () => answer(rows));
    const first = measureRowBytes(rows[0]);
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "mysql",
        statement: "SELECT text FROM t",
        budget: { ...budget, maxResultBytes: first + 10 },
        wait: "statement-timeout",
      }),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toBe(byteBudgetSentence(first + measureRowBytes(rows[1]), first + 10));
  });

  test("holds an estimating plan to the byte budget only, because a plan's rows are the optimizer's operators, not data rows", async () => {
    const rows = [{ op: "Scan" }, { op: "Sort" }, { op: "Top" }];
    const served = answer(rows);
    const { provider } = providerAnswering(async () => served);
    const result = await runReadOnlyStatement(provider, {
      type: "mssql",
      statement: "SELECT TOP 10 * FROM v",
      budget: { ...budget, maxResultRows: 2 },
      mode: "estimate-plan",
      wait: "statement-timeout",
    });
    expect(result).toBe(served);
    const first = measureRowBytes(rows[0]);
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "mssql",
        statement: "SELECT TOP 10 * FROM v",
        budget: { ...budget, maxResultRows: 2, maxResultBytes: first },
        mode: "estimate-plan",
        wait: "statement-timeout",
      }),
    );
    expect((error as QueryError).message).toBe(byteBudgetSentence(first + measureRowBytes(rows[1]), first));
  });

  test("holds an executed statement's answer to the row budget", async () => {
    const { provider } = providerAnswering(async () => answer([{ id: 1 }, { id: 2 }, { id: 3 }]));
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "mssql",
        statement: "SELECT id FROM t",
        budget: { ...budget, maxResultRows: 2 },
        mode: "execute",
        wait: "statement-timeout",
      }),
    );
    expect((error as QueryError).message).toBe(rowBudgetSentence(3, 2));
  });

  test("stops summing bytes at the row that carries the sum past the budget, and never serialises a later row", async () => {
    const later = mock(() => {
      throw new Error("a row after the crossing row was serialised");
    });
    const rows: Record<string, unknown>[] = [{ text: "a".repeat(60) }, { text: "b".repeat(60) }, { toJSON: later }];
    const { provider } = providerAnswering(async () => answer(rows));
    const first = measureRowBytes(rows[0]);
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "postgres",
        statement: "SELECT text FROM t",
        budget: { ...budget, maxResultBytes: first + 10 },
        wait: "statement-timeout",
      }),
    );
    expect((error as QueryError).message).toBe(byteBudgetSentence(first + measureRowBytes(rows[1]), first + 10));
    expect(later).not.toHaveBeenCalled();
  });

  test("counts UTF-8 bytes, so a row that a UTF-16 length would admit is refused", async () => {
    const row = { text: "é".repeat(40) };
    const utf16 = JSON.stringify(row).length;
    const utf8 = measureRowBytes(row);
    expect(utf8).toBeGreaterThan(utf16);
    const { provider } = providerAnswering(async () => answer([row]));
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "sqlite",
        statement: "SELECT text FROM t",
        budget: { ...budget, maxResultBytes: utf16 },
        wait: "statement-timeout",
      }),
    );
    expect((error as QueryError).message).toBe(byteBudgetSentence(utf8, utf16));
  });

  test("counts a bigint cell as its decimal text", async () => {
    const row = { n: BigInt("12345678901234567890") };
    const bytes = Buffer.byteLength(JSON.stringify({ n: "12345678901234567890" }));
    const { provider } = providerAnswering(async () => answer([row]));
    const admitted = await runReadOnlyStatement(provider, {
      type: "sqlite",
      statement: "SELECT n FROM t",
      budget: { ...budget, maxResultBytes: bytes },
      wait: "statement-timeout",
    });
    expect(admitted.rows).toEqual([row]);
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "sqlite",
        statement: "SELECT n FROM t",
        budget: { ...budget, maxResultBytes: bytes - 1 },
        wait: "statement-timeout",
      }),
    );
    expect((error as QueryError).message).toBe(byteBudgetSentence(bytes, bytes - 1));
  });

  test("admits an answer at exactly the row and byte budget", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const bytes = rows.reduce((sum, row) => sum + measureRowBytes(row), 0);
    const served = answer(rows);
    const { provider } = providerAnswering(async () => served);
    const result = await runReadOnlyStatement(provider, {
      type: "postgres",
      statement: "SELECT id FROM t",
      budget: { ...budget, maxResultRows: 2, maxResultBytes: bytes },
      wait: "statement-timeout",
    });
    expect(result).toBe(served);
  });

  test("never refuses an answer that a provider measuring the whole result as one JSON array admitted", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const served = answer(rows);
    const { provider } = providerAnswering(async () => served);
    const result = await runReadOnlyStatement(provider, {
      type: "postgres",
      statement: "SELECT id FROM t",
      budget: { ...budget, maxResultBytes: measureResultBytes(rows) },
      wait: "statement-timeout",
    });
    expect(result).toBe(served);
  });

  test("refuses an answer that does not arrive within the statement timeout, in the time sentence", async () => {
    const { provider } = providerAnswering(() => new Promise<QueryResult>(() => {}));
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "duckdb",
        statement: "SELECT 1",
        budget: { ...budget, statementTimeoutMs: 5 },
        wait: "statement-timeout",
      }),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message.startsWith(TIME_BUDGET_PREFIX)).toBe(true);
    expect((error as QueryError).message).toContain("5ms");
    expect((error as QueryError).provider).toBe("duckdb");
  });

  test("hands the provider's call to the caller's hold as soon as it is made, so a call it stopped waiting for stays held", async () => {
    const call = new Promise<QueryResult>(() => {});
    const { provider } = providerAnswering(() => call);
    const holdUntilSettled = mock<(call: PromiseLike<unknown>) => void>(() => {});
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "duckdb",
        statement: "SELECT 1",
        budget: { ...budget, statementTimeoutMs: 5 },
        wait: "statement-timeout",
        holdUntilSettled,
      }),
    );
    expect((error as QueryError).message.startsWith(TIME_BUDGET_PREFIX)).toBe(true);
    expect(holdUntilSettled).toHaveBeenCalledTimes(1);
    expect(holdUntilSettled.mock.calls[0][0]).toBe(call);
  });

  test("keeps a rejection handler on a call it stopped waiting for, so its late failure is no unhandled rejection", async () => {
    let reject: (error: Error) => void = () => {};
    const late = new Promise<QueryResult>((_resolve, rejectLate) => {
      reject = rejectLate;
    });
    const { provider } = providerAnswering(() => late);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const error = await settled(
        runReadOnlyStatement(provider, {
          type: "duckdb",
          statement: "SELECT 1",
          budget: { ...budget, statementTimeoutMs: 1 },
          wait: "statement-timeout",
        }),
      );
      expect((error as QueryError).message.startsWith(TIME_BUDGET_PREFIX)).toBe(true);
      reject(new Error("the engine gave up later"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      warned.mockRestore();
      process.off("unhandledRejection", listener);
    }
  });

  test("logs, without the statement or the error's text, how a call it stopped waiting for settled later", async () => {
    let reject: (error: Error) => void = () => {};
    const late = new Promise<QueryResult>((_resolve, rejectLate) => {
      reject = rejectLate;
    });
    const { provider } = providerAnswering(() => late);
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const statement = `SELECT ${crypto.randomUUID()}`;
      await settled(
        runReadOnlyStatement(provider, {
          type: "postgres",
          statement,
          budget: { ...budget, statementTimeoutMs: 1 },
          wait: "statement-timeout",
        }),
      );
      expect(warned).not.toHaveBeenCalled();
      const detail = crypto.randomUUID();
      const failure = new Error(`connect ETIMEDOUT ${detail}`);
      failure.name = "ConnectionError";
      reject(failure);
      await late.catch(() => {});
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warned).toHaveBeenCalledTimes(1);
      const [message, context] = warned.mock.calls[0];
      expect(message).toBe("A read-only call settled after Studio stopped waiting for it");
      expect(context).toMatchObject({ provider: "postgres", outcome: "failed", errorClass: "ConnectionError" });
      expect(typeof context?.settledAfterMs).toBe("number");
      expect(JSON.stringify(warned.mock.calls)).not.toContain(detail);
      expect(JSON.stringify(warned.mock.calls)).not.toContain(statement);
    } finally {
      warned.mockRestore();
    }
  });

  test("logs a call it stopped waiting for that answered later as answered, with no error class", async () => {
    let resolve: (result: QueryResult) => void = () => {};
    const late = new Promise<QueryResult>((resolveLate) => {
      resolve = resolveLate;
    });
    const { provider } = providerAnswering(() => late);
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await settled(
        runReadOnlyStatement(provider, {
          type: "duckdb",
          statement: "SELECT 1",
          budget: { ...budget, statementTimeoutMs: 1 },
          wait: "statement-timeout",
        }),
      );
      resolve(answer([{ id: 1 }]));
      await late;
      await new Promise<void>((settle) => setImmediate(settle));
      expect(warned).toHaveBeenCalledTimes(1);
      const context = warned.mock.calls[0][1];
      expect(context).toMatchObject({ provider: "duckdb", outcome: "answered" });
      expect(context).not.toHaveProperty("errorClass");
    } finally {
      warned.mockRestore();
    }
  });

  test("logs nothing for a call that answered within the timeout", async () => {
    const { provider } = providerAnswering(async () => answer([{ id: 1 }]));
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await runReadOnlyStatement(provider, {
        type: "postgres",
        statement: "SELECT 1",
        budget,
        wait: "statement-timeout",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  test("clears its timer once the provider answers, so a hand-over's 24-day timeout keeps no process alive", async () => {
    // In a child process: a timer left armed keeps that process alive, so the child exits only if it was cleared.
    const script = `
      const { runReadOnlyStatement } = await import(${JSON.stringify(MODULE)});
      const provider = { queryReadOnly: async () => ({ rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 1 }) };
      await runReadOnlyStatement(provider, {
        type: "postgres",
        statement: "SELECT 1",
        budget: { statementTimeoutMs: ${MAX_STATEMENT_TIMEOUT_MS}, maxResultRows: 10, maxResultBytes: 10000 },
        wait: "statement-timeout",
      });
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const exitCode = await child.exited;
    expect({ exitCode, signal: child.signalCode, stderr: await new Response(child.stderr).text() }).toEqual({
      exitCode: 0,
      signal: null,
      stderr: "",
    });
  }, 30_000);

  test("under the caller's own deadline it sets no timer of its own", async () => {
    const served = answer([{ id: 1 }]);
    const { provider } = providerAnswering(
      () => new Promise<QueryResult>((resolve) => setTimeout(() => resolve(served), 20)),
    );
    const result = await runReadOnlyStatement(provider, {
      type: "postgres",
      statement: "SELECT 1",
      budget: { ...budget, statementTimeoutMs: 1 },
      wait: "caller-deadline",
    });
    expect(result).toBe(served);
  });

  test("passes a provider's own refusal through untouched", async () => {
    const own = new QueryError(rowBudgetSentence(11, 10), "postgres");
    const { provider } = providerAnswering(async () => {
      throw own;
    });
    const error = await settled(
      runReadOnlyStatement(provider, { type: "postgres", statement: "SELECT 1", budget, wait: "statement-timeout" }),
    );
    expect(error).toBe(own);
  });

  test("refuses a provider with no read-only statement path by name, and never calls query()", async () => {
    const { provider, query } = providerAnswering(undefined);
    const error = await settled(
      runReadOnlyStatement(provider, { type: "redis", statement: "GET k", budget, wait: "statement-timeout" }),
    );
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
    expect((error as ExecutionProfileError).message).toBe(
      'Provider type "redis" implements no read-only statement path (queryReadOnly)',
    );
    expect(query).not.toHaveBeenCalled();
  });

  test("refuses a malformed budget before the provider is called", async () => {
    const queryReadOnly = mock(async () => answer([]));
    const { provider } = providerAnswering(queryReadOnly);
    const error = await settled(
      runReadOnlyStatement(provider, {
        type: "postgres",
        statement: "SELECT 1",
        budget: { ...budget, maxResultRows: 0 },
        wait: "statement-timeout",
      }),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toContain("maxResultRows");
    expect(queryReadOnly).not.toHaveBeenCalled();
  });
});

/**
 * The same hold for a provider read that is not a statement: the agent's catalog read on an engine whose catalog is
 * not a composed statement (`readCatalogReadOnly`) and the two cluster readings (`readClusterUsage`,
 * `readWorkloadProfile`). Their answers are not a `QueryResult`, so the caller names the rows it serves from one, and
 * those rows are what core holds to the budget.
 */
describe("runReadOnlyReading", () => {
  interface Reading {
    readonly listed: readonly Record<string, unknown>[];
  }

  const reading = (count: number, row: (index: number) => Record<string, unknown> = (index) => ({ index })) => ({
    listed: Array.from({ length: count }, (_, index) => row(index)),
  });

  const call = (read: () => Promise<Reading>, overrides: Record<string, unknown> = {}) => ({
    type: "mongodb" as const,
    statement: '{"object":"orders"}',
    budget,
    wait: "statement-timeout" as const,
    read,
    servedRows: (answer: Reading) => answer.listed,
    maxRows: budget.maxResultRows,
    ...overrides,
  });

  test("makes the read once and returns its answer unchanged when the rows it serves are within the budget", async () => {
    const served = reading(budget.maxResultRows);
    const read = mock(async () => served);
    expect(await runReadOnlyReading(call(read))).toBe(served);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("refuses served rows past the row bound the caller names, in the row sentence every provider uses", async () => {
    const error = await settled(runReadOnlyReading(call(async () => reading(4), { maxRows: 3 })));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toBe(rowBudgetSentence(4, 3));
    expect((error as QueryError).provider).toBe("mongodb");
  });

  test("holds the served rows to a row bound of the read's own above the budget's, where the caller names one", async () => {
    const served = reading(budget.maxResultRows + 5);
    expect(await runReadOnlyReading(call(async () => served, { maxRows: budget.maxResultRows + 5 }))).toBe(served);
    const error = await settled(
      runReadOnlyReading(call(async () => reading(budget.maxResultRows + 6), { maxRows: budget.maxResultRows + 5 })),
    );
    expect((error as QueryError).message).toBe(rowBudgetSentence(budget.maxResultRows + 6, budget.maxResultRows + 5));
  });

  test("refuses served rows whose UTF-8 JSON bytes, summed per row, pass the budget, in the byte sentence", async () => {
    // Each row's UTF-16 length is under its UTF-8 size: only a byte measure refuses them.
    const row = (index: number) => ({ name: `${"é".repeat(1_000)}${index}` });
    const served = reading(6, row);
    const crossing = served.listed.findIndex(
      (_, index) =>
        served.listed.slice(0, index + 1).reduce((sum, each) => sum + measureRowBytes(each), 0) > budget.maxResultBytes,
    );
    const sum = served.listed.slice(0, crossing + 1).reduce((total, each) => total + measureRowBytes(each), 0);
    expect(JSON.stringify(served.listed).length).toBeLessThan(budget.maxResultBytes);
    const error = await settled(runReadOnlyReading(call(async () => served)));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toBe(byteBudgetSentence(sum, budget.maxResultBytes));
  });

  test("refuses in the read's own sentences where the caller names them", async () => {
    const refuseRows = mock((rows: number, allowed: number) => new Error(`rows ${rows} of ${allowed}`));
    const refuseBytes = mock((bytes: number, allowed: number) => new Error(`bytes ${bytes} of ${allowed}`));
    const rows = await settled(
      runReadOnlyReading(call(async () => reading(4), { maxRows: 3, refuseRows, refuseBytes })),
    );
    expect((rows as Error).message).toBe("rows 4 of 3");
    const wide = { name: "w".repeat(budget.maxResultBytes) };
    const bytes = await settled(
      runReadOnlyReading(call(async () => reading(1, () => wide), { refuseRows, refuseBytes })),
    );
    expect((bytes as Error).message).toBe(`bytes ${measureRowBytes(wide)} of ${budget.maxResultBytes}`);
  });

  test("refuses a read that does not answer within the statement timeout, in the time sentence, and hands the call to the hold", async () => {
    const pending = new Promise<Reading>(() => {});
    const holdUntilSettled = mock<(call: PromiseLike<unknown>) => void>(() => {});
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const error = await settled(
        runReadOnlyReading(call(() => pending, { budget: { ...budget, statementTimeoutMs: 5 }, holdUntilSettled })),
      );
      expect(error).toBeInstanceOf(QueryError);
      expect((error as QueryError).message).toBe(`${TIME_BUDGET_PREFIX}: no answer within 5ms`);
      expect(holdUntilSettled).toHaveBeenCalledTimes(1);
      expect(holdUntilSettled.mock.calls[0][0]).toBe(pending);
    } finally {
      warned.mockRestore();
    }
  });

  test("logs a read it stopped waiting for in the same line as a statement, naming neither a statement nor the read's label", async () => {
    let resolve: (answer: Reading) => void = () => {};
    const late = new Promise<Reading>((resolveLate) => {
      resolve = resolveLate;
    });
    const statement = `usage ${crypto.randomUUID()}`;
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await settled(
        runReadOnlyReading(
          call(() => late, { type: "kubernetes", statement, budget: { ...budget, statementTimeoutMs: 1 } }),
        ),
      );
      resolve(reading(1));
      await late;
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      expect(warned).toHaveBeenCalledTimes(1);
      const [message, context] = warned.mock.calls[0];
      expect(message).toBe("A read-only call settled after Studio stopped waiting for it");
      expect(context).toMatchObject({ provider: "kubernetes", outcome: "answered" });
      expect(JSON.stringify(warned.mock.calls)).not.toContain(statement);
    } finally {
      warned.mockRestore();
    }
  });

  test("refuses a malformed budget before the read is made", async () => {
    const read = mock(async () => reading(1));
    const error = await settled(runReadOnlyReading(call(read, { budget: { ...budget, statementTimeoutMs: 0 } })));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toContain("statementTimeoutMs");
    expect(read).not.toHaveBeenCalled();
  });
});
