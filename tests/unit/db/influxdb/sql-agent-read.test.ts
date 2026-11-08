/**
 * The `influxdb3` agent read-only profile's own rules (`sql-agent-read.ts`): the checked server line, the `system`
 * schema fence, the response cap taken from the byte budget, the strict shaping of an answer against the budget, and
 * the budget refusals a failed request becomes.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { InfluxAnswerShapeError } from "@/lib/db/providers/timeseries/influxdb/errors";
import {
  AGENT_ENVELOPE_ALLOWANCE_BYTES,
  AGENT_WIRE_EXPANSION,
  agentReadFailure,
  agentResponseCap,
  assertCheckedServer,
  assertNoSystemTable,
  INFLUXDB3_CHECKED_RELEASES,
  shapeAgentAnswer,
} from "@/lib/db/providers/timeseries/influxdb/sql-agent-read";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";

const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 3, maxResultBytes: 1_000 };

function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("assertCheckedServer", () => {
  test("admits the checked Core line, whatever its patch release", () => {
    expect(INFLUXDB3_CHECKED_RELEASES).toEqual(["3.12"]);
    expect(() => assertCheckedServer({ generation: "v3", reported: "3.12.0", build: "Core" })).not.toThrow();
    expect(() => assertCheckedServer({ generation: "v3", reported: "v3.12.4", build: "Core" })).not.toThrow();
  });

  test.each([
    ["another line", { generation: "v3", reported: "3.13.0", build: "Core" }, "this server is InfluxDB 3 Core 3.13.0"],
    ["Enterprise", { generation: "v3", reported: "3.12.0", build: "Enterprise" }, "InfluxDB 3 Enterprise 3.12.0"],
    ["no version", { generation: "v3", reported: null, build: null }, "this server reports no version"],
    ["no build", { generation: "v3", reported: "3.12.0", build: null }, "this server reports no version"],
  ] as const)("refuses %s as an unsupported target", (_name, version, says) => {
    const error = thrown(() => assertCheckedServer(version));
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain(says);
    expect(error.message).toContain("checked on InfluxDB 3 Core 3.12");
  });
});

describe("assertNoSystemTable", () => {
  test.each([
    "SELECT * FROM system.queries",
    "SELECT * FROM SYSTEM.QUERIES",
    'SELECT * FROM "system"."queries"',
    'SELECT * FROM "SYSTEM".queries',
    "SELECT * FROM public.system.parquet_files",
    "SELECT * FROM system /* c */ . -- d\n last_caches",
    "DESCRIBE system.queries",
    "SHOW COLUMNS FROM system.processing_engine_logs",
    "SELECT [1][1] AS a FROM system.queries",
    "SELECT [(SELECT count(*) FROM system.queries)][1] AS n",
    "SELECT [[(SELECT count(*) FROM system.parquet_files)]][1][1] AS n",
    "WITH q AS (SELECT * FROM system.queries) SELECT * FROM q",
    "SELECT * FROM system.influxdb_schemas",
    'SELECT * FROM system."influxdb_schema "',
    "SELECT * FROM system.",
  ])("refuses %s, naming the one system table it reads", (sql) => {
    const error = thrown(() => assertNoSystemTable(sql));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "The agent reads no table of InfluxDB 3's system schema but system.influxdb_schema: the others hold other queries' text, files and engine logs",
    );
  });

  test.each([
    "SELECT * FROM system.influxdb_schema WHERE measurement = 'home'",
    'SELECT * FROM "system"."influxdb_schema"',
    "SELECT * FROM SYSTEM.INFLUXDB_SCHEMA",
    "SELECT system.influxdb_schema.key FROM system.influxdb_schema",
    "SELECT 'system.queries' AS a",
    'SELECT "system.queries" FROM home',
    "SELECT * FROM home -- system.queries",
    "SELECT * FROM home /* system.queries */",
    "SELECT system FROM home",
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'system'",
    "SELECT 1.5 AS system",
    "SELECT * FROM my_system.queries",
    "SELECT 'a' AS x, 'b.c' AS y FROM home WHERE room = 'Kitchen'",
    "SELECT 'system' AS s",
  ])("admits %s", (sql) => {
    expect(() => assertNoSystemTable(sql)).not.toThrow();
  });

  // DataFusion reads a string before a `.` as a name: `'system'.queries` is answered with the rows of system.queries.
  test.each([
    "SELECT query_text FROM 'system'.queries",
    "SELECT query_text FROM 'system'.'queries'",
    "SELECT query_text FROM public.'system'.queries",
    "SELECT query_text FROM 'public'.'system'.'queries'",
    "SELECT query_text FROM 'system'.\"queries\"",
    "SELECT * FROM 'SYSTEM' /* c */ . parquet_files",
    "SELECT * FROM 'sys''tem'.queries",
    "SELECT * FROM E'\\x73ystem'.queries",
    "SELECT * FROM 'public'.home",
    "SELECT * FROM 'system'.influxdb_schema",
    "SELECT * FROM $$system$$.queries",
  ])("refuses %s, a string before a `.`", (sql) => {
    const error = thrown(() => assertNoSystemTable(sql));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "The agent reads no name written as a string before a `.`, since InfluxDB 3 reads it as a schema or table name and the system schema fence reads only names: write the name bare or in double quotes",
    );
  });
});

