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

  beforeEach(() => {
    mockExecuteQuery = mock(() => {});
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

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

    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);

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

    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);

    const sent = (mockExecuteQuery as ReturnType<typeof mock>).mock.calls.map((call) => call[0] as string);
    for (const sql of sent) {
      expect(sql).not.toContain("\n");
      expect(sql.match(/UPDATE/g)).toHaveLength(1);
      expect(sql.endsWith(";")).toBe(false);
    }
    expect(sent[0]).toBe(`UPDATE users SET "name" = $1 WHERE "id" = $2`);
    expect(sent[1]).toBe(`UPDATE users SET "email" = $1 WHERE "id" = $2`);
    // Each row carries its own parameters, so a shared statement text is not a
    // shared payload: placeholder numbering restarts per request.
    const options = (mockExecuteQuery as ReturnType<typeof mock>).mock.calls.map((call) => call[3]);
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

    const calls = (mockExecuteQuery as ReturnType<typeof mock>).mock.calls;
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

    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    const sql = mockExecuteQuery.mock.calls[0][0] as string;
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

  test("refuses to apply when the table name could not be read as an identifier", async () => {
    // The table name is GUESSED from the tab name or a FROM match, so unlike a
    // column it cannot be quoted safely: quoting a hand-typed lowercase name would
    // break Oracle, where the real table is upper-cased. An unusable guess is
    // therefore refused rather than interpolated.
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
        currentTab: makeTab({ name: "public.users" }),
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
});
