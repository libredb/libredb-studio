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
    // whatever the query aliased it to, so it reaches SQL as arbitrary text.
    expect(sql).toContain(`"name" = 'Alice Updated'`);
    expect(sql).toContain(`WHERE "id" = 1`);

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
    expect(sent[0]).toBe(`UPDATE users SET "name" = 'Alice Updated' WHERE "id" = 1`);
    expect(sent[1]).toBe(`UPDATE users SET "email" = 'bob@new.test' WHERE "id" = 2`);
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
      expect(call[3]).toEqual({ skipSafety: true });
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
    expect(order).toEqual([`start:UPDATE users SET "name" = 'A2' WHERE "id" = 1`]);

    await act(async () => {
      resolveFirst?.();
      await applied;
    });

    expect(order).toEqual([
      `start:UPDATE users SET "name" = 'A2' WHERE "id" = 1`,
      `end:UPDATE users SET "name" = 'A2' WHERE "id" = 1`,
      `start:UPDATE users SET "name" = 'B2' WHERE "id" = 2`,
      `end:UPDATE users SET "name" = 'B2' WHERE "id" = 2`,
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
    expect(sql).toBe(`UPDATE users SET "${hostile}" = 'w' WHERE "id" = 1`);
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

    expect(mockExecuteQuery.mock.calls[0][0]).toBe("UPDATE users SET `first name` = 'Bob' WHERE `id` = 1");
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

    expect(mockExecuteQuery.mock.calls[0][0]).toBe(`UPDATE public.users SET "name" = 'Alice Updated' WHERE "id" = 1`);
  });
});