describe("agentResponseCap", () => {
  test("is the byte budget times the wire's expansion, plus the envelope", () => {
    expect(AGENT_WIRE_EXPANSION).toBe(3);
    expect(AGENT_ENVELOPE_ALLOWANCE_BYTES).toBe(64 * 1024);
    expect(agentResponseCap(BUDGET)).toBe(3_000 + 64 * 1024);
  });
});

describe("shapeAgentAnswer", () => {
  test("an answer within every bound is its fields and rows", () => {
    expect(shapeAgentAnswer('{"a":1}\n{"a":2,"b":"x"}\n', BUDGET, "SELECT 1")).toEqual({
      fields: ["a", "b"],
      rows: [
        { a: 1, b: null },
        { a: 2, b: "x" },
      ],
    });
  });

  test("a row past the row budget is refused with the shared sentence and the answer's own row count", () => {
    const error = thrown(() => shapeAgentAnswer('{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n{"a":5}\n', BUDGET, "q"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe("Read-only execution exceeded the row budget: 5 rows > 3 allowed");
  });

  test("a row past the cell budget is refused as the row budget at the answer's width", () => {
    const wide = `{${Array.from({ length: 250 }, (_, column) => `"c${column}":1`).join(",")}}`;
    const body = Array.from({ length: 1_001 }, () => wide).join("\n");
    const error = thrown(() =>
      shapeAgentAnswer(body, { statementTimeoutMs: 5_000, maxResultRows: 5_000, maxResultBytes: 10_000_000 }, "q"),
    );
    expect(error.message).toBe("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed");
  });

  test("an answer past the byte budget is refused with the bytes the rows measure", () => {
    const error = thrown(() => shapeAgentAnswer(`{"a":"${"x".repeat(2_000)}"}\n`, BUDGET, "q"));
    expect(error.message).toBe("Read-only execution exceeded the byte budget: 2010 bytes > 1000 allowed");
  });

  test("a line that is not a row is the shaping error, never a budget refusal", () => {
    expect(thrown(() => shapeAgentAnswer("not json\n", BUDGET, "q"))).toBeInstanceOf(InfluxAnswerShapeError);
  });
});

describe("agentReadFailure", () => {
  test("an answer past the response cap is the byte refusal, at least one byte past the cap", () => {
    const error = agentReadFailure(new TransportError("too-large", "too large"), BUDGET, "q");
    expect(error).toBeInstanceOf(QueryError);
    expect(error?.message).toBe(
      `Read-only execution exceeded the byte budget: ${agentResponseCap(BUDGET) + 1} bytes > 1000 allowed`,
    );
  });

  test("a request past its deadline is the time refusal", () => {
    const error = agentReadFailure(new TransportError("timeout", "timed out"), BUDGET, "q");
    expect(error?.message).toBe("Read-only execution exceeded the time budget: no answer within 5000ms");
  });

  test("anything else is left to the provider's error table", () => {
    expect(agentReadFailure(new TransportError("network", "reset"), BUDGET, "q")).toBeUndefined();
    expect(agentReadFailure(new Error("other"), BUDGET, "q")).toBeUndefined();
  });
});
