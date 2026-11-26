/**
 * The `weaviate` rows of the five contract registries (#1566 spec 4, 5.9, 9, Migration DDL): the migration DDL, the SQL
 * grammar, the SQL writing and the connection string composed from its declaration, the execution UI read from its
 * declaration, and each saying what the design says, since a Weaviate console request is not SQL text and nothing it
 * runs writes.
 */
import { describe, expect, test } from "bun:test";
import { CONNECTION_STRING } from "@/lib/db/connection-string";
import { EXECUTION_UI } from "@/lib/db/execution-ui";
import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";
import { MIGRATION_DDL } from "@/lib/db/migration-ddl";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { DEFAULT_SQL_GRAMMAR } from "@libredb/provider-sdk/sql";
import { SQL_WRITING } from "@/lib/db/sql-writing";
import { identifierDoubleQuoted, literalStandard } from "@/lib/db/sql-writing/shared";

describe("the rows", () => {
  test("the SQL grammar reads no SQL text and redacts a statement whole", () => {
    expect(SQL_GRAMMAR.weaviate.readsSqlText).toBe(false);
    expect(SQL_GRAMMAR.weaviate.grammar).toEqual(DEFAULT_SQL_GRAMMAR);
    expect(servedEngineRecord("weaviate").grants.redaction).toEqual({ kind: "none" });
    expect(SQL_GRAMMAR.weaviate.completion).toEqual({ formatSegment: null, readQuotedQualifier: null });
  });

  test("SQL writing is the standard form, with no placeholder and no temporal literal", () => {
    expect(SQL_WRITING.weaviate.escapeLiteral).toBe(literalStandard);
    expect(SQL_WRITING.weaviate.quoteIdentifier).toBe(identifierDoubleQuoted);
    expect(SQL_WRITING.weaviate.placeholder).toBeNull();
    expect(SQL_WRITING.weaviate.temporalLiteral).toBeNull();
    expect(SQL_WRITING.weaviate.export.insertForm).toBe("values");
  });

  test("migration DDL is refused with the one sentence, and no transaction wrapper", () => {
    const reason =
      "A collection's properties and vectors are declared through Weaviate's own schema API, not SQL DDL, so there is no column definition to change.";
    expect(MIGRATION_DDL.weaviate).toEqual({
      tableDdl: "refused",
      refusal: `-- Weaviate: Cannot generate table DDL. ${reason}`,
      transactionWrapper: null,
      reasons: [reason],
    });
  });

  test("there is no connection string scheme", () => {
    expect(CONNECTION_STRING.weaviate).toEqual({ scheme: null, readTls: null, paste: null, validateSeed: null });
  });

  test("the execution UI names COMMIT and has no consent deadline", () => {
    expect(EXECUTION_UI.weaviate).toEqual({ commitKeyword: SQL_COMMIT_KEYWORD, consentDeadline: null });
  });
});
