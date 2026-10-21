/**
 * The inline edit output of every engine, rendered as text beside the value lines.
 *
 * Each case is one apply through `useInlineEditing`, the way the grid drives it: one cell
 * change on row 0, then `handleApplyChanges`. A line records the key check request the
 * apply sent, every `executeQuery` call it made and every toast it raised, so a golden
 * diff shows a moved bound edit, a moved key refusal or a moved key check alike.
 *
 * `INLINE_EDITS` edits a column `v` carrying the declaration, under an `integer` key `id`
 * of 1. `KEY_CASES` edits a `text` column under a key `id` carrying the declaration and
 * the key value. The no-connection key renders with `activeConnection: null`.
 *
 * The DOM and the sonner mock are imported here rather than preloaded, because the
 * isolation test renders this file from a `bun -e` subprocess, which has no preload. The
 * hook is imported only after the mock has run: a static import links the real `sonner`
 * before `mock.module` replaces it, and the toasts then never reach the mock.
 */
import "../../../setup-dom";
import { mockToastDefault, mockToastError, mockToastSuccess } from "../../../helpers/mock-sonner";

import { act, renderHook } from "@testing-library/react";
import type { DatabaseConnection, DatabaseType, QueryTab } from "@/lib/types";

/** Reaches every arm of the Oracle bound edit and the SQL Server datetime binding. */
export const INLINE_EDITS: ReadonlyArray<readonly [declared: string | undefined, text: string]> = [
  ["DATE", "2026-10-04 12:34:56"],
  ["DATE", "2026-10-04 12:34:56.5"],
  ["DATE", "-0044-03-15 12:00:00"],
  ["date", "2026-10-04 12:34:56"],
  ["TIMESTAMP", "2026-10-04 12:34:56"],
  ["TIMESTAMP(6)", "2026-10-04 12:34:56.123456"],
  ["TIMESTAMP", "2026-10-04T09:34:56.123Z"],
  ["TIMESTAMP(6) WITH TIME ZONE", "2026-10-04T09:34:56.123Z"],
  ["TIMESTAMP WITH LOCAL TIME ZONE", "2026-10-04T09:34:56.123Z"],
  ["TIMESTAMP WITH TIME ZONE", "2026-02-30T00:00:00.000Z"],
  ["VARCHAR2(30)", "2026-10-04 12:34:56"],
  ["datetime", "2026-10-04 12:34:57.123"],
  ["DATETIME", "2026-10-04 12:34:57"],
  ["smalldatetime", "2026-10-04 12:34:00"],
  ["Nullable(datetime)", "2026-10-04 12:34:57"],
  ["datetime2", "2026-10-04 12:34:57.123"],
  ["datetime", "2026-10-04 12:34:57.1234"],
  ["datetime", "2026-10-04"],
  ["timestamp with time zone", "2026-10-04 12:34:56+00"],
  [undefined, "2026-10-04 12:34:56"],
  ["text", "it's \\ x"],
  ["text", "NULL"],
  ["text", ""],
];

/** Reaches every key column kind on both sides of the sqlite and libsql sets, and every key refusal. */
export const KEY_CASES: ReadonlyArray<readonly [declared: string | undefined, key: unknown]> = [
  ["timestamp", "2026-01-01 10:00:00.123"],
  ["DATE", "2024-01-15"],
  ["datetime2", "2026-01-01 10:00:00"],
  ["Nullable(DateTime64(6, 'UTC'))", "2026-01-01 10:00:00.123456"],
  ["timestamptz", "2026-01-01T07:00:00.123Z"],
  ["timestamp", new Date("2026-01-01T00:00:00.000Z")],
  ["daterange", "[2024-01-01,2024-02-01)"],
  ["double precision", 0.30000000000000004],
  ["BINARY_DOUBLE", 0.1],
  ["real", 0.1],
  ["float", 0.1],
  ["NUMBER(20,4)", 1234567890123456.8],
  ["NUMBER", 0.1],
  ["decimal(9,2)", 1.5],
  ["DECIMAL(20,4)", 1234567890123456.8],
  ["money", 922337203685477.6],
  ["integer", 9007199254740992],
  ["integer", 42],
  ["DATE", 2460324.75],
  [undefined, 0.1],
  ["text", "abc"],
];

const { useInlineEditing } = await import("@/hooks/use-inline-editing");

const QUERY = "SELECT id, v FROM t";

