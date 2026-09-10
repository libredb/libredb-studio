import { describe, expect, test } from "bun:test";
import { queryHistoryText } from "@/lib/export/query-history";
import type { QueryHistoryItem } from "@/lib/types";

const headers = "Executed At,Status,Connection,Tab,Execution Time (ms),Rows,Query,Error";
const item: QueryHistoryItem = {
  id: "history-1",
  connectionId: "conn-1",
  query: "SELECT 1;",
  executionTime: 0,
  status: "success",
  executedAt: new Date("2026-09-01T10:20:30Z"),
};

describe("queryHistoryText", () => {
  test("empty CSV retains all eight headers", () => {
    expect(queryHistoryText([], "csv")).toBe(headers);
  });

  test("CSV keeps commas, quotes, newlines and Unicode in their original columns", () => {
    const row = {
      ...item,
      connectionName: '数据库,"prod"',
      tabName: "Tab\nOne",
      query: 'SELECT "雪",\n42;',
      rowCount: 2,
      errorMessage: "failure",
      status: "error" as const,
    };
    expect(queryHistoryText([row], "csv")).toBe(
      headers + '\n2026-09-01T10:20:30.000Z,error,"数据库,""prod""","Tab\nOne",0,2,"SELECT ""雪"",\n42;",failure',
    );
  });

  test("CSV uses the connection ID and empty optional fields while preserving zero", () => {
    expect(queryHistoryText([item], "csv")).toBe(headers + "\n2026-09-01T10:20:30.000Z,success,conn-1,,0,0,SELECT 1;,");
  });

  test("CSV neutralizes formula prefixes in connection, tab, query and error fields", () => {
    const row = { ...item, connectionName: "=db", tabName: "@tab", query: "+query", errorMessage: "-error" };
    expect(queryHistoryText([row], "csv")).toBe(
      headers + '\n2026-09-01T10:20:30.000Z,success,"\'=db","\'@tab",0,0,"\'+query","\'-error"',
    );
  });

  test("empty JSON is an empty array", () => {
    expect(queryHistoryText([], "json")).toBe("[]");
  });

  test("JSON preserves the complete records and dates with two-space indentation", () => {
    expect(queryHistoryText([item], "json")).toBe(JSON.stringify([item], null, 2));
  });

  test("JSON writes bigint metadata without throwing", () => {
    const row = { ...item, extra: { large: BigInt("9007199254740993") } };
    expect(JSON.parse(queryHistoryText([row], "json"))[0].extra.large).toBe("9007199254740993");
  });

  test("JSON names cyclic metadata and retains the rest of the record", () => {
    const extra: { self?: unknown } = {};
    extra.self = extra;
    const row = { ...item, extra };
    expect(JSON.parse(queryHistoryText([row], "json"))[0]).toEqual({
      ...item,
      executedAt: item.executedAt.toISOString(),
      extra: { self: "[Circular]" },
    });
  });
});
