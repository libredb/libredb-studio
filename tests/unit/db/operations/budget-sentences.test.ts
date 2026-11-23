/**
 * The row and byte budget sentences are written by one shared module and built by every provider through it.
 *
 * `rowBudgetSentence` and `byteBudgetSentence` in src/lib/db/providers/sql/read-only-budget.ts format the refusal
 * of a result past the row or byte field of a `ReadOnlyStatementBudget`. A reader decides that refusal by its class,
 * but `rowBudgetIn` in src/lib/agent/context-snapshot.ts, and through it the agent's row advice in
 * src/lib/agent/tools.ts, read the two numbers back out of the row sentence. So each provider with a `queryReadOnly`
 * builds its sentence with the shared constructor, and no source file but the shared module writes either opening:
 * a provider that typed the sentence out again could reword it without the readers of its numbers noticing.
 *
 * The provider files are read, never edited. The tree scan reads only the TypeScript sources under src, the only
 * files that could write an opening.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BYTE_BUDGET_PREFIX,
  byteBudgetSentence,
  ROW_BUDGET_PREFIX,
  rowBudgetSentence,
} from "@/lib/db/providers/sql/read-only-budget";

const REPO = join(import.meta.dir, "../../../..");
const read = (file: string): string => readFileSync(join(REPO, file), "utf8");
const SHARED = "src/lib/db/providers/sql/read-only-budget.ts";
const SHARED_PREFIXES = [ROW_BUDGET_PREFIX, BYTE_BUDGET_PREFIX];

/** Each provider with a `queryReadOnly`, by the files that raise its row or byte refusal. */
const SHARED_USERS: Record<string, readonly string[]> = {
  postgres: ["src/lib/db/providers/sql/postgres.ts"],
  mysql: ["src/lib/db/providers/sql/mysql.ts"],
  mssql: ["src/lib/db/providers/sql/mssql.ts"],
  sqlite: ["src/lib/db/providers/sql/sqlite.ts"],
  duckdb: ["src/lib/db/providers/sql/duckdb/index.ts"],
  clickhouse: ["src/lib/db/providers/sql/clickhouse/agent-read.ts", "src/lib/db/providers/sql/clickhouse/index.ts"],
  libsql: ["src/lib/db/providers/sql/libsql/agent-read.ts", "src/lib/db/providers/sql/libsql/index.ts"],
  influxdb3: ["src/lib/db/providers/timeseries/influxdb/sql-agent-read.ts"],
  elasticsearch: ["src/lib/db/providers/sql/search/index.ts"],
  oracle: ["src/lib/db/providers/sql/oracle/agent-read.ts"],
  db2: ["src/lib/db/providers/sql/db2/agent-read.ts"],
  cassandra: ["src/lib/db/providers/sql/cassandra/index.ts"],
  couchbase: ["src/lib/db/providers/document/couchbase/index.ts"],
  mongodb: ["src/lib/db/providers/document/mongodb/agent-read.ts"],
  kubernetes: [
    "src/lib/db/providers/platform/kubernetes/machine-read.ts",
    "src/lib/db/providers/platform/kubernetes/console/describe.ts",
    "src/lib/db/providers/platform/kubernetes/console/events.ts",
    "src/lib/db/providers/platform/kubernetes/console/get-documents.ts",
    "src/lib/db/providers/platform/kubernetes/console/logs.ts",
  ],
};

describe("the budget sentences every provider shares (D367)", () => {
  test("read the way rowBudgetIn reads them", () => {
    expect(rowBudgetSentence(1001, 1000)).toBe("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed");
    expect(byteBudgetSentence(2000000, 1048576)).toBe(
      "Read-only execution exceeded the byte budget: 2000000 bytes > 1048576 allowed",
    );
  });

  test("open with the shared module's prefixes", () => {
    expect(rowBudgetSentence(1, 0).startsWith(`${ROW_BUDGET_PREFIX}: `)).toBe(true);
    expect(byteBudgetSentence(1, 0).startsWith(`${BYTE_BUDGET_PREFIX}: `)).toBe(true);
  });

  test.each(SHARED_PREFIXES)("%p is written once, in the shared module", (prefix) => {
    expect(read(SHARED).split(prefix)).toHaveLength(2);
  });

  test.each(SHARED_PREFIXES)("%p is written in no source file but the shared module", (prefix) => {
    const writers = readdirSync(join(REPO, "src"), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file))
      // readdirSync answers with the platform separator; the census names files with "/".
      .map((file) => `src/${file.replaceAll("\\", "/")}`)
      .filter((file) => read(file).includes(prefix));
    expect(writers).toEqual([SHARED]);
  });

  test.each(
    Object.entries(SHARED_USERS).flatMap(([provider, files]) => files.map((file) => [provider, file] as const)),
  )("%s builds its budget refusal with the shared constructor in %s", (_provider, file) => {
    const source = read(file);
    expect(source).toMatch(
      /import \{[^}]*\b(rowBudgetSentence|byteBudgetSentence)\b[^}]*\} from "[^"]*read-only-budget";/,
    );
    expect(source).toMatch(/\b(rowBudgetSentence|byteBudgetSentence)\(/);
  });
});
