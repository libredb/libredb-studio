/**
 * The `weaviate` rows of the five contract registries (#1566 spec 4, 5.9, 9, Migration DDL): two declared beside the
 * provider and registered as its row, the SQL grammar and the connection string composed from its declaration, the
 * execution UI read from its declaration, and each saying what the design says, since a Weaviate console request is not
 * SQL text and nothing it runs writes.
 */
import { describe, expect, test } from "bun:test";
import { CONNECTION_STRING } from "@/lib/db/connection-string";
import { EXECUTION_UI } from "@/lib/db/execution-ui";
import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";
import { MIGRATION_DDL } from "@/lib/db/migration-ddl";
import { WEAVIATE_MIGRATION_DDL } from "@/lib/db/providers/vector/weaviate/migration-ddl";
import { WEAVIATE_SQL_WRITING } from "@/lib/db/providers/vector/weaviate/sql-writing";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { DEFAULT_SQL_GRAMMAR } from "@libredb/provider-sdk/sql";
import { SQL_WRITING } from "@/lib/db/sql-writing";
import { identifierDoubleQuoted, literalStandard } from "@/lib/db/sql-writing/shared";

describe("each row is the registry's weaviate row", () => {
  test.each([
    ["SQL_WRITING", SQL_WRITING.weaviate, WEAVIATE_SQL_WRITING],
    ["MIGRATION_DDL", MIGRATION_DDL.weaviate, WEAVIATE_MIGRATION_DDL],
  ] as const)("%s", (_name, registered, declared) => {
    expect(registered).toBe(declared as never);
  });
});

describe("the rows", () => {
  test("the SQL grammar reads no SQL text and redacts a statement whole", () => {
    expect(SQL_GRAMMAR.weaviate.readsSqlText).toBe(false);
    expect(SQL_GRAMMAR.weaviate.grammar).toEqual(DEFAULT_SQL_GRAMMAR);
    expect(SQL_GRAMMAR.weaviate.redaction).toEqual({ kind: "none" });
    expect(SQL_GRAMMAR.weaviate.completion).toEqual({ formatSegment: null, readQuotedQualifier: null });
  });

  test("SQL writing is the standard form, with no placeholder and no temporal literal", () => {
    expect(WEAVIATE_SQL_WRITING.escapeLiteral).toBe(literalStandard);
    expect(WEAVIATE_SQL_WRITING.quoteIdentifier).toBe(identifierDoubleQuoted);
    expect(WEAVIATE_SQL_WRITING.placeholder).toBeNull();
    expect(WEAVIATE_SQL_WRITING.temporalLiteral).toBeNull();
    expect(WEAVIATE_SQL_WRITING.export.insertForm).toBe("values");
  });

  test("migration DDL is refused with the one sentence, and no transaction wrapper", () => {
    const reason =
      "A collection's properties and vectors are declared through Weaviate's own schema API, not SQL DDL, so there is no column definition to change.";
    expect(WEAVIATE_MIGRATION_DDL).toEqual({
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
