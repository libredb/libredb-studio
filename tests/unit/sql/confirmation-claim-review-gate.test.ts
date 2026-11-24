/**
 * The confirmation gate counts a row's loosening claim only where Studio's review record lists it
 * (`CONFIRMATION_CLAIM_REVIEW`, E21-Q1), and reads any other claim as if the row had not made it, so the gate asks
 * wherever the SQL reading or the row's own vocabulary asks.
 *
 * The unlisted claims are planted, since no shipped row makes one: a decides-alone row is the stand-in vocabulary row
 * under Trino, and the two grammar claims are planted as a declaration states them, in the generated SQL text the
 * grammar is composed from: an exempt form is Trino's real entry with `DELETE FROM` added to its `confirmExemptForms`,
 * and a text-not-SQL claim is Druid's real entry with `readsSqlText: false`. The generated module is mocked before
 * anything that reaches the grammar registry is imported, because `SQL_GRAMMAR` is composed from it when it loads. So
 * this file imports only `bun:test` statically.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const { BUNDLED_SQL_TEXT } = await import("@/lib/db/engine-catalog/sql-text.generated");
mock.module("@/lib/db/engine-catalog/sql-text.generated", () => ({
  BUNDLED_SQL_TEXT: {
    ...BUNDLED_SQL_TEXT,
    trino: {
      ...BUNDLED_SQL_TEXT.trino,
      grammar: { ...BUNDLED_SQL_TEXT.trino.grammar, confirmExemptForms: [["DELETE", "FROM"]] },
    },
    druid: { ...BUNDLED_SQL_TEXT.druid, readsSqlText: false },
  },
}));

const { hasUnreadableRun, isDangerousQuery } = await import("@/lib/sql/dangerous-query");
const editorGate = await import("@/components/QuerySafetyDialog");
const { analyzeStatement, confirmationVerdict } = await import("@/lib/editor/statement-analysis");
const { createDatabaseProvider } = await import("@/lib/db/factory");
const { CENSUS_CONNECTION } = await import("../../helpers/census-connection");
const { installStandInVocabulary, STAND_IN_TYPE } = await import("../../helpers/stand-in-vocabulary");

let remove: (() => void) | undefined;
afterEach(() => {
  remove?.();
  remove = undefined;
});

describe("a decides-alone claim the record does not list", () => {
  test("keeps the SQL reading in front of the row", () => {
    remove = installStandInVocabulary({});
    expect(isDangerousQuery("DROP TABLE t", STAND_IN_TYPE)).toBe(true);
    expect(isDangerousQuery("SELECT 1; DROP TABLE t", STAND_IN_TYPE)).toBe(true);
    expect(isDangerousQuery("SELECT 1", STAND_IN_TYPE)).toBe(false);
  });

  test("still reads the row's own vocabulary", () => {
    // Read as `decidesAlone: false` alone, the claim would drop the row: Trino's text is SQL, and a row on a SQL-text
    // type used to be read only when it decided alone.
    remove = installStandInVocabulary({ read: (text) => (text === "wipe" ? undefined : []) });
    expect(isDangerousQuery("wipe", STAND_IN_TYPE)).toBe(true);
    expect(isDangerousQuery("keep", STAND_IN_TYPE)).toBe(false);
  });
});

describe("an exempt form the record does not list", () => {
  test("asks at the operative keyword", () => {
    expect(isDangerousQuery("DELETE FROM t", "trino")).toBe(true);
    expect(isDangerousQuery("SELECT 1; DELETE FROM t", "trino")).toBe(true);
  });

  test("asks inside a block", () => {
    expect(isDangerousQuery("BEGIN DELETE FROM t; END", "trino")).toBe(true);
  });
});

describe("a text-not-sql claim the record does not list", () => {
  test("asks about a write in a later statement", () => {
    expect(isDangerousQuery("SELECT 1; DROP TABLE t", "druid")).toBe(true);
    expect(isDangerousQuery("SELECT 1; SELECT 2", "druid")).toBe(false);
  });

  test("asks about a run it cannot read, and says so", () => {
    const hidden = "SELECT '\\'; DELETE FROM t";
    expect(hasUnreadableRun(hidden, "druid")).toBe(true);
    expect(isDangerousQuery(hidden, "druid")).toBe(true);
  });
});

describe("a listed claim", () => {
  test("prometheus and kafka rows are the whole answer", () => {
    expect(isDangerousQuery("update", "prometheus")).toBe(false);
    expect(isDangerousQuery("DROP TABLE t", "kafka")).toBe(false);
  });

  test("snowflake's session forms stay exempt", () => {
    expect(isDangerousQuery("ALTER SESSION SET QUERY_TAG = 'x'", "snowflake")).toBe(false);
    expect(isDangerousQuery("ALTER SESSION UNSET QUERY_TAG", "snowflake")).toBe(false);
    expect(isDangerousQuery("BEGIN ALTER SESSION SET TIMEZONE = 'UTC'; END", "snowflake")).toBe(false);
    // An account object outlives the statement, so this form was never exempt.
    expect(isDangerousQuery("ALTER SESSION POLICY p", "snowflake")).toBe(true);
  });

  test("mongodb and redis text is not read as SQL", () => {
    const find = '{"collection":"t","operation":"find","filter":{"msg":"say \\"hi\\""}}';
    expect(hasUnreadableRun(find, "mongodb")).toBe(false);
    expect(isDangerousQuery(find, "mongodb")).toBe(false);
    expect(isDangerousQuery("MGET a b", "redis")).toBe(false);
  });
});

describe("the readers of the verdict", () => {
  test("the editor's gate is the gate", () => {
    expect(editorGate.isDangerousQuery).toBe(isDangerousQuery);
    expect(editorGate.isDangerousQuery("DELETE FROM t", "trino")).toBe(true);
    remove = installStandInVocabulary({});
    expect(editorGate.isDangerousQuery("DROP TABLE t", STAND_IN_TYPE)).toBe(true);
  });

  test("confirmationVerdict and analyzeStatement confirm each planted claim", async () => {
    const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION.trino)).getCapabilities();
    const analyze = (text: string) =>
      analyzeStatement({
        text,
        selection: { start: 0, end: 0 },
        cursor: 0,
        databaseType: "trino",
        capabilities,
        connectionName: "census",
      });
    const confirm = { decision: "confirm" as const, unreadable: false, typedConfirmation: null };

    expect(confirmationVerdict("DELETE FROM t", "trino", "census")).toEqual(confirm);
    expect(analyze("DELETE FROM t")).toMatchObject(confirm);

    remove = installStandInVocabulary({});
    expect(confirmationVerdict("DROP TABLE t", STAND_IN_TYPE, "census")).toEqual(confirm);
    expect(analyze("DROP TABLE t")).toMatchObject(confirm);
    remove();
    remove = undefined;

    expect(confirmationVerdict("SELECT 1; DROP TABLE t", "druid", "census")).toEqual(confirm);
    expect(confirmationVerdict("SELECT '\\'; DELETE FROM t", "druid", "census")).toEqual({
      ...confirm,
      unreadable: true,
    });
  });
});
