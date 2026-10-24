/**
 * The `weaviate` rows of the five contract registries (#1566 spec 4, 5.9, 9, Migration DDL): each declared beside the
 * provider and registered as its row, and each saying what the design says, since a Weaviate console request is not
 * SQL text and nothing it runs writes.
 */
import { describe, expect, test } from "bun:test";
import { CONNECTION_STRING } from "@/lib/db/connection-string";
import { EXECUTION_UI } from "@/lib/db/execution-ui";
import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";
import { MIGRATION_DDL } from "@/lib/db/migration-ddl";
import { WEAVIATE_CONNECTION_STRING } from "@/lib/db/providers/vector/weaviate/connection-string";
import { WEAVIATE_EXECUTION_UI } from "@/lib/db/providers/vector/weaviate/execution-ui";
import { WEAVIATE_MIGRATION_DDL } from "@/lib/db/providers/vector/weaviate/migration-ddl";
import { WEAVIATE_SQL_GRAMMAR } from "@/lib/db/providers/vector/weaviate/sql-grammar";
import { WEAVIATE_SQL_WRITING } from "@/lib/db/providers/vector/weaviate/sql-writing";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { DEFAULT_SQL_GRAMMAR } from "@/lib/db/sql-grammar/shared";
import { SQL_WRITING } from "@/lib/db/sql-writing";
import { identifierDoubleQuoted, literalStandard } from "@/lib/db/sql-writing/shared";

describe("each row is the registry's weaviate row", () => {
  test.each([
    ["SQL_GRAMMAR", SQL_GRAMMAR.weaviate, WEAVIATE_SQL_GRAMMAR],
    ["SQL_WRITING", SQL_WRITING.weaviate, WEAVIATE_SQL_WRITING],
    ["MIGRATION_DDL", MIGRATION_DDL.weaviate, WEAVIATE_MIGRATION_DDL],
    ["CONNECTION_STRING", CONNECTION_STRING.weaviate, WEAVIATE_CONNECTION_STRING],
    ["EXECUTION_UI", EXECUTION_UI.weaviate, WEAVIATE_EXECUTION_UI],
  ] as const)("%s", (_name, registered, declared) => {
    expect(registered).toBe(declared as never);
  });
});

describe("the rows", () => {
  test("the SQL grammar reads no SQL text and redacts a statement whole", () => {
    expect(WEAVIATE_SQL_GRAMMAR.readsSqlText).toBe(false);
    expect(WEAVIATE_SQL_GRAMMAR.grammar).toBe(DEFAULT_SQL_GRAMMAR);
    expect(WEAVIATE_SQL_GRAMMAR.redaction).toEqual({ kind: "none" });
    expect(WEAVIATE_SQL_GRAMMAR.completion).toEqual({ formatSegment: null, readQuotedQualifier: null });
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
    expect(WEAVIATE_CONNECTION_STRING).toEqual({ scheme: null, readTls: null, validateSeed: null });
  });

  test("the execution UI names COMMIT and has no consent deadline", () => {
    expect(WEAVIATE_EXECUTION_UI).toEqual({ commitKeyword: SQL_COMMIT_KEYWORD, consentDeadline: null });
  });
});