/** The value the edited cell held before the change, unequal to every edited text. */
const ORIGINAL = "old";

const show = (value: unknown): string =>
  value === undefined
    ? "undefined"
    : value instanceof Date
      ? `new Date(${JSON.stringify(value.toISOString())})`
      : JSON.stringify(value);

interface Case {
  readonly key: unknown;
  readonly text: string;
  readonly columnTypes: Record<string, string>;
}

/** The key check as `tests/hooks/use-inline-editing.test.ts` answers it: one row per bound key. */
function answerKeyCheck(requests: unknown[]): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ sql: body.sql, params: body.params ?? null });
    const bound = (body.params ?? [1]) as unknown[];
    const answer = bound.map((key) => ({ id: key, key_rows: "1" }));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ rows: answer, fields: ["id", "key_rows"], rowCount: answer.length }),
    });
  }) as unknown as typeof fetch;
}

async function applyOne(type: string | undefined, { key, text, columnTypes }: Case): Promise<string> {
  const activeConnection: DatabaseConnection | null =
    type === undefined
      ? null
      : {
          id: "conn-1",
          name: "Test DB",
          type: type as DatabaseType,
          host: "localhost",
          port: 5432,
          database: "testdb",
          user: "admin",
          password: "secret",
          createdAt: new Date("2026-01-01"),
        };
  const currentTab: QueryTab = {
    id: "tab-1",
    name: "t",
    query: QUERY,
    resultQuery: QUERY,
    result: { rows: [{ id: key, v: ORIGINAL }], fields: ["id", "v"], rowCount: 1, executionTime: 1, columnTypes },
    isExecuting: false,
    type: "sql",
  };
  const calls: unknown[] = [];
  const executeQuery = (
    sql: string,
    _tabId?: string,
    _isExplain?: boolean,
    options?: { skipSafety?: boolean; params?: unknown[] },
  ): Promise<void> => {
    calls.push([sql, options?.params ?? null]);
    return Promise.resolve(undefined);
  };
  const requests: unknown[] = [];
  for (const toast of [mockToastDefault, mockToastSuccess, mockToastError]) toast.mockClear();
  const realFetch = globalThis.fetch;
  globalThis.fetch = answerKeyCheck(requests);
  try {
    const { result, unmount } = renderHook(() => useInlineEditing({ activeConnection, currentTab, executeQuery }));
    act(() => {
      result.current.handleCellChange({ rowIndex: 0, columnId: "v", originalValue: ORIGINAL, newValue: text });
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });
    unmount();
  } finally {
    globalThis.fetch = realFetch;
  }
  if (requests.length > 1) throw new Error(`one apply sent ${requests.length} key check requests`);
  const toasts: unknown[] = [];
  for (const [kind, toast] of [
    ["default", mockToastDefault],
    ["success", mockToastSuccess],
    ["error", mockToastError],
  ] as const) {
    for (const [title, options] of toast.mock.calls as unknown as Array<[string?, { description?: string }?]>) {
      toasts.push([kind, title, options?.description ?? null]);
    }
    toast.mockClear();
  }
  return JSON.stringify({ keyCheck: requests[0] ?? null, calls, toasts });
}

/** One line per inline edit case and per key case, for one golden key. */
export async function renderInlineEditGolden(type: string | undefined): Promise<string> {
  const lines: string[] = [];
  const t = show(type);
  for (const [declared, text] of INLINE_EDITS) {
    const columnTypes: Record<string, string> = { id: "integer" };
    if (declared !== undefined) columnTypes.v = declared;
    // oxlint-disable-next-line no-await-in-loop -- one case at a time: every case replaces the same global fetch and reads the same toast mocks.
    const rendered = await applyOne(type, { key: 1, text, columnTypes });
    lines.push(`edit(${show(declared)}, ${show(text)}, ${t}) => ${rendered}`);
  }
  for (const [declared, key] of KEY_CASES) {
    const columnTypes: Record<string, string> = { v: "text" };
    if (declared !== undefined) columnTypes.id = declared;
    // oxlint-disable-next-line no-await-in-loop -- one case at a time: every case replaces the same global fetch and reads the same toast mocks.
    const rendered = await applyOne(type, { key, text: "x", columnTypes });
    lines.push(`key(${show(declared)}, ${show(key)}, ${t}) => ${rendered}`);
  }
  return `${lines.join("\n")}\n`;
}
