import "../setup-dom";
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { restoreGlobalFetch } from "../helpers/mock-fetch";

import { useInlineEditing } from "@/hooks/use-inline-editing";
import type { DatabaseConnection, QueryTab, QueryResult } from "@/lib/types";
import type { CellChange } from "@/components/ResultsGrid";

// ── Test Data ───────────────────────────────────────────────────────────────

const makeConnection = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
  id: "conn-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
  user: "admin",
  password: "secret",
  createdAt: new Date("2026-01-01"),
  ...overrides,
});

const makeResult = (overrides: Partial<QueryResult> = {}): QueryResult => ({
  rows: [
    { id: 1, name: "Alice", email: "alice@test.com" },
    { id: 2, name: "Bob", email: "bob@test.com" },
  ],
  fields: ["id", "name", "email"],
  rowCount: 2,
  executionTime: 12,
  ...overrides,
});

const makeTab = (overrides: Partial<QueryTab> = {}): QueryTab => ({
  id: "tab-1",
  name: "users",
  query: "SELECT * FROM users",
  result: makeResult(),
  isExecuting: false,
  type: "sql",
  ...overrides,
});

const makeChange = (overrides: Partial<CellChange> = {}): CellChange => ({
  rowIndex: 0,
  columnId: "name",
  originalValue: "Alice",
  newValue: "Alice Updated",
  ...overrides,
});

