import { describe, expect, mock, test } from "bun:test";
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  measureRowBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import { runReadOnlyStatement } from "@/lib/db/operations/read-only-statement";
import type { DatabaseProvider, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";

/**
 * The one core call of a provider's read-only statement path: core holds the provider's answer to the row, byte and
 * time budget it handed out, whatever the provider does with that budget itself.
 */

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
    const row = { n: 12345678901234567890n };
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

  test("keeps a rejection handler on a call it stopped waiting for, so its late failure is no unhandled rejection", async () => {
    let reject: (error: Error) => void = () => {};
    const late = new Promise<QueryResult>((_resolve, rejectLate) => {
      reject = rejectLate;
    });
    const { provider } = providerAnswering(() => late);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
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
      process.off("unhandledRejection", listener);
    }
  });

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
