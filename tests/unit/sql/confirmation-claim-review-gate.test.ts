/**
 * The confirmation gate counts a claim that loosens it only where the engine's register row grants it for the grammar
 * that row reviewed (`legacyEngineGrants` in src/lib/db/claim-grants.ts), reads any other claim as if the row had not
 * made it, so the gate asks wherever the SQL reading or the row's own vocabulary asks, and asks about every statement
 * of an engine whose grammar its register row did not review.
 *
 * The ungranted requests are planted, since no shipped declaration makes one: a decides-alone row is the stand-in
 * vocabulary row under Trino, and the two grammar claims are planted as a declaration states them, in the generated
 * SQL text the grammar is composed from: an exempt form is Trino's real entry with `DELETE FROM` added to its
 * `confirmExemptForms`, and a text-not-SQL claim is Druid's real entry with `readsSqlText: false`. Databend's entry
 * requests `DELETE FROM` too. The register is planted through its reader (tests/helpers/planted-legacy-register.ts):
 * SQLite's row reviews no grammar, Databend's row grants `DELETE FROM`, and ClickHouse's row lists it though its
 * declaration does not request it. Both modules are mocked before anything that reaches the grammar registry or the
 * grant reader is imported, because `SQL_GRAMMAR` and the legacy grants are composed from them when they load. So this
 * file imports only `bun:test` statically.
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
    databend: {
      ...BUNDLED_SQL_TEXT.databend,
      grammar: { ...BUNDLED_SQL_TEXT.databend.grammar, confirmExemptForms: [["DELETE", "FROM"]] },
    },
  },
}));
const { plantedRegisterReader } = await import("../../helpers/planted-legacy-register");
const realRegister = { ...(await import("@libredb/grant-register")) };
mock.module("@libredb/grant-register", () => ({
  ...realRegister,
  readGrantRegister: plantedRegisterReader(realRegister, {
    sqlite: { grammarSha256: null },
    databend: { confirmExemptForms: [["DELETE", "FROM"]] },
    clickhouse: { confirmExemptForms: [["DELETE", "FROM"]] },
  }),
}));

const { hasUnreadableRun, isDangerousQuery, readingOfType } = await import("@/lib/sql/dangerous-query");
const editorGate = await import("@/components/QuerySafetyDialog");
const { analyzeStatement, confirmationVerdict } = await import("@/lib/editor/statement-analysis");
const { createDatabaseProvider } = await import("@/lib/db/factory");
const { legacyEngineGrants } = await import("@/lib/db/claim-grants");
const { resolveSqlGrammar } = await import("@/lib/sql/grammar");
const { CENSUS_CONNECTION } = await import("../../helpers/census-connection");
const { installStandInVocabulary, STAND_IN_TYPE } = await import("../../helpers/stand-in-vocabulary");

let remove: (() => void) | undefined;
afterEach(() => {
  remove?.();
  remove = undefined;
});

describe("a grammar its register row did not review", () => {
  test("a grammar Studio did not review asks about every statement", () => {
    expect(legacyEngineGrants("sqlite").reviewedGrammar).toBe(false);
    expect(legacyEngineGrants("libsql").reviewedGrammar).toBe(true);
    expect(isDangerousQuery("SELECT 1", "sqlite")).toBe(true);
    expect(isDangerousQuery("", "sqlite")).toBe(true);
    // Nothing of the text is read, so no run is reported unreadable.
    expect(hasUnreadableRun("SELECT 'x", "sqlite")).toBe(false);
    expect(confirmationVerdict("SELECT 1", readingOfType("sqlite"), "census")).toEqual({
      decision: "confirm",
      unreadable: false,
      typedConfirmation: null,
    });
    // Every other engine's reads still run.
    expect(isDangerousQuery("SELECT 1", "libsql")).toBe(false);
    expect(isDangerousQuery("SELECT 1", "postgres")).toBe(false);
  });
});

describe("a form its register row grants", () => {
  test("a form the engine's register row grants is exempt, and a form only its row lists asks", () => {
    // The vacuity check: Databend's declared grammar holds the form, and both rows list it.
    expect(resolveSqlGrammar("databend").confirmExemptForms).toEqual([["DELETE", "FROM"]]);
    expect(resolveSqlGrammar("clickhouse").confirmExemptForms ?? []).toEqual([]);
    expect(legacyEngineGrants("databend").confirmExemptForms).toEqual([["DELETE", "FROM"]]);
    expect(legacyEngineGrants("clickhouse").confirmExemptForms).toEqual([]);
    expect(isDangerousQuery("DELETE FROM t", "databend")).toBe(false);
    expect(isDangerousQuery("DELETE FROM t", "clickhouse")).toBe(true);
  });
});

describe("a decides-alone claim its register row does not grant", () => {
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

describe("an exempt form its register row does not grant", () => {
  test("asks at the operative keyword", () => {
    expect(isDangerousQuery("DELETE FROM t", "trino")).toBe(true);
    expect(isDangerousQuery("SELECT 1; DELETE FROM t", "trino")).toBe(true);
  });

  test("asks inside a block", () => {
    expect(isDangerousQuery("BEGIN DELETE FROM t; END", "trino")).toBe(true);
  });
});

describe("a text-not-sql claim its register row does not grant", () => {
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

    expect(confirmationVerdict("DELETE FROM t", readingOfType("trino"), "census")).toEqual(confirm);
    expect(analyze("DELETE FROM t")).toMatchObject(confirm);

    remove = installStandInVocabulary({});
    expect(confirmationVerdict("DROP TABLE t", readingOfType(STAND_IN_TYPE), "census")).toEqual(confirm);
    expect(analyze("DROP TABLE t")).toMatchObject(confirm);
    remove();
    remove = undefined;

    expect(confirmationVerdict("SELECT 1; DROP TABLE t", readingOfType("druid"), "census")).toEqual(confirm);
    expect(confirmationVerdict("SELECT '\\'; DELETE FROM t", readingOfType("druid"), "census")).toEqual({
      ...confirm,
      unreadable: true,
    });
  });
});