// =============================================================================
// useInlineEditing Tests
// =============================================================================
describe("useInlineEditing", () => {
  let mockExecuteQuery: ReturnType<typeof mock>;

  /**
   * The key check an apply now makes before it writes anything: one `COUNT(*)` over the
   * keys about to be updated, which has to come back equal to how many there are. By
   * default it does, so every test below is about what it was about before. The tests that
   * are about the check answer it themselves.
   */
  function answerKeyCheck(matched?: number) {
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      void body;
      // The shape the product actually answers with: `/api/db/query` returns rows as
      // OBJECTS, and PostgreSQL reports a bare `COUNT(*)` as the string "1" under a column
      // it names `count`. A mock returning `[[1]]` would exercise a branch the product
      // never takes, and line coverage would not notice.
      //
      // One group per key, each holding one row, which is the shape that passes. Pass
      // `matched` to answer a single group of that many rows instead — the key that does
      // not tell its rows apart.
      const body2 = JSON.parse(String(init?.body ?? "{}"));
      // Where the dialect has no positional bind form the values are written into the
      // statement instead, so there is no `params` to count: one group is the right answer
      // for the single key those tests edit.
      const bound = (body2.params ?? [1]) as unknown[];
      const answer =
        matched === undefined
          ? bound.map((key) => ({ id: key, count: "1" }))
          : matched === 0
            ? []
            : [{ id: bound[0], count: String(matched) }];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: answer, fields: ["id", "count"], rowCount: answer.length }),
      });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    mockExecuteQuery = mock(() => {});
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    answerKeyCheck();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  /**
   * The calls carrying a generated UPDATE. A successful apply ends by re-running the
   * tab's own query, so the raw call list holds one extra entry that is not a row.
   */
  const updateCalls = () =>
    (mockExecuteQuery as ReturnType<typeof mock>).mock.calls.filter((call) => String(call[0]).startsWith("UPDATE"));

  // ── Initial State ─────────────────────────────────────────────────────────

  test("initially editingEnabled is false and pendingChanges is empty", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    expect(result.current.editingEnabled).toBe(false);
    expect(result.current.pendingChanges).toEqual([]);
  });

  // ── handleCellChange adds a change ────────────────────────────────────────

  test("handleCellChange adds a change", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });

    expect(result.current.pendingChanges).toHaveLength(1);
    expect(result.current.pendingChanges[0].columnId).toBe("name");
    expect(result.current.pendingChanges[0].newValue).toBe("Alice Updated");
  });

  // ── handleCellChange replaces existing change for same cell ───────────────

  test("handleCellChange replaces existing change for same cell", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "First edit" }));
    });

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "Second edit" }));
    });

    expect(result.current.pendingChanges).toHaveLength(1);
    expect(result.current.pendingChanges[0].newValue).toBe("Second edit");
  });

  // ── handleCellChange removes change when reverting to original ────────────

  test("handleCellChange removes change when reverting to original value", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    // Add a change first
    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "Edited" }));
    });

    expect(result.current.pendingChanges).toHaveLength(1);

    // Revert to original value
    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "Alice" }));
    });

    expect(result.current.pendingChanges).toHaveLength(0);
  });

  // ── handleCellChange ignores no-op change ─────────────────────────────────

  test("handleCellChange ignores no-op change", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    // Try to add a "change" where newValue equals originalValue
    act(() => {
      result.current.handleCellChange(
        makeChange({
          originalValue: "Alice",
          newValue: "Alice",
        }),
      );
    });

    expect(result.current.pendingChanges).toHaveLength(0);
  });

  // ── handleApplyChanges generates UPDATE SQL ───────────────────────────────

  test("handleApplyChanges generates UPDATE SQL and calls executeQuery", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    // Add a pending change
    act(() => {
      result.current.handleCellChange(
        makeChange({
          rowIndex: 0,
          columnId: "name",
          originalValue: "Alice",
          newValue: "Alice Updated",
        }),
      );
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    // One call for the edited row, then one more that re-runs the tab's own query: the
    // UPDATE wrote its own empty result over the grid, so the rows are read back (#883).
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[1][0]).toBe("SELECT * FROM users");

    const sql = (mockExecuteQuery as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE");
    expect(sql).toContain("users");
    // Column identifiers are quoted (PR #289 review): a result field is named by
    // whatever the query aliased it to, so it reaches SQL as arbitrary text. Values
    // are bound rather than quoted (#290), so the statement carries placeholders.
    expect(sql).toContain(`"name" = $1`);
    expect(sql).toContain(`WHERE "id" = $2`);
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[0][3]).toEqual({
      skipSafety: true,
      params: ["Alice Updated", 1],
    });

    // Changes should be cleared after apply
    expect(result.current.pendingChanges).toEqual([]);
    expect(result.current.editingEnabled).toBe(false);
  });
  test("takes the table from the query, whatever the tab is called", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          name: "Query 2",
          query: "SELECT id, name, category FROM products ORDER BY id",
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({
          columnId: "name",
          originalValue: "Alice",
          newValue: "Alice Updated",
        }),
      );
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(1);

    const sql = updateCalls()[0][0] as string;
    expect(sql).toContain("UPDATE products");
  });
  // ── handleApplyChanges one request per edited row (#269) ──────────────────

  test("handleApplyChanges executes one statement per edited row, never a joined payload", async () => {
    // A joined payload reaches the engine as one string whenever a transaction or
    // sandbox run is active, and it makes a failure unattributable to a row even on
    // the split path. Each row is therefore sent on its own, without the trailing
    // semicolon that only ever served to join them — `splitStatements` used to strip
    // it on the multi-statement route, and oracledb rejects a plain statement that
    // carries one.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alice Updated" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "bob@new.test" }),
      );
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(2);

    const sent = updateCalls().map((call) => call[0] as string);
    for (const sql of sent) {
      expect(sql).not.toContain("\n");
      expect(sql.match(/UPDATE/g)).toHaveLength(1);
      expect(sql.endsWith(";")).toBe(false);
    }
    expect(sent[0]).toBe(`UPDATE users SET "name" = $1 WHERE "id" = $2`);
    expect(sent[1]).toBe(`UPDATE users SET "email" = $1 WHERE "id" = $2`);
    // Each row carries its own parameters, so a shared statement text is not a
    // shared payload: placeholder numbering restarts per request.
    const options = updateCalls().map((call) => call[3]);
    expect(options[0]).toEqual({ skipSafety: true, params: ["Alice Updated", 1] });
    expect(options[1]).toEqual({ skipSafety: true, params: ["bob@new.test", 2] });
  });

  test("handleApplyChanges runs each row past the safety dialog, so every row is applied", async () => {
    // useQueryExecution's safety gate returns WITHOUT executing for any
    // `UPDATE ... SET` and only remembers the last query it was handed, so an
    // unflagged per-row loop would apply nothing but the row the user then
    // confirms. Apply is itself the confirmation here: the statements are
    // generated, single-row and primary-key scoped, and the pending changes were
    // reviewed in the grid before the click.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alice Updated" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "name", originalValue: "Bob", newValue: "Bob Updated" }),
      );
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const calls = updateCalls();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect((call[3] as { skipSafety?: boolean }).skipSafety).toBe(true);
    }
  });

  test("handleApplyChanges awaits each row before sending the next", async () => {
    // executeQuery mutates the active tab's result and isExecuting, so concurrent
    // calls would race on that state; the order below is what proves it is
    // sequential rather than fired in parallel.
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const sequential = mock((sql: string) => {
      order.push(`start:${sql}`);
      if (!resolveFirst) {
        return new Promise<void>((resolve) => {
          resolveFirst = () => {
            order.push(`end:${sql}`);
            resolve();
          };
        });
      }
      order.push(`end:${sql}`);
      return Promise.resolve();
    });

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: sequential,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "A2" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "name", originalValue: "Bob", newValue: "B2" }),
      );
    });

    let applied: Promise<void> | undefined;
    await act(async () => {
      applied = result.current.handleApplyChanges();
      await Promise.resolve();
    });

    // The second row must not have been sent while the first is still in flight.
    expect(order).toEqual([`start:UPDATE users SET "name" = $1 WHERE "id" = $2`]);

    await act(async () => {
      resolveFirst?.();
      await applied;
    });

    expect(order).toEqual([
      `start:UPDATE users SET "name" = $1 WHERE "id" = $2`,
      `end:UPDATE users SET "name" = $1 WHERE "id" = $2`,
      `start:UPDATE users SET "name" = $1 WHERE "id" = $2`,
      `end:UPDATE users SET "name" = $1 WHERE "id" = $2`,
      // The grid refresh is awaited too, after the last row and never beside it.
      "start:SELECT * FROM users",
      "end:SELECT * FROM users",
    ]);
  });

  // ── handleApplyChanges no primary key ─────────────────────────────────────

  test("handleApplyChanges shows toast when no primary key column found", async () => {
    const tabNoPk = makeTab({
      result: makeResult({
        fields: ["name", "email"], // No 'id' or '*_id' column
        rows: [{ name: "Alice", email: "alice@test.com" }],
      }),
    });

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: tabNoPk,
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange({
        rowIndex: 0,
        columnId: "name",
        originalValue: "Alice",
        newValue: "Bob",
      });
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("No primary key column detected"),
    });
  });

  // ── handleApplyChanges no active connection ───────────────────────────────

  test("handleApplyChanges does nothing when no active connection", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: null,
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  // ── handleApplyChanges empty pendingChanges ───────────────────────────────

  test("handleApplyChanges does nothing when pendingChanges is empty", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  // ── handleDiscardChanges ──────────────────────────────────────────────────

  test("handleDiscardChanges clears pendingChanges", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    // Add some changes
    act(() => {
      result.current.handleCellChange(makeChange({ rowIndex: 0, columnId: "name", newValue: "X" }));
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "y@test.com" }),
      );
    });

    expect(result.current.pendingChanges.length).toBeGreaterThan(0);

    act(() => {
      result.current.handleDiscardChanges();
    });

    expect(result.current.pendingChanges).toEqual([]);
  });

  // ── Generated SQL must stay one statement (PR #289 review) ────────────────
  //
  // A result field is named by whatever the query aliased it to, so a column id is
  // arbitrary text that reaches the generated UPDATE as an identifier. Applying
  // edits skips the dangerous-query dialog, so nothing shows the user that SQL
  // first — the statement has to be inert by construction.

  test("quotes a column name that spells SQL instead of emitting it bare", async () => {
    const hostile = "x = 1; DELETE FROM users; --";
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({ fields: ["id", hostile], rows: [{ id: 1, [hostile]: "v" }] }),
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ columnId: hostile, originalValue: "v", newValue: "w" }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(1);
    const sql = updateCalls()[0][0] as string;
    expect(sql).toBe(`UPDATE users SET "${hostile}" = $1 WHERE "id" = $2`);
    // Nothing outside the quoted identifier ends the statement.
    expect(sql.replace(/"[^"]*"/g, "")).not.toContain(";");
  });

  test("quotes an ordinary column name that needs quoting to be legal", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab({
          result: makeResult({ fields: ["id", "first name"], rows: [{ id: 1, "first name": "Alice" }] }),
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ columnId: "first name", originalValue: "Alice", newValue: "Bob" }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery.mock.calls[0][0]).toBe("UPDATE users SET `first name` = ? WHERE `id` = ?");
  });

  test("refuses to apply when the query names no table", async () => {
    // Unlike a column, the table name cannot be quoted safely: quoting a hand-typed
    // lowercase name would break Oracle, where the real table is upper-cased. So it is
    // validated as a bare identifier and refused when it is anything else. The hostile
    // tab name here is the #881 half: it is not consulted, so it cannot reach the SQL
    // even though the query offers no table of its own.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({ name: "users; DROP TABLE users; --", query: "" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  test("accepts a schema-qualified table name", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({ query: "SELECT * FROM public.users" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery.mock.calls[0][0]).toBe(`UPDATE public.users SET "name" = $1 WHERE "id" = $2`);
  });

  // ── Values are bound, not interpolated (#290) ─────────────────────────────
  //
  // The value half of the statement is arbitrary text — pasted, imported, or read
  // back from the table. Doubling the quote is enough only where a backslash is
  // data; MySQL reads `\'` as an escaped quote, so an interpolated value could
  // close its literal early and have the rest read as SQL. Applying edits skips
  // the dangerous-query dialog, so nothing shows that statement before it runs.

  test("binds the edited value in the placeholder form the dialect's driver expects", async () => {
    const cases: Array<{ type: DatabaseConnection["type"]; sql: string }> = [
      { type: "postgres", sql: `UPDATE users SET "name" = $1 WHERE "id" = $2` },
      { type: "mysql", sql: "UPDATE users SET `name` = ? WHERE `id` = ?" },
      { type: "sqlite", sql: `UPDATE users SET "name" = ? WHERE "id" = ?` },
      { type: "oracle", sql: `UPDATE users SET "name" = :1 WHERE "id" = :2` },
      { type: "mssql", sql: `UPDATE users SET [name] = @p1 WHERE [id] = @p2` },
    ];

    for (const { type, sql } of cases) {
      mockExecuteQuery.mockClear();
      const { result } = renderHook(() =>
        useInlineEditing({
          activeConnection: makeConnection({ type }),
          currentTab: makeTab(),
          executeQuery: mockExecuteQuery as (sql: string) => void,
        }),
      );

      act(() => {
        result.current.handleCellChange(makeChange({ newValue: "Alice Updated" }));
      });
      await act(async () => {
        await result.current.handleApplyChanges();
      });

      expect(mockExecuteQuery.mock.calls[0][0]).toBe(sql);
      expect(mockExecuteQuery.mock.calls[0][3]).toEqual({ skipSafety: true, params: ["Alice Updated", 1] });
    }
  });

  test("a backslash-escaping dialect cannot read the edited value as SQL", async () => {
    // The issue #290 payload: interpolated into a MySQL statement it closed the
    // literal early and `WHERE 1=1` became the real predicate, so every row in the
    // table was updated instead of the edited one.
    const payload = "\\' WHERE 1=1 -- ";
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: payload }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const [sql, , , options] = mockExecuteQuery.mock.calls[0];
    expect(sql).toBe("UPDATE users SET `name` = ? WHERE `id` = ?");
    expect(sql).not.toContain("1=1");
    expect(options).toEqual({ skipSafety: true, params: [payload, 1] });
  });

  test("binds a primary key value that is not a number instead of quoting it", async () => {
    // The key is read back from the result, so it carries whatever the table holds.
    // A natural key with a quote in it used to reach `WHERE id = '...'` with no
    // escaping at all — in every dialect, not only the backslash ones.
    const hostileKey = "x' OR '1'='1";
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            fields: ["id", "name"],
            rows: [{ id: hostileKey, name: "Alice" }],
          }),
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "Alice Updated" }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const [sql, , , options] = mockExecuteQuery.mock.calls[0];
    expect(sql).toBe(`UPDATE users SET "name" = $1 WHERE "id" = $2`);
    expect(options).toEqual({ skipSafety: true, params: ["Alice Updated", hostileKey] });
  });

  test("keeps NULL a keyword and numbers the remaining placeholders around it", async () => {
    // Clearing a cell means SQL NULL, which is a keyword rather than a value, so it
    // takes no parameter — and the placeholders that follow must not count it.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ columnId: "name", originalValue: "Alice", newValue: "" }));
      result.current.handleCellChange(
        makeChange({ columnId: "email", originalValue: "alice@test.com", newValue: "new@test.com" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const [sql, , , options] = mockExecuteQuery.mock.calls[0];
    expect(sql).toBe(`UPDATE users SET "name" = NULL, "email" = $1 WHERE "id" = $2`);
    expect(options).toEqual({ skipSafety: true, params: ["new@test.com", 1] });
  });

  test("quotes the value dialect-aware where the dialect has no positional bind form", async () => {
    // ClickHouse's provider refuses positional parameters outright, so a statement
    // built for it has to carry its values as literals — quoted the way ClickHouse
    // reads them, backslash included. Its `supportsInlineRowEdit` is false today, so
    // this is the guard that keeps issue #279 from re-opening #290 when a dialect
    // like it gains row editing.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "clickhouse" }),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "a\\'b" }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const [sql, , , options] = mockExecuteQuery.mock.calls[0];
    expect(sql).toBe(`UPDATE users SET "name" = 'a\\\\''b' WHERE "id" = 1`);
    expect(options).toEqual({ skipSafety: true });
  });

  // ── The tab title never steers the write (#881) ───────────────────────────
  //
  // A tab title is free text. It survives when the query in the tab is replaced, it is
  // not tied to the rows on screen, and renaming a tab is not a way anyone expects to
  // choose a write target. Where a title happened to name another real table carrying
  // the same key column, the UPDATE landed on that table and nothing said so.

  test("writes to the table the query reads, not the one the tab is named after", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        // The rows came from `users`; the tab is called `customers` because someone
        // renamed it, or because it was created for a query that has since been replaced.
        currentTab: makeTab({ name: "customers", query: "SELECT * FROM users" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()[0][0]).toBe(`UPDATE users SET "name" = $1 WHERE "id" = $2`);
  });

  test("refuses rather than guessing when the rows have no single base table", async () => {
    // A joined result's cell may belong to either table, so there is no answer to give.
    // The tab title used to supply one anyway.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          name: "users",
          query: "SELECT u.id, u.name FROM users u JOIN orders o ON o.user_id = u.id",
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("reads to this editor as a second table"),
    });
    // The work stays on screen: nothing was written, so nothing is discarded.
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  // ── A refused write is not a successful one (#882) ────────────────────────
  //
  // `executeQuery` reports a failing statement to the user and returns; what it could
  // not do was tell the apply loop. So the loop cleared the pending changes, turned
  // editing off and said "Changes Applied" after a write the engine had rejected — the
  // edits were gone and the row was unchanged.

  test("keeps the edits and says so when every row fails", async () => {
    const failing = mock((_sql: string) => Promise.resolve(false));
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: failing,
      }),
    );

    act(() => {
      result.current.setEditingEnabled(true);
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(result.current.pendingChanges).toHaveLength(1);
    expect(result.current.editingEnabled).toBe(true);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Changes Not Applied", {
      description: expect.stringContaining("1 row could not be confirmed as saved"),
    });
    // Nothing is read back either: the grid still holds the rows the edits belong to.
    expect(failing.mock.calls.filter((call) => String(call[0]).startsWith("SELECT"))).toHaveLength(0);
  });

  test("re-reads the grid and drops the edits when only some rows applied", async () => {
    // The rows that DID apply have already written their own empty results over the grid,
    // so the rows the edits were positions into are gone. Carrying an index forward onto
    // a result this hook cannot see would put a retry's key on whatever row now sits at
    // that index — the wrong-row write #881 is about — so the refresh is what the user
    // gets instead, and the toast points at it.
    const secondRowFails = mock((sql: string) => Promise.resolve(!sql.includes("email")));
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: secondRowFails,
      }),
    );

    act(() => {
      result.current.setEditingEnabled(true);
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alice Updated" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "bob@new.test" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(result.current.pendingChanges).toEqual([]);
    // Editing stays on, so the failed row can be corrected straight away in the grid the
    // refresh just put back.
    expect(result.current.editingEnabled).toBe(true);
    expect(secondRowFails.mock.calls.map((call) => call[0])).toEqual([
      `UPDATE users SET "name" = $1 WHERE "id" = $2`,
      `UPDATE users SET "email" = $1 WHERE "id" = $2`,
      "SELECT * FROM users",
    ]);
    expect(mockToastError).toHaveBeenCalledWith("Some Changes Not Applied", {
      description: expect.stringContaining("1 of 2 rows could not be confirmed as saved"),
    });
  });

  test("treats a caller that reports nothing as the success it was before", async () => {
    // The outcome is new, so an implementation that returns void keeps the behaviour it
    // had: only an explicit refusal is read as a failure.
    const silent = mock(() => undefined);
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: silent,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(result.current.pendingChanges).toEqual([]);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  // ── The grid comes back after applying (#883) ─────────────────────────────
  //
  // Each UPDATE writes its own result into the tab as it runs, so by the time the loop
  // ends the rows the edits came from are gone and the user is left looking at the last
  // statement's empty result. Re-running the tab's own query puts them back, and shows
  // them as the engine now holds them.

  test("sends every UPDATE to the tab the edits came from", async () => {
    // Not to whichever tab happens to be active by the time a row answers: a user who
    // switches tabs mid-apply would otherwise have another tab's grid replaced by these
    // statements' empty results.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({ id: "tab-7" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    for (const call of (mockExecuteQuery as ReturnType<typeof mock>).mock.calls) {
      expect(call[1]).toBe("tab-7");
    }
  });

  test("re-runs the tab's query after applying, and only after the last row", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "A2" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "name", originalValue: "Bob", newValue: "B2" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const sent = (mockExecuteQuery as ReturnType<typeof mock>).mock.calls.map((call) => call[0] as string);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toBe("SELECT * FROM users");
    // The refresh is an ordinary read: it carries no skipSafety and no parameters, so
    // it goes through the same path the Run button uses.
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[2][3]).toBeUndefined();
    // It goes to the tab the edits came from, not to whichever tab is active by then.
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[2][1]).toBe("tab-1");
    expect(mockToastSuccess).toHaveBeenCalledWith("Changes Applied", {
      description: "2 UPDATE statements accepted. The results are up to date.",
    });
  });

  test("does not re-run the query when a row was refused", async () => {
    const failing = mock((_sql: string) => Promise.resolve(false));
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: failing,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(failing.mock.calls.map((call) => call[0] as string)).toEqual([
      `UPDATE users SET "name" = $1 WHERE "id" = $2`,
    ]);
  });

  test("does not claim a re-read that failed when only some rows applied", async () => {
    // Two things went wrong at once: a row was refused, and the read meant to show which
    // rows survived did not land either. Telling the user the results are up to date would
    // then be pointing at rows that are not.
    const rowAndRefreshFail = mock((sql: string) =>
      Promise.resolve(sql.startsWith("UPDATE") && !sql.includes("email")),
    );
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: rowAndRefreshFail,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alice Updated" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "bob@new.test" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockToastError).toHaveBeenCalledWith("Some Changes Not Applied", {
      description:
        "1 of 2 rows could not be confirmed as saved, and your edits have been cleared. " +
        "Run the query again to see what was saved.",
    });
  });

  test("says so when the rows applied but the grid could not be re-read", async () => {
    // The apply itself succeeded, so the success toast is the right one — but telling the
    // user the results are up to date would be false when the read that was meant to fetch
    // them did not land.
    const refreshFails = mock((sql: string) => Promise.resolve(sql.startsWith("UPDATE")));
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: refreshFails,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(result.current.pendingChanges).toEqual([]);
    expect(result.current.editingEnabled).toBe(false);
    expect(mockToastSuccess).toHaveBeenCalledWith("Changes Applied", {
      description: "1 UPDATE statement accepted. Run the query again to see the saved rows.",
    });
  });

  test("reads the query under the connection's own dialect", async () => {
    // `#` opens a comment on MySQL and is an OPERATOR on PostgreSQL, so the same text is a
    // single-table read on one and a join on the other. PostgreSQL is the half that proves
    // the connection's type reached the reader: `#` opens a comment under the dialect-less
    // default too, so a MySQL fixture alone would still pass with the type dropped.
    const query = "SELECT * FROM users # JOIN orders\nWHERE id = 1";

    const mysql = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab({ query, resultQuery: query }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );
    act(() => {
      mysql.result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await mysql.result.current.handleApplyChanges();
    });
    expect(updateCalls()[0][0]).toBe("UPDATE users SET `name` = ? WHERE `id` = ?");

    const postgres = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "postgres" }),
        currentTab: makeTab({ id: "tab-2", query, resultQuery: query }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );
    act(() => {
      postgres.result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await postgres.result.current.handleApplyChanges();
    });
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("reads to this editor as a second table"),
    });
  });

  // ── The rows decide, not the buffer and not the tab (#881) ────────────────

  test("writes to the table the ROWS came from, not the text now in the editor", async () => {
    // `query` is the editor buffer and is rewritten on every keystroke, and a run may have
    // executed only a selection of it. Retyping the statement without running it used to
    // point the write at a table the displayed rows never came from — the same harm as a
    // renamed tab, reached by typing.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({ query: "SELECT * FROM orders", resultQuery: "SELECT * FROM users" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()[0][0]).toBe(`UPDATE users SET "name" = $1 WHERE "id" = $2`);
    // The refresh re-runs that same statement too, so the grid it puts back is the one the
    // edits belonged to.
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[1][0]).toBe("SELECT * FROM users");
  });

  test("refuses edits whose rows have been replaced under them", async () => {
    // Re-running the query is the ordinary thing to do after a failed apply, and it puts
    // different rows at the same indices. Measured before this guard: an edit typed into
    // the row whose key was 1 was written to the row whose key was 77, reported as applied.
    // The change carries what settles it — the cell's content when it was edited.
    const { result, rerender } = renderHook(
      (props: { tab: QueryTab }) =>
        useInlineEditing({
          activeConnection: makeConnection(),
          currentTab: props.tab,
          executeQuery: mockExecuteQuery as (sql: string) => void,
        }),
      { initialProps: { tab: makeTab() } },
    );

    act(() => {
      result.current.handleCellChange(makeChange({ rowIndex: 0, originalValue: "Alice", newValue: "Alice Updated" }));
    });

    // Same tab, same query - different rows.
    rerender({
      tab: makeTab({
        result: makeResult({ rows: [{ id: 77, name: "Carol", email: "carol@test.com" }], rowCount: 1 }),
      }),
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    // Kept, not cleared: every other refusal in this hook leaves the work on screen, the
    // check runs again on the next click, and Discard is how a user throws work away on
    // purpose.
    expect(result.current.pendingChanges).toHaveLength(1);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer on screen"),
    });
  });

  test("does not mistake a name on Object.prototype for the row's own value", async () => {
    // A driver that drops nulls leaves a declared column off the row object, and a column
    // named `constructor` or `toString` then resolves off the prototype instead of being
    // absent - which compared a function against the empty string and refused for ever,
    // with a message that was not true. The grid reads the cell with `Object.hasOwn`, so
    // this has to as well or the two are talking about different things.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({ fields: ["id", "constructor"], rows: [{ id: 1 }] }),
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "constructor", originalValue: null, newValue: "set" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()[0][0]).toBe(`UPDATE users SET "constructor" = $1 WHERE "id" = $2`);
  });

  test("refuses an edit whose row could not be placed at all", async () => {
    // `ResultsGrid` sends -1 when it cannot find the edited row in the result — a state it
    // argues is unreachable, and this is what happens if it ever is. -1 addresses no row,
    // so the apply refuses instead of writing somewhere by index.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ rowIndex: -1 }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer on screen"),
    });
  });

  test("refuses edits whose row is no longer there at all", async () => {
    // The re-read can also return FEWER rows, and reading the key out of a row that is not
    // there threw before this - nothing sent, nothing said.
    const { result, rerender } = renderHook(
      (props: { tab: QueryTab }) =>
        useInlineEditing({
          activeConnection: makeConnection(),
          currentTab: props.tab,
          executeQuery: mockExecuteQuery as (sql: string) => void,
        }),
      { initialProps: { tab: makeTab() } },
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "bob@new.test" }),
      );
    });

    rerender({ tab: makeTab({ result: makeResult({ rows: [{ id: 1, name: "Alice", email: "alice@test.com" }] }) }) });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  test("refuses edits carried over from another tab", async () => {
    // Pending changes are not scoped to a tab, which is a defect older than this change:
    // it is reachable on main with no apply having happened. What this change owes is that
    // the rows a change was made on are checked before it is sent, and another tab's rows
    // do not hold this tab's values.
    const { result, rerender } = renderHook(
      (props: { tab: QueryTab }) =>
        useInlineEditing({
          activeConnection: makeConnection(),
          currentTab: props.tab,
          executeQuery: mockExecuteQuery as (sql: string) => void,
        }),
      { initialProps: { tab: makeTab() } },
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "typed against users" }));
    });

    rerender({
      tab: makeTab({
        id: "tab-2",
        name: "orders",
        query: "SELECT * FROM orders",
        resultQuery: "SELECT * FROM orders",
        result: makeResult({
          rows: [{ id: 9, name: "Order nine", email: "nine@test.com" }],
          rowCount: 1,
        }),
      }),
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(result.current.pendingChanges).toHaveLength(1);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer on screen"),
    });
  });

  // ── The key has to address one row ────────────────────────────────────────

  test("refuses the whole apply when the key it found is not unique", async () => {
    // The measured defect: a result carrying `category_id` and not `product_id` makes the
    // guess land on the foreign key, and `UPDATE ... WHERE category_id = 5` rewrites every
    // product in that category. Fifteen rows on the sample data, reported as one statement
    // accepted. Nothing is written, and the reason names the column and both counts.
    answerKeyCheck(15);
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            rows: [{ category_id: 5, product_name: "Chai" }],
            fields: ["category_id", "product_name"],
            rowCount: 1,
          }),
          query: "SELECT category_id, product_name FROM products",
          resultQuery: "SELECT category_id, product_name FROM products",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange({
        rowIndex: 0,
        columnId: "product_name",
        originalValue: "Chai",
        newValue: "Chai Reserve",
      });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("category_id does not tell these rows apart"),
    });
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("15 rows"),
    });
    // The work stays on screen: nothing was written, so nothing is discarded.
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  test("refuses when that check cannot be run at all", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "connection refused" }) }),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    // A check that did not run is not a check that passed.
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("connection refused"),
    });
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  test("refuses N rows that share one foreign key, without needing to ask the engine", async () => {
    // The hole the first version of this check left open, and the one that matters most:
    // three rows sharing `order_id` 87 sent `IN (87, 87, 87)`, the engine counted the three
    // rows behind that one value, three equalled three, and all three UPDATEs wrote to all
    // three rows. Measured on the sample data. Three rows on screen carrying one key
    // between them is already the answer, so this refuses before any request goes out.
    const seen: Array<{ params: unknown[] }> = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      seen.push({ params: JSON.parse(String(init?.body ?? "{}")).params ?? [] });
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ rows: [{ order_id: 87, count: "3" }], fields: ["order_id", "count"], rowCount: 1 }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { order_id: 87, quantity: 1 },
              { order_id: 87, quantity: 2 },
              { order_id: 87, quantity: 3 },
            ],
            fields: ["order_id", "quantity"],
            rowCount: 3,
          }),
          resultQuery: "SELECT order_id, quantity FROM order_items",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      for (let i = 0; i < 3; i++) {
        result.current.handleCellChange({ rowIndex: i, columnId: "quantity", originalValue: i + 1, newValue: "9" });
      }
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    // Nothing was asked of the engine at all.
    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("cannot tell these rows apart by order_id"),
    });
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("3 rows on screen carry one value between them"),
    });
    expect(result.current.pendingChanges).toHaveLength(3);
  });

  test("refuses two rows whose keys arrived identical, whatever they are in the table", async () => {
    // Measured on MySQL 8.4 through the product's own query route: `mysql2` rounds a BIGINT
    // past 2^53, so a table holding 9007199254740992 and ...993 sends BOTH to the browser as
    // ...992. One key would reach the engine, it would answer one group of one row, and two
    // UPDATEs would then go out with the same WHERE - one row taking the other's value and
    // the other never written, reported as two statements accepted. Two rows on screen
    // carrying one key between them is the answer on its own, before anything is asked.
    const seen: unknown[] = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [{ id: 1, count: "1" }], fields: ["id", "count"], rowCount: 1 }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { id: 9007199254740992, note: "first" },
              { id: 9007199254740992, note: "second" },
            ],
            fields: ["id", "note"],
            rowCount: 2,
          }),
          resultQuery: "SELECT id, note FROM big",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "note", originalValue: "first", newValue: "x" });
      result.current.handleCellChange({ rowIndex: 1, columnId: "note", originalValue: "second", newValue: "y" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("2 rows on screen carry one value between them"),
    });
    expect(result.current.pendingChanges).toHaveLength(2);
  });

  test("keeps a text key and a numeric key apart, and lets the engine settle them", async () => {
    // `bun:sqlite` hands back the text `1` and the integer 1 from the same dynamically typed
    // column. Collapsing them by their text would ask about one key and write two; keeping
    // the type asks about both, and SQLite answers two groups - one of them holding the two
    // text rows, which is the refusal.
    const seen: Array<{ params: unknown[] }> = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      seen.push({ params: JSON.parse(String(init?.body ?? "{}")).params ?? [] });
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [
              { id: "1", count: "2" },
              { id: 1, count: "1" },
            ],
            fields: ["id", "count"],
            rowCount: 2,
          }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "sqlite" }),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { id: "1", note: "text one" },
              { id: 1, note: "number one" },
            ],
            fields: ["id", "note"],
            rowCount: 2,
          }),
          resultQuery: "SELECT id, note FROM t",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "note", originalValue: "text one", newValue: "x" });
      result.current.handleCellChange({ rowIndex: 1, columnId: "note", originalValue: "number one", newValue: "y" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    // Both keys were asked about, not one.
    expect(seen[0].params).toEqual(["1", 1]);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("would write to 3 rows"),
    });
  });

  test("asks inside the transaction when one is open, not beside it", async () => {
    // The UPDATEs go to /api/db/transaction, which holds the one connection the transaction
    // lives on. A check sent to /api/db/query takes a different pooled connection and cannot
    // see anything the transaction has not committed: measured, a row INSERTed inside the
    // open transaction is on screen, invisible to the check, and the apply refuses for ever
    // with "no longer in the table" - false, about a row the user is looking at.
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [{ id: 1, count: "1" }], fields: ["id", "count"], rowCount: 1 }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery,
        transactionActive: true,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/db/transaction");
    expect(seen[0].body.action).toBe("query");
    expect(updateCalls()).toHaveLength(1);
  });

  test("asks for enough rows that a default page cannot cut the answer", async () => {
    // Left to the default the answer is cut at 500 rows, and the groups that fell off would
    // read as rows that are no longer in the table - a refusal with a false reason. The
    // limit is the number of distinct keys plus one, which the answer can never reach.
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [
              { id: 1, count: "1" },
              { id: 2, count: "1" },
            ],
            fields: ["id", "count"],
            rowCount: 2,
          }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
      result.current.handleCellChange({ rowIndex: 1, columnId: "name", originalValue: "Bob", newValue: "Bobby" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect((seen[0].options as { limit: number }).limit).toBe(3);
  });

  test("reads the count by POSITION, because no two engines name it the same", async () => {
    // PostgreSQL calls it `count`, MySQL and SQLite both call it `COUNT(*)`. Reading it by
    // name would work on whichever one the test happened to imitate and refuse every apply
    // on the others, so the mock here answers with MySQL's name.
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [{ id: 1, "COUNT(*)": 1 }], fields: ["id", "COUNT(*)"], rowCount: 1 }),
      }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    // It passed, which it could only do by reading the second value rather than a name.
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("refuses two keys the ENGINE treats as one, which this side cannot see", async () => {
    // The engine decides what counts as the same key, not JavaScript. MySQL's default
    // collation is case-insensitive: `abc` and `ABC` are two distinct keys here and one
    // key there. Measured on MySQL 8.4 - `IN ("abc", "ABC")` counts two rows, a plain
    // total would read that as two keys matching two rows, and `WHERE k = "abc"` then
    // writes to BOTH. Asked grouped, the engine answers ONE group holding two rows.
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ rows: [{ user_id: "abc", count: "2" }], fields: ["user_id", "count"], rowCount: 1 }),
      }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { user_id: "abc", note: "one" },
              { user_id: "ABC", note: "two" },
            ],
            fields: ["user_id", "note"],
            rowCount: 2,
          }),
          resultQuery: "SELECT user_id, note FROM accounts",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "note", originalValue: "one", newValue: "x" });
      result.current.handleCellChange({ rowIndex: 1, columnId: "note", originalValue: "two", newValue: "y" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("user_id does not tell these rows apart"),
    });
    expect(result.current.pendingChanges).toHaveLength(2);
  });

  test("does not call the key unique when there are FEWER rows than keys", async () => {
    // A row deleted under the user. The column may be perfectly unique, so saying it is not
    // would be false, and telling them to add a key already in their query is no help.
    answerKeyCheck(0);
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer in the table"),
    });
    expect(mockToastError).not.toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("does not tell these rows apart"),
    });
  });

  test("refuses a count it cannot read, rather than treating it as a pass", async () => {
    // A group came back with nothing where the count should be. `Number(null)` is zero and
    // would read as a real answer, so the row carries no second value at all.
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [{ id: 1 }], fields: ["id"], rowCount: 1 }),
      }),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("returned no count"),
    });
  });

  test("refuses a key that is an expression wearing a column's name", async () => {
    // Measured against PostgreSQL 16. `SELECT ROW_NUMBER() OVER (ORDER BY product_name) AS
    // product_id, product_name FROM products` puts 1, 2, 3 in a field called product_id;
    // the table really has a product_id; the uniqueness check asks the table about 1 and 2
    // and is told one row each, so all three of its conditions hold; and the UPDATEs then
    // land on whichever products those are, not on the rows anyone was looking at. Two
    // cells edited, two rows written, neither on screen, both reported as accepted.
    const seen: unknown[] = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [
              { product_id: 1, count: "1" },
              { product_id: 2, count: "1" },
            ],
            fields: ["product_id", "count"],
            rowCount: 2,
          }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { product_id: 1, product_name: "Alice Mutton 1" },
              { product_id: 2, product_name: "Alice Mutton 2" },
            ],
            fields: ["product_id", "product_name"],
            rowCount: 2,
          }),
          resultQuery: "SELECT ROW_NUMBER() OVER (ORDER BY product_name) AS product_id, product_name FROM products",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange({
        rowIndex: 0,
        columnId: "product_name",
        originalValue: "Alice Mutton 1",
        newValue: "x",
      });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    // Refused before the engine is asked anything at all.
    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("not read straight from the table"),
    });
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  test("refuses a key that is another column renamed", async () => {
    // The same defect spelled shorter: the WHERE would carry sku's value.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            rows: [{ product_id: "SKU-0001", product_name: "Chai" }],
            fields: ["product_id", "product_name"],
            rowCount: 1,
          }),
          resultQuery: "SELECT sku AS product_id, product_name FROM products",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "product_name", originalValue: "Chai", newValue: "x" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("not read straight from the table"),
    });
  });

  test("refuses a key value this editor cannot even read", async () => {
    // A value with a null prototype has no `toString`, so turning it into text throws - and
    // that happens before the request, outside the try that guards the request itself.
    // Unguarded it left the apply as an unhandled rejection: no write, but no toast either.
    const unreadable = Object.create(null) as Record<string, never>;
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({ rows: [{ id: unreadable, name: "Alice" }], fields: ["id", "name"], rowCount: 1 }),
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("cannot read the id of every row it would write to"),
    });
  });

  test("refuses a row whose key is null before it sends anything", async () => {
    answerKeyCheck();
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({ rows: [{ id: null, name: "Alice" }], fields: ["id", "name"], rowCount: 1 }),
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("has no id"),
    });
  });

  test("refuses when the check never reaches the server", async () => {
    // A rejected request, not a refused one: the browser went offline mid-apply. Same
    // answer as any other unanswered check, because an unanswered check is not a pass.
    globalThis.fetch = mock(() => Promise.reject(new Error("Failed to fetch"))) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("Failed to fetch"),
    });
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  test("the check is bound, not interpolated, and names the resolved table", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push({ sql: body.sql, params: body.params ?? [] });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [{ id: 1, count: "1" }], fields: ["id", "count"], rowCount: 1 }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({ resultQuery: "SELECT * FROM public.users" }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(seen).toHaveLength(1);
    // The table the STATEMENT names, the same one the UPDATE will use.
    expect(seen[0].sql).toContain("FROM public.users");
    expect(seen[0].sql).toContain('"id", COUNT(*) FROM public.users WHERE "id" IN ($1) GROUP BY "id"');
    // The value travels beside the statement, not inside it.
    expect(seen[0].sql).not.toContain("IN (1)");
    expect(seen[0].params).toEqual([1]);
  });

  // ── A key value this editor cannot carry back ─────────────────────────────

  /**
   * Nothing may be asked of the engine about a key whose JavaScript form is not the
   * value the row holds, because every answer it could give would be about a different
   * row — or, as measured, about no row at all.
   */
  function watchFetch(): unknown[] {
    const seen: unknown[] = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [{ id: 1, count: "1" }], fields: ["id", "count"], rowCount: 1 }),
      });
    }) as unknown as typeof fetch;
    return seen;
  }

  /**
   * One row on screen whose key is `key`, with its `note` edited.
   *
   * `declaredKeyType` is what the engine called the `id` column in the very response that
   * carried the row - `QueryResult.columnTypes`, which `/api/db/query` answers beside the
   * rows. Left out, the result declares nothing, which is the state a driver with no type
   * metadata leaves it in.
   */
  async function applyKeyedBy(key: unknown, type: DatabaseConnection["type"] = "postgres", declaredKeyType?: string) {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type }),
        currentTab: makeTab({
          result: makeResult({
            rows: [{ id: key, note: "first" }],
            fields: ["id", "note"],
            rowCount: 1,
            ...(declaredKeyType !== undefined && { columnTypes: { id: declaredKeyType, note: "text" } }),
          }),
          resultQuery: "SELECT id, note FROM keyed",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "note", originalValue: "first", newValue: "changed" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });
    return result;
  }

  test("refuses a bytea key before asking the engine, rather than calling its row missing", async () => {
    // Measured against PostgreSQL 16 through this hook, with `pg` handing the grid what it
    // really hands it: a `bytea` arrives as a Buffer, `String(buffer)` mangles it to the
    // bytes read as text, and the check then asked
    // `WHERE "id" IN ($1)` with that text. PostgreSQL refused the parameter outright
    // (`invalid byte sequence for encoding "UTF8": 0x00`); MySQL 8.4 accepted it and matched
    // nothing, so the apply answered "some of the rows you edited are no longer in the
    // table. Run the query again" while `SELECT count(*) ... WHERE note = 'first'` answered
    // 1. Running the query again produces the same Buffer and the same refusal, for ever.
    const seen = watchFetch();
    const result = await applyKeyedBy(Buffer.from([0x00, 0x11, 0x22, 0x33]));

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("cannot address a row by id here: in 1 row you edited it is binary data"),
    });
    // The claim that was false: the row is exactly where it was.
    expect(mockToastError).not.toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer in the table"),
    });
    // And the advice is something other than the one that loops.
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("Put a column that identifies a row as text or a whole number"),
    });
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  test("refuses a binary key in the shape the browser actually holds", async () => {
    // The HTTP path is JSON, so a Buffer reaches the grid as `{"type":"Buffer","data":[…]}`
    // and `String()` gives "[object Object]". Measured on PostgreSQL 16: the check matched
    // no rows and the apply said they were no longer in the table, with all of them there.
    const seen = watchFetch();
    await applyKeyedBy({ type: "Buffer", data: [0, 17, 34, 51] });

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("in 1 row you edited it is binary data"),
    });
    expect(mockToastError).not.toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer in the table"),
    });
  });

  test("refuses a MySQL BINARY key the same way, whatever the dialect binds", async () => {
    const seen = watchFetch();
    await applyKeyedBy(Buffer.from([0xff, 0xee, 0xdd, 0xcc]), "mysql");

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("in 1 row you edited it is binary data"),
    });
  });

  test("refuses a date key, whose sub-second precision is gone before it gets here", async () => {
    // Measured against PostgreSQL 16: the table holds 2026-09-17 10:00:00.123456, `pg` hands
    // the grid a Date, which carries milliseconds at best, and `String(date)` is
    // "Thu Sep 17 2026 10:00:00 GMT+0000 (Coordinated Universal Time)" — no fractional
    // seconds at all. The engine answered `invalid input syntax for type timestamp` for that
    // text, so the user was shown a driver error for a row that was never in doubt.
    const seen = watchFetch();
    await applyKeyedBy(new Date("2026-09-17T10:00:00.123Z"));

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("in 1 row you edited it is a date and time"),
    });
  });

  test("refuses a key that is a document rather than a value", async () => {
    // A JSON column, or a driver that hands back a composite. `String()` gives
    // "[object Object]" for every one of them, so the engine would be asked about a
    // value no row has ever held.
    const seen = watchFetch();
    await applyKeyedBy({ part: 1, of: 2 });

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("it is a value with no text form the engine could match"),
    });
  });

  test("refuses a key number the driver has already rounded", async () => {
    // One row, so the two-rows-one-value refusal cannot fire: `mysql2` rounds a BIGINT past
    // 2^53, so 9007199254740993 arrives as ...992 and `WHERE id = 9007199254740992`
    // addresses the NEIGHBOURING row. The engine would answer one group of one row and the
    // apply would write to a row nobody edited.
    const seen = watchFetch();
    // 2 ** 53 is what 9007199254740993 becomes, and writing the value that way rather than
    // as the literal is the defect spelled by the language itself: the literal will not
    // survive being typed either.
    await applyKeyedBy(2 ** 53, "mysql");

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("it is a whole number past the range this editor carries exactly"),
    });
  });

  test("refuses a fractional key", async () => {
    const seen = watchFetch();
    await applyKeyedBy(1.5);

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("it is a fractional number"),
    });
  });

  test("refuses a key that is not a number at all", async () => {
    const seen = watchFetch();
    await applyKeyedBy(Number.NaN);

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("it is not a number"),
    });
  });

  test("counts the rows carrying the same unusable kind, and no others", async () => {
    const seen = watchFetch();
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { id: Buffer.from([1]), note: "one" },
              { id: Buffer.from([2]), note: "two" },
              { id: new Date("2026-09-17T10:00:00.000Z"), note: "three" },
            ],
            fields: ["id", "note"],
            rowCount: 3,
          }),
          resultQuery: "SELECT id, note FROM keyed",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    const notes = ["one", "two", "three"];
    act(() => {
      for (let i = 0; i < 3; i++) {
        result.current.handleCellChange({ rowIndex: i, columnId: "note", originalValue: notes[i], newValue: `y${i}` });
      }
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(seen).toHaveLength(0);
    // Two rows carry binary data; the third carries a date, and is not counted as binary.
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("in 2 rows you edited it is binary data"),
    });
  });

  test("still lets a whole number and a text key through to the engine", async () => {
    // The guard this sits in front of is unchanged for every key that is fine: a safe
    // integer and a string are both asked about, and both applied.
    const seen: Array<{ params: unknown[] }> = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      seen.push({ params: JSON.parse(String(init?.body ?? "{}")).params ?? [] });
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [
              { id: 7, count: "1" },
              { id: "SKU-1", count: "1" },
            ],
            fields: ["id", "count"],
            rowCount: 2,
          }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { id: 7, note: "one" },
              { id: "SKU-1", note: "two" },
            ],
            fields: ["id", "note"],
            rowCount: 2,
          }),
          resultQuery: "SELECT id, note FROM keyed",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "note", originalValue: "one", newValue: "a" });
      result.current.handleCellChange({ rowIndex: 1, columnId: "note", originalValue: "two", newValue: "b" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(seen[0].params).toEqual([7, "SKU-1"]);
    expect(updateCalls()).toHaveLength(2);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  // ── A refusal may not report half of what the engine answered ─────────────

  test("names the rows that have gone as well as the key that duplicates", async () => {
    // Measured against PostgreSQL 16. `zz_dup_keys` held k_id 1 twice and k_id 2 once; the
    // grid was read with all three rows on it; someone then deleted the k_id 2 row. The
    // check asked about 1 and 2 and was answered with ONE group of two rows, so the totals
    // came out two-into-two and the apply said "k_id does not tell these rows apart in this
    // table: the 2 rows you edited would write to 2 rows" - which reads as harmless, and
    // says nothing at all about the row that has gone.
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [{ k_id: 1, count: "2" }], fields: ["k_id", "count"], rowCount: 1 }),
      }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { k_id: 1, note: "one-a" },
              { k_id: 2, note: "two" },
            ],
            fields: ["k_id", "note"],
            rowCount: 2,
          }),
          resultQuery: "SELECT k_id, note FROM zz_dup_keys",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "note", originalValue: "one-a", newValue: "x" });
      result.current.handleCellChange({ rowIndex: 1, columnId: "note", originalValue: "two", newValue: "z" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    // Both halves, in one sentence: the duplication AND the key the engine could not answer for.
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("k_id does not tell these rows apart in this table"),
    });
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("the engine answered for only 1 of those 2 keys"),
    });
    expect(result.current.pendingChanges).toHaveLength(2);
  });

  test("says both halves even when the totals come out short as well", async () => {
    // Three keys: one addressing two rows, two the engine has no answer for. The total is
    // smaller than the number of keys, which used to send this straight to "no longer in
    // the table" - true, and silent about the key that writes to two rows.
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [{ id: 1, count: "2" }], fields: ["id", "count"], rowCount: 1 }),
      }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { id: 1, note: "one" },
              { id: 2, note: "two" },
              { id: 3, note: "three" },
            ],
            fields: ["id", "note"],
            rowCount: 3,
          }),
          resultQuery: "SELECT id, note FROM keyed",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );

    const notes = ["one", "two", "three"];
    act(() => {
      for (let i = 0; i < 3; i++) {
        result.current.handleCellChange({ rowIndex: i, columnId: "note", originalValue: notes[i], newValue: `y${i}` });
      }
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("the 3 rows you edited would write to 2 rows"),
    });
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("the engine answered for only 1 of those 3 keys"),
    });
  });

  // ── VERIFIER (agent 8 audit) ──────────────────────────────────────────────
  //
  // Everything below was measured against the live engines before it was written:
  // PostgreSQL 16.15 in `guide-pg` and MySQL 8.4.11 in `guide-my`, driven through the
  // real `createDatabaseProvider` path, with this hook rendered over the rows those
  // providers actually returned. The mock engines here answer exactly what the live
  // ones answered.

  /** An engine that is asked and finds nothing — and a record of having been asked. */
  function answerNothing(): unknown[] {
    const seen: unknown[] = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [], fields: ["id", "count"], rowCount: 0 }),
      });
    }) as unknown as typeof fetch;
    return seen;
  }

  test("a timestamp key in the shape the browser holds is still called a missing row", async () => {
    // MEASURED, PostgreSQL 16.15, `zz_v8_ts(ts_id timestamp PRIMARY KEY)` holding
    // 2026-01-01 10:00:00.123456 and 10:00:00.654321, read through the real postgres
    // provider and applied through this hook.
    //
    // On the LIBRARY path `pg` hands the grid a Date and the new check refuses it before
    // the engine — that case is covered above. But the browser does not get a Date: the
    // rows reach it through `/api/db/query`, which is JSON, and `JSON.stringify(date)` is
    // an ISO STRING. A string is waved through as "its own text", the engine IS asked
    //   SELECT "ts_id", COUNT(*) FROM zz_v8_ts WHERE "ts_id" IN ($1, $2) GROUP BY "ts_id"
    // with '2026-01-01T07:00:00.123Z' — the local-time shift AND the lost microseconds —
    // it matches nothing, and the user is told:
    //   "some of the rows you edited are no longer in the table. Run the query again."
    // `SELECT count(*) FROM zz_v8_ts` answered 2 at that moment. The sentence is false and
    // the advice loops: the same query produces the same ISO string for ever.
    const seen = answerNothing();
    await applyKeyedBy("2026-01-01T07:00:00.123Z");

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).not.toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer in the table"),
    });
    expect(seen).toHaveLength(0);
  });

  test("a MySQL DATETIME(6) key over the wire is called a missing row too", async () => {
    // MEASURED, MySQL 8.4.11, `zz_v8_dt(d_id DATETIME(6) PRIMARY KEY)`. `mysql2` hands the
    // library path a Date — refused correctly — and the HTTP path the same ISO string,
    // which is asked about and matches nothing. Both rows were still in the table.
    const seen = answerNothing();
    await applyKeyedBy("2026-01-01T10:00:00.123Z", "mysql");

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).not.toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer in the table"),
    });
    expect(seen).toHaveLength(0);
  });

  test("a double precision key is refused with a reason that is not true of it", async () => {
    // MEASURED, PostgreSQL 16.15, `zz_v8_flt(f_id double precision PRIMARY KEY)` holding
    // 0.30000000000000004. The editor refuses before the engine with
    //   "in 1 row you edited it is a fractional number, which does not reach the table as
    //    the row holds it"
    // and that second half is false. `String(0.30000000000000004)` is the shortest decimal
    // that round-trips to the same double, PostgreSQL parses it back to the same double,
    // and `SELECT count(*) FROM zz_v8_flt WHERE f_id = 0.30000000000000004` answered 1.
    // The value reaches the table exactly as the row holds it.
    const seen = answerNothing();
    await applyKeyedBy(0.30000000000000004);

    expect(mockToastError).not.toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("does not reach the table as the row holds it"),
    });
    expect(seen).toHaveLength(1);
  });

  test("a double precision key is carried back whatever its decimals, because the result says so", async () => {
    // The other half of the same measurement. `zz40_flt(f_id double precision)` holding 1.5:
    // the column's declaration is the only thing that says how wide the engine reads the
    // decimal back, and at 64 bits `String()` of a JavaScript number IS the value the row
    // holds. Measured on PostgreSQL 16.15 and MySQL 8.4.11 - every one of 1.5, 0.1, 1e-7 and
    // 0.30000000000000004 answered one row through this hook's own bound-parameter path.
    const seen = countAsks();
    await applyKeyedBy(1.5, "postgres", "double precision");

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a MySQL FLOAT key in the shape its text protocol hands over is refused, and truthfully", async () => {
    // MEASURED, MySQL 8.4.11, `zz40_f(k FLOAT)` holding 0.1. mysql2's text protocol hands the
    // grid the double 0.1, the row holds the 32-bit 0.100000001490116..., and
    // `SELECT k FROM zz40_f WHERE k IN (0.1)` matched NOTHING - over `query()` and over
    // `execute()` alike. This one really cannot be addressed by the decimal in front of the
    // user, and `float` means 32 bits here and 64 in T-SQL, so the word settles nothing.
    const seen = countAsks();
    await applyKeyedBy(0.1, "mysql", "float");

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("it is a fractional number"),
    });
    // The half that has to be true of it: nothing here states the width, which is the fact.
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("nothing here says the column holds it as a 64-bit float"),
    });
  });

  test("the same FLOAT column over the binary protocol carries its own value back", async () => {
    // MEASURED, same table, same session: `execute()` hands that FLOAT over as the 17-digit
    // 0.10000000149011612 - the 32-bit value written out in full - and sending THAT back
    // matched the row. Nine significant digits is the most any 32-bit float needs, so a
    // longer decimal cannot be one, and this value can only have come from a 64-bit read.
    const seen = countAsks();
    await applyKeyedBy(0.10000000149011612, "mysql", "float");

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  // ── SQLite's REAL is the engine's only float, and it is 64 bits ───────────
  //
  // MEASURED 2026-09-18 through the real `createDatabaseProvider` path, on bun:sqlite
  // (Bun 1.4.0) and on libSQL server v0.24.33 over its HTTP pipeline:
  //
  //   sqlite   zz_real(r REAL, f FLOAT, d DOUBLE, dp DOUBLE PRECISION)
  //            decltypes REAL / FLOAT / DOUBLE / DOUBLE PRECISION, and
  //            typeof() answered `real` for every one of them
  //   libsql   the same table, the same four decltypes, the same four `real`s
  //
  // One storage class, and it is 8 bytes: SQLite has NO 32-bit float to hold these in.
  // 0.30000000000000004 was written and read back `=== 0.30000000000000004`, which no
  // 32-bit column can do, and `WHERE r = 1.5`, `WHERE f = 0.1`, `WHERE d =
  // 0.30000000000000004` and `WHERE dp = 0.1` each answered exactly ONE row on both.
  //
  // So on these two dialects the declaration DOES state the width, and the refusal's
  // sentence - "nothing here says the column holds it as a 64-bit float" - was false
  // about them. Measured before this changed, on a live `zz_live(k_id REAL PRIMARY KEY)`
  // holding 1.5 and 2.5: the engine answered one row for `WHERE "k_id" IN (1.5)` and the
  // editor refused the edit anyway, leaving the table untouched.
  test.each([
    ["sqlite", "REAL"],
    ["sqlite", "FLOAT"],
    ["sqlite", "DOUBLE"],
    ["sqlite", "DOUBLE PRECISION"],
    ["libsql", "REAL"],
    ["libsql", "FLOAT"],
  ] as const)("a %s %s key is carried back, because that engine has no other float width", async (type, declared) => {
    const seen = countAsks();
    await applyKeyedBy(1.5, type, declared);

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test.each([
    ["postgres", "real"],
    ["postgres", "float4"],
    ["mysql", "float"],
    ["duckdb", "REAL"],
    ["duckdb", "FLOAT"],
    ["trino", "real"],
  ] as const)("a %s %s key is still refused, because that word is 32 bits there", async (type, declared) => {
    // The other side, and why the dialect has to be read rather than the word. MEASURED
    // 2026-09-18 on the live engines:
    //
    //   PostgreSQL 16.15  `real` and `float4` are both spelled `real` by `pg`, both
    //                     `pg_column_size` 4, and `0.1::real::float8` is
    //                     0.10000000149011612 - NOT the double 0.1.
    //   MySQL 8.4.11      `zz_w(f FLOAT, d DOUBLE)` holding 0.1: `f = 0.1` answered
    //                     FALSE and `d = 0.1` answered TRUE, in the same row.
    //   DuckDB            `zz_flt(r REAL, f FLOAT, d DOUBLE)` holding 0.1: the driver
    //                     hands the two 32-bit columns over as 0.10000000149011612 and
    //                     the DOUBLE as 0.1, and `r::DOUBLE = 0.1` answered false.
    //   Trino             not measured here - no engine was reachable - so it keeps the
    //                     refusal, which is the closed side of the same rule.
    //
    // 1.5 is exact at both widths, which is the point: what is refused is the WIDTH the
    // decimal will be read back at, and on these dialects nothing in front of us states it.
    const seen = countAsks();
    await applyKeyedBy(1.5, type, declared);

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("nothing here says the column holds it as a 64-bit float"),
    });
  });

  test.each([
    ["sqlite", "TEXT"],
    ["sqlite", undefined],
    ["libsql", "NUMERIC"],
  ] as const)("a %s key declared %s is refused like any other, dialect or no dialect", async (type, declared) => {
    // The dialect widens WHICH WORDS state 64 bits; it does not wave a column through that
    // declared something else, or nothing at all. A SQLite column is dynamically typed, so
    // a `TEXT` or `NUMERIC` one really can be holding 1.5, and neither word says at what
    // width the engine will read the decimal back.
    const seen = countAsks();
    await applyKeyedBy(1.5, type, declared);

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("it is a fractional number"),
    });
  });

  // ── An exact decimal reaches the grid as a value the driver ROUNDED ──────
  //
  // MEASURED 2026-09-19 through this hook, on Oracle AI Database 26ai Free 23.26.3.0.0 and
  // SQL Server 2022 CU27 (16.0.4295.3):
  //
  //   oracle  zz969_frac(id NUMBER(20,4) PRIMARY KEY, note VARCHAR2(30)) holding
  //           1234567890123456.7891 and 1234567890123456.8. oracledb hands BOTH rows over
  //           as 1234567890123456.8, and `columnTypes` carries `NUMBER` for the key. With
  //           only the first row's note edited, the check asked `SELECT "ID", COUNT(*) ...
  //           WHERE "ID" IN (:1) GROUP BY "ID"`, Oracle answered ONE group holding ONE row,
  //           and `UPDATE ZZ969_FRAC SET "NOTE" = :1 WHERE "ID" = :2` wrote to
  //           `the-neighbour` - the row nobody edited - reported as "1 UPDATE statement
  //           accepted. The results are up to date."
  //   oracle  the same table declared NUMBER, holding .10000000000000000001 and .1: both
  //           rows arrive as the ONE-digit 0.1 and the UPDATE lands on the .1 row. One
  //           printed digit, the same wrong row - so the LENGTH of the decimal proves
  //           nothing here, and the declaration is what decides.
  //   mssql   zz969_num(id decimal(20,4) PRIMARY KEY, cash money) over the same pair: both
  //           rows arrive as 1234567890123456.8 and money's 922337203685477.5807 arrives as
  //           922337203685477.6. Sending that key back UPDATEd BOTH rows at once, because
  //           T-SQL widens the column to compare it with the float parameter.
  //
  // The rounding is the DRIVER's arithmetic and not one column's width: tedious computes
  // every decimal as `value / 10^scale` and every money as an int64 over 10000, and oracledb
  // reads NUMBER into a double.
  test.each([
    ["oracle", "NUMBER", 1234567890123456.8],
    ["oracle", "NUMBER", 0.1],
    ["oracle", "NUMBER", 1234.56],
    ["mssql", "decimal", 1234567890123456.8],
    ["mssql", "numeric", 1234.56],
    ["mssql", "money", 922337203685477.6],
  ] as const)("a %s %s key the driver rounded is refused before the engine is asked", async (type, declared, key) => {
    const seen = countAsks();
    await applyKeyedBy(key, type, declared);

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("it is a fractional number the driver rounded to fit"),
    });
    // The fact that is true of THIS value, and is not the 64-bit-float one: the column says
    // what it is, and what it is holds digits the number in front of the user cannot carry.
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("holds more digits than a 64-bit float carries"),
    });
  });

  test("an Oracle BINARY_DOUBLE key still carries its own fraction back", async () => {
    // The other half of the same Oracle session. `zz969_bd(id BINARY_DOUBLE PRIMARY KEY)`
    // holding 3.0000000000000004E-001 and 1.5E+000: oracledb hands the first over as
    // 0.30000000000000004, the check answered one group of one row, and the UPDATE changed
    // that row and no other. BINARY_DOUBLE is the one Oracle type that IS the width of a
    // JavaScript number, so the refusal above would be false about it.
    const seen = countAsks();
    await applyKeyedBy(0.30000000000000004, "oracle", "BINARY_DOUBLE");

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("an Oracle NUMBER key that is a whole number is written, which is what an Oracle key is", async () => {
    // Oracle's ordinary primary key is a NUMBER, and a whole one is not a rounding of
    // anything a double cannot hold. Measured on `zz969_int(id NUMBER(10) PRIMARY KEY)`
    // holding 42 and 43: the check answered one group of one row and the UPDATE changed the
    // 42 row alone. A rule that refused every NUMBER would take away every Oracle edit.
    const seen = countAsks();
    await applyKeyedBy(42, "oracle", "NUMBER");

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a SQLite DECIMAL key is still written, because that engine has no exact decimal", async () => {
    // MEASURED 2026-09-19 on bun:sqlite (Bun 1.4.0), `zz(k DECIMAL(20,4), n NUMERIC(20,4))`:
    // `pragma_table_info` reports both declarations back verbatim, `typeof()` answers `real`
    // for both, 1234567890123456.7891 comes back as the double 1234567890123456.8 - which is
    // what the file now holds rather than a rounding of it - and `WHERE k =
    // 1234567890123456.8` matched ONE row, its own. The word is an affinity there and states
    // nothing about digits the value does not carry.
    const seen = countAsks();
    await applyKeyedBy(1234567890123456.8, "sqlite", "DECIMAL(20,4)");

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test.each([
    ["postgres", "numeric"],
    ["mysql", "decimal"],
    ["duckdb", "DECIMAL(20,4)"],
  ] as const)("a %s %s key arrives as its own digits and is written", async (type, declared) => {
    // What those three drivers really hand over, measured 2026-09-19 on PostgreSQL 16.15
    // (`pg`), MySQL 8.4.11 (mysql2, over the text AND the binary protocol) and DuckDB 1.5.5
    // (`getRowObjectsJson()`, the call this provider reads): the STRING
    // "1234567890123456.7891", exact to the last digit, for a column declared
    // `numeric(20,4)` / `DECIMAL(20,4)`. Nothing rounded it, so the text is the row's own
    // identity and the rule above has nothing to say about it.
    const seen = countAsks();
    await applyKeyedBy("1234567890123456.7891", type, declared);

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test.each([
    ["postgres", "double precision", 1e21],
    ["postgres", "double precision", 1e300],
    ["mysql", "double", 1e21],
  ] as const)("a %s %s key carries its own value back however large it is", async (type, declared, key) => {
    // MEASURED 2026-09-18, and the defect this closes. `zz43_dbl(f_id double precision
    // PRIMARY KEY)` on PostgreSQL 16.15 and `zz43_dbl(f_id DOUBLE PRIMARY KEY)` on MySQL
    // 8.4.11, both holding 1e21, 1e300 and 3. The editor refused the first two with
    //   "it is a whole number past the range this editor carries exactly, which does not
    //    reach the table as the row holds it"
    // and BOTH halves are false about a `double precision` column: 1e21 and 1e300 are
    // doubles a 64-bit column holds exactly, nothing about them is out of range, and the
    // engines answered ONE row for each sent back through this hook's own bound-parameter
    // path - `WHERE "f_id" IN ($1)` with 1e21, and with 1e300. After the refusal was made
    // to read the DECLARED type rather than the magnitude, the same edit ran end to end on
    // both engines: the check asked, the UPDATE went out bound as the number, and the row
    // holding that key was the only row whose `note` changed.
    const seen = countAsks();
    await applyKeyedBy(key, type, declared);

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a BIGINT key past 2^53 is still refused, because that column is not a double", async () => {
    // The other side of the same distinction, and why it is the DECLARATION that decides.
    // MEASURED 2026-09-18 on `zz43_big(b_id BIGINT PRIMARY KEY)` holding 9007199254740993
    // and 9007199254740992: mysql2 on its own defaults - and `pg` with int8 parsed as a
    // number - hand the first row's key over as 9007199254740992, the SECOND row's key.
    // `SELECT ... WHERE b_id = 9007199254740992` answered that neighbouring row, so an
    // apply let through here would have rewritten a row nobody edited and reported success.
    const seen = countAsks();
    await applyKeyedBy(2 ** 53, "mysql", "bigint");

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("it is a whole number past the range this editor carries exactly"),
    });
  });

  test("a large whole number with no declared type at all stays refused", async () => {
    // Fail closed where nothing states the width. MEASURED: the same 1e21 row read with its
    // `columnTypes` stripped - the state a driver carrying no type metadata leaves a result
    // in - is refused, and it has to be: the identical JavaScript number reaches the grid
    // from a `double precision` column that holds it exactly and from a BIGINT the driver
    // rounded, and nothing in the value tells those two apart.
    const seen = countAsks();
    await applyKeyedBy(1e21);

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("it is a whole number past the range this editor carries exactly"),
    });
  });

  test("an empty binary value is binary data like any other", async () => {
    // MEASURED, PostgreSQL 16.15, `zz_v8_edge` holding decode('','hex'). `asBytes` reads
    // `{"type":"Buffer","data":[]}` as an empty Uint8Array, and the refusal names it.
    const seen = watchFetch();
    await applyKeyedBy({ type: "Buffer", data: [] });

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("in 1 row you edited it is binary data"),
    });
  });

  test("the short answer never asserts the rows were deleted", async () => {
    // MEASURED twice, and the point of #11: the same answer has two causes.
    //  - MySQL 8.4.11, `zz_v8_ci(c_id VARCHAR(20) COLLATE utf8mb4_0900_ai_ci)` holding
    //    'abc' and 'ABC'. Both rows present; the engine folds the two keys into one group
    //    of two. Nothing was deleted.
    //  - PostgreSQL 16.15, `zz_v8_dup` read with k_id 1 twice and k_id 2 once, k_id 2
    //    deleted afterwards. One group of two, and a row really has gone.
    // Both produced the same sentence, which is the only honest one: it names both.
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const bound = (body.params ?? []) as unknown[];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [{ id: bound[0], count: "2" }], fields: ["id", "count"], rowCount: 1 }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab({
          result: makeResult({
            rows: [
              { id: "abc", note: "one" },
              { id: "ABC", note: "two" },
            ],
            fields: ["id", "note"],
            rowCount: 2,
          }),
          resultQuery: "SELECT id, note FROM zz_v8_ci",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );
    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "note", originalValue: "one", newValue: "x" });
      result.current.handleCellChange({ rowIndex: 1, columnId: "note", originalValue: "two", newValue: "y" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("the engine answered for only 1 of those 2 keys"),
    });
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("a row gone since you read it, or two keys this engine reads as one"),
    });
    // It must not settle on the half that is false of the collation case.
    expect(mockToastError).not.toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer in the table"),
    });
  });

  // ── The COLUMN's declared type, not the value's shape (#4) ────────────────
  //
  // MEASURED 2026-09-18 against PostgreSQL 16.15 (`guide-pg`) and MySQL 8.4.11
  // (`guide-my`), reading the rows through the real provider and then through
  // `JSON.parse(JSON.stringify(result))` - which is exactly what `/api/db/query` delivers
  // and what the browser therefore holds. The declared types below are the ones those
  // responses really carried.

  /** What the engine is asked, and whether it was asked at all. */
  function countAsks(): { readonly length: number } {
    const seen: unknown[] = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body);
      const bound = (body.params ?? [1]) as unknown[];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: bound.map((key) => ({ id: key, count: "1" })),
            fields: ["id", "count"],
            rowCount: bound.length,
          }),
      });
    }) as unknown as typeof fetch;
    return seen;
  }

  test.each([
    ["postgres", "timestamp without time zone", "2026-01-01T10:00:00.123Z"],
    ["postgres", "timestamp with time zone", "2026-01-01T10:00:00.123Z"],
    ["mysql", "datetime", "2026-01-01T10:00:00.123Z"],
  ] as const)("a %s %s key is refused over the wire, before the engine", async (type, declared, key) => {
    // The defect this closes. All three columns really answered that ISO string over HTTP,
    // the string was waved through as its own text, the engine WAS asked, it matched
    // nothing, and the user was told "some of the rows you edited are no longer in the
    // table. Run the query again" - with `SELECT count(*)` answering 2 at that moment, and
    // with running the query again producing the identical string for ever.
    const seen = countAsks();
    await applyKeyedBy(key, type, declared);

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("in 1 row you edited it is a date and time"),
    });
    expect(mockToastError).not.toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer in the table"),
    });
  });
  // ── One word, two engines: an instant on SQLite and libsql is what the row holds ──
  //
  // MEASURED 2026-09-19 on bun:sqlite (Bun 1.4.0) and on libSQL server v0.24.33 over its
  // HTTP pipeline, with `zz_<decl>(k <decl> PRIMARY KEY, note TEXT)` built for each of
  // DATE, DATETIME and TIMESTAMP against each value shape below and the ISO text the next
  // test covers - 24 combinations across the two engines, every one the same.
  //
  // SQLite HAS NO DATE TYPE. The declaration picks no storage class, so `typeof(k)`
  // answered `text` for the two text forms and `integer` for the epoch;
  // `sqlite3_column_decltype` reported the declaration back verbatim, which is exactly
  // what reaches `columnTypes` here; and both drivers handed the value over UNCHANGED - a
  // string for the text forms, a JavaScript number for the epoch. Sending that same value
  // back answered ONE group holding ONE row every time, and the `UPDATE ... WHERE k = ?`
  // that followed changed exactly one row.
  //
  // So the value IS its own identity on these two, and the refusal's sentence - "it is a
  // date and time, which does not reach the table as the row holds it" - was false about
  // them. It was a regression as well as a falsehood: before `columnTypes` reached SQLite
  // at all the column read as `undeclared`, `'2024-01-15'` is not the shape a `Date` takes
  // through JSON, and the apply went through.
  test.each([
    ["sqlite", "DATE", "the text 2024-01-15", "2024-01-15"],
    ["sqlite", "DATE", "the text 2026-01-01 10:00:00.123", "2026-01-01 10:00:00.123"],
    ["sqlite", "DATE", "the integer epoch 1705276800", 1705276800],
    ["sqlite", "DATETIME", "the text 2024-01-15", "2024-01-15"],
    ["sqlite", "DATETIME", "the text 2026-01-01 10:00:00.123", "2026-01-01 10:00:00.123"],
    ["sqlite", "DATETIME", "the integer epoch 1705276800", 1705276800],
    ["sqlite", "TIMESTAMP", "the text 2024-01-15", "2024-01-15"],
    ["sqlite", "TIMESTAMP", "the text 2026-01-01 10:00:00.123", "2026-01-01 10:00:00.123"],
    ["sqlite", "TIMESTAMP", "the integer epoch 1705276800", 1705276800],
    ["libsql", "DATE", "the text 2024-01-15", "2024-01-15"],
    ["libsql", "DATE", "the text 2026-01-01 10:00:00.123", "2026-01-01 10:00:00.123"],
    ["libsql", "DATE", "the integer epoch 1705276800", 1705276800],
    ["libsql", "DATETIME", "the text 2024-01-15", "2024-01-15"],
    ["libsql", "DATETIME", "the text 2026-01-01 10:00:00.123", "2026-01-01 10:00:00.123"],
    ["libsql", "DATETIME", "the integer epoch 1705276800", 1705276800],
    ["libsql", "TIMESTAMP", "the text 2024-01-15", "2024-01-15"],
    ["libsql", "TIMESTAMP", "the text 2026-01-01 10:00:00.123", "2026-01-01 10:00:00.123"],
    ["libsql", "TIMESTAMP", "the integer epoch 1705276800", 1705276800],
  ] as const)(
    "a %s %s key holding %s is carried back, because that engine hands back what it stores",
    async (type, declared, _shape, key) => {
      const seen = countAsks();
      await applyKeyedBy(key, type, declared);

      expect(seen).toHaveLength(1);
      expect(updateCalls()).toHaveLength(1);
      expect(mockToastError).not.toHaveBeenCalled();
    },
  );

  test("a SQLite DATE column really holding ISO text is a key, declaration and all", async () => {
    // The shape that `isSerializedDate` exists to catch, in the one place it is not
    // evidence of anything: a SQLite `DATE` column holding the text
    // `2026-01-01T07:00:00.123Z`. Measured on bun:sqlite and on libSQL v0.24.33 -
    // `typeof(k)` answered `text`, the driver handed that string back character for
    // character, `WHERE k IN (?)` answered one group of one, and the UPDATE changed one
    // row. The declaration is read first, so the shape test is never reached here.
    const seen = countAsks();
    await applyKeyedBy("2026-01-01T07:00:00.123Z", "sqlite", "DATE");

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a Date object is still refused on SQLite, dialect or no dialect", async () => {
    // The dialect widens nothing about a value whose text is a RENDERING. Neither
    // bun:sqlite nor libsql ever hands a `Date` back - they answer text, integer, real,
    // blob or null - so this is the embeddable shell's host handing one in, and
    // `String(date)` has no fractional seconds at all. The closed side stays closed.
    const seen = countAsks();
    await applyKeyedBy(new Date("2026-01-01T07:00:00.123Z"), "sqlite", "DATE");

    expect(seen).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("in 1 row you edited it is a date and time"),
    });
  });

  test("a date key declared by the engine is refused whatever shape the driver chose", async () => {
    // The declaration is the fact; the value's shape is only ever evidence. `mysql2` run
    // with `dateStrings` hands a DATETIME back as the engine's own spelling, which no ISO
    // test would ever match - and the column is still a column this editor cannot key on.
    const seen = countAsks();
    await applyKeyedBy("2026-01-01 10:00:00.123456", "mysql", "datetime");

    expect(seen).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("in 1 row you edited it is a date and time"),
    });
  });

  test("a text key holding the exact text of a serialized date is still a key", async () => {
    // The case the fix must not break, and the reason it reads the DECLARATION first:
    // PostgreSQL `text` really holding `2026-01-01T07:00:00.123Z`. Measured end to end
    // against `zz_a9_txt` - the UPDATE went out, the engine took it, and reading the table
    // back showed the new value on that row and no other.
    const seen = countAsks();
    await applyKeyedBy("2026-01-01T07:00:00.123Z", "postgres", "text");

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test.each([["2024-01-15T10:30:00Z"], ["2024-01-15"], ["2024-01-15 10:30:00"], ["2026-02-30T00:00:00.000Z"]])(
    "an undeclared key holding %s is a key, not a date",
    async (key) => {
      // Where the result declares nothing, the shape a `Date` takes through JSON is all
      // there is to read - and it is read EXACTLY. None of these is that shape: the first
      // three carry no three-digit fraction, and the fourth is a day no `Date` would ever
      // print, since `new Date` rolls it forward to 2026-03-02.
      const seen = countAsks();
      await applyKeyedBy(key);

      expect(seen).toHaveLength(1);
      expect(updateCalls()).toHaveLength(1);
      expect(mockToastError).not.toHaveBeenCalled();
    },
  );

  test("a daterange key is not read as a date", async () => {
    // The type's FIRST WORD, never a substring of it. PostgreSQL's `daterange`, `tsrange`
    // and `tstzrange` all render as text whose text is their identity, and a
    // `.includes("date")` would take three working keys away to catch one broken one.
    const seen = countAsks();
    await applyKeyedBy("[2024-01-01,2024-02-01)", "postgres", "daterange");

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a time-of-day key is not read as a date either", async () => {
    // `pg` and `mysql2` both hand a time back as the string the engine prints, which is
    // its own identity and matches when it is sent back. Refusing it would take away a
    // key that works, so `time` is deliberately outside the set.
    const seen = countAsks();
    await applyKeyedBy("10:00:00", "postgres", "time without time zone");

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a wrapped ClickHouse DateTime64 is read through its wrappers", async () => {
    // ClickHouse spells a nullable column by WRAPPING the real type, so the wrappers come
    // off before the first word is read.
    const seen = countAsks();
    await applyKeyedBy("2026-01-01 10:00:00.123456", "clickhouse", "Nullable(DateTime64(6, 'UTC'))");

    expect(seen).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("in 1 row you edited it is a date and time"),
    });
  });

  test("a column called constructor declares nothing rather than inheriting one", async () => {
    // `columnTypes` arrives through `JSON.parse`, so it carries `Object.prototype`, and
    // `SELECT 1 AS constructor` is legal SQL. A plain property read would answer with the
    // prototype's own `constructor` - a function - for a column nothing declared.
    const seen = countAsks();
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            rows: [{ constructor_id: "2024-01-15T10:30:00Z", note: "first" }],
            fields: ["constructor_id", "note"],
            rowCount: 1,
            columnTypes: {},
          }),
          resultQuery: "SELECT constructor_id, note FROM keyed",
        }),
        executeQuery: mockExecuteQuery,
      }),
    );
    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "note", originalValue: "first", newValue: "changed" });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(seen).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
