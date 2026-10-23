import { describe, test, expect } from "bun:test";
import { isDangerousQuery } from "@/components/QuerySafetyDialog";
import { inspectAgentStatement } from "@/lib/db/operations/statement-guard";
import { Db2Provider } from "@/lib/db/providers/sql/db2";
import { MSSQLProvider } from "@/lib/db/providers/sql/mssql";
import { applyQueryLimit } from "@/lib/db/utils/query-limiter";
import { checkReadOnlyStatement } from "@/lib/mcp/guards/execution-fence";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { hasLoneCarriageReturnInLineComment } from "@/lib/sql/spans";
import { readStatementEnd } from "@/lib/sql/statement-end";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/**
 * A lone carriage return inside a `--` comment ends the comment on some engines and is comment text on others, and one
 * connection type can reach servers from both groups (the measured list is in docs/editor/query-optimization.md). So
 * the text is ambiguous whatever the grammar row says, and every safety decision fails closed on it: the editor gate
 * asks, the agent guard refuses, the EXPLAIN check counts it as more than one statement, and the limiter leaves it
 * unbounded. Each case below runs under every type here, Spark's row (which ends the comment at the carriage return)
 * and the dialect-less reading among them.
 */
const TYPES: readonly (DatabaseType | undefined)[] = [
  undefined,
  "postgres",
  "mssql",
  "mysql",
  "sqlite",
  "duckdb",
  "cassandra",
  "spark",
];

// Code after the carriage return that a reading which ends the comment there runs, while a reading that keeps the
// comment to the line feed sees none of it.
const CODE_AFTER_CR = [
  "SELECT 1 -- x\r; DELETE FROM t",
  "-- x\rDELETE FROM t",
  "WITH a AS (SELECT 1) -- x\r, b AS (DELETE FROM t RETURNING 1) SELECT * FROM a",
  // A space outside ASCII is not whitespace to every engine: measured, SQL Server 2022 runs the DELETE after U+00A0,
  // U+2028 or U+3000, and PostgreSQL 17.6 reads U+00A0 as part of a name.
  "SELECT 1 -- x\r ; DELETE FROM t",
  "SELECT 1 -- x\r ; DELETE FROM t",
  "SELECT 1 -- x\r　DELETE FROM t",
];

// The other direction: after the carriage return a run opens that, under a reading which ends the comment there, hides
// the write written after the line feed, which a reading that keeps the comment to the line feed runs.
const RUN_OPENED_AFTER_CR = [
  "SELECT 1 -- x\r/*\n; DELETE FROM t -- */",
  "SELECT 1 -- x\r'\n; DELETE FROM t -- '",
  "SELECT 1 -- x\r$$\n; DELETE FROM t -- $$",
  'SELECT 1 -- x\r"\n; DELETE FROM t -- "',
];

const AMBIGUOUS = [...CODE_AFTER_CR, ...RUN_OPENED_AFTER_CR, "SELECT id FROM t -- note\rWHERE id = 1"];

// A carriage return the engines all read alike: one paired with its line feed, one inside a literal or a block
// comment, one outside any comment, and one with nothing but whitespace after it in the comment.
const UNAMBIGUOUS = [
  "SELECT id FROM t -- note\r\nWHERE id = 1",
  "SELECT '-- a\rb' AS s FROM t",
  "SELECT 1 /* a\rb */ FROM t",
  "SELECT 1\r, 2 FROM t",
  "SELECT 1 FROM t -- note\r",
  "SELECT 1 FROM t -- note\r \r\n",
];

const label = (type: DatabaseType | undefined) => type ?? "no dialect";

describe("hasLoneCarriageReturnInLineComment", () => {
  for (const type of TYPES) {
    test(`${label(type)}: finds each ambiguous text`, () => {
      for (const sql of AMBIGUOUS) expect(hasLoneCarriageReturnInLineComment(sql, resolveSqlGrammar(type))).toBe(true);
    });

    test(`${label(type)}: passes each text the engines read alike`, () => {
      for (const sql of UNAMBIGUOUS) {
        expect(hasLoneCarriageReturnInLineComment(sql, resolveSqlGrammar(type))).toBe(false);
      }
    });
  }

  test("the default grammar is the dialect-less reading", () => {
    expect(hasLoneCarriageReturnInLineComment(CODE_AFTER_CR[0])).toBe(true);
    expect(hasLoneCarriageReturnInLineComment(UNAMBIGUOUS[0])).toBe(false);
  });
});

describe("the confirmation gate asks about such a text", () => {
  for (const type of TYPES) {
    test(`${label(type)}: asks`, () => {
      for (const sql of AMBIGUOUS) expect(isDangerousQuery(sql, type)).toBe(true);
    });

    test(`${label(type)}: asks nothing about a carriage return the engines read alike`, () => {
      for (const sql of UNAMBIGUOUS) expect(isDangerousQuery(sql, type)).toBe(false);
    });
  }
});

describe("the agent and MCP statement guard refuses such a text", () => {
  test.each(AMBIGUOUS)("refuses %p", (sql) => {
    expect(inspectAgentStatement(sql)).toBe("DIALECT_AMBIGUOUS_TEXT");
    expect(inspectAgentStatement(sql, { allowPlanExecution: true })).toBe("DIALECT_AMBIGUOUS_TEXT");
    expect(checkReadOnlyStatement(sql)).toBe("DIALECT_AMBIGUOUS_TEXT");
  });

  test.each(UNAMBIGUOUS)("admits %p", (sql) => {
    expect(inspectAgentStatement(sql)).toBeNull();
  });
});

describe("the row limiter leaves such a text unbounded rather than place a bound in it", () => {
  const READS = ["SELECT id FROM t -- note\rWHERE id = 1", "SELECT id FROM t -- note\r/*\nWHERE id = 1 -- */"];

  test("the statement's end may not be cut", () => {
    for (const sql of READS) expect(readStatementEnd(sql, resolveSqlGrammar("postgres")).rewritable).toBe(false);
    expect(readStatementEnd(UNAMBIGUOUS[0], resolveSqlGrammar("postgres")).rewritable).toBe(true);
  });

  for (const type of TYPES) {
    test(`${label(type)}: the text comes back unchanged and not limited`, () => {
      for (const sql of READS) {
        for (const offset of [0, 100]) {
          const limited = applyQueryLimit(sql, 50, offset, {}, type);
          expect(limited.sql).toBe(sql);
          expect(limited.wasLimited).toBe(false);
        }
      }
    });
  }

  test("a comment ended by CR LF is still bounded after it", () => {
    expect(applyQueryLimit(UNAMBIGUOUS[0], 50, 0, {}, "postgres").sql).toBe(
      "SELECT id FROM t -- note\r\nWHERE id = 1 LIMIT 50",
    );
  });

  const connection = (type: DatabaseType) =>
    ({ id: "c", name: "c", type, host: "h", port: 1, user: "u", password: "p", database: "d" }) as DatabaseConnection;

  test("SQL Server and Db2 reach the same decision in their own clause builders", () => {
    const providers = [new MSSQLProvider(connection("mssql")), new Db2Provider(connection("db2"))];
    for (const provider of providers) {
      for (const sql of READS) {
        for (const offset of [0, 100]) {
          expect(provider.prepareQuery(sql, { limit: 50, offset })).toEqual({
            query: sql,
            wasLimited: false,
            limit: 50,
            offset,
          });
        }
      }
      expect(provider.prepareQuery(UNAMBIGUOUS[0], { limit: 50 }).wasLimited).toBe(true);
    }
  });
});
