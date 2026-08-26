import { describe, test, expect } from "bun:test";
import { generateMigrationSQL } from "@/lib/schema-diff/migration-generator";
import type { ColumnDiff, SchemaDiff } from "@/lib/schema-diff/types";
import type { DatabaseType } from "@/lib/types";

// ============================================================================
// Helpers
// ============================================================================

const noChangesDiff: SchemaDiff = {
  tables: [],
  summary: { added: 0, removed: 0, modified: 0 },
  hasChanges: false,
};

function makeAddedTableDiff(): SchemaDiff {
  return {
    tables: [
      {
        action: "added",
        tableName: "users",
        columns: [
          {
            action: "added",
            columnName: "id",
            targetType: "integer",
            targetNullable: false,
            targetIsPrimary: true,
            changes: ['Added column "id"'],
          },
          {
            action: "added",
            columnName: "name",
            targetType: "varchar(255)",
            targetNullable: false,
            targetIsPrimary: false,
            changes: ['Added column "name"'],
          },
          {
            action: "added",
            columnName: "email",
            targetType: "varchar(255)",
            targetNullable: true,
            targetIsPrimary: false,
            changes: ['Added column "email"'],
          },
        ],
        indexes: [
          {
            action: "added",
            indexName: "idx_users_email",
            targetColumns: ["email"],
            targetUnique: true,
            changes: ["Added index"],
          },
        ],
        foreignKeys: [],
      },
    ],
    summary: { added: 1, removed: 0, modified: 0 },
    hasChanges: true,
  };
}

function makeDroppedTableDiff(): SchemaDiff {
  return {
    tables: [
      {
        action: "removed",
        tableName: "legacy",
        columns: [{ action: "removed", columnName: "id", sourceType: "integer", changes: ["Removed column"] }],
        indexes: [],
        foreignKeys: [],
      },
    ],
    summary: { added: 0, removed: 1, modified: 0 },
    hasChanges: true,
  };
}

function makeModifiedTableDiff(): SchemaDiff {
  return {
    tables: [
      {
        action: "modified",
        tableName: "users",
        columns: [
          {
            action: "added",
            columnName: "phone",
            targetType: "varchar(20)",
            targetNullable: true,
            changes: ['Added column "phone"'],
          },
          { action: "removed", columnName: "legacy_col", sourceType: "text", changes: ["Removed column"] },
          {
            action: "modified",
            columnName: "name",
            sourceType: "varchar(100)",
            targetType: "varchar(255)",
            sourceNullable: true,
            targetNullable: false,
            sourceDefault: undefined,
            targetDefault: "'unknown'",
            changes: ["Type changed", "Nullable changed", "Default changed"],
          },
        ],
        indexes: [
          {
            action: "added",
            indexName: "idx_phone",
            targetColumns: ["phone"],
            targetUnique: false,
            changes: ["Added index"],
          },
          { action: "removed", indexName: "idx_legacy", sourceColumns: ["legacy_col"], changes: ["Removed index"] },
        ],
        foreignKeys: [
          {
            action: "added",
            columnName: "dept_id",
            targetReferencedTable: "departments",
            targetReferencedColumn: "id",
            changes: ["Added FK"],
          },
          {
            action: "removed",
            columnName: "old_ref",
            sourceReferencedTable: "old_table",
            sourceReferencedColumn: "id",
            changes: ["Removed FK"],
          },
        ],
      },
    ],
    summary: { added: 0, removed: 0, modified: 1 },
    hasChanges: true,
  };
}

// ============================================================================
// No changes
// ============================================================================

describe("generateMigrationSQL: no changes", () => {
  test("returns comment when no changes", () => {
    const sql = generateMigrationSQL(noChangesDiff, "postgres");
    expect(sql).toBe("-- No schema changes detected.");
  });
});

// ============================================================================
// CREATE TABLE
// ============================================================================

describe("generateMigrationSQL: CREATE TABLE", () => {
  test("postgres uses double-quoted identifiers", () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), "postgres");
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain('"id" integer NOT NULL');
    expect(sql).toContain('"name" varchar(255) NOT NULL');
    expect(sql).toContain('PRIMARY KEY ("id")');
    expect(sql).toContain('CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email")');
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
  });

  test("mysql uses backtick identifiers", () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), "mysql");
    expect(sql).toContain("CREATE TABLE `users`");
    expect(sql).toContain("`id` integer NOT NULL");
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
  });

  test("sqlite uses double-quoted identifiers and no BEGIN/COMMIT", () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), "sqlite");
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).not.toContain("BEGIN;");
    expect(sql).not.toContain("COMMIT;");
  });

  test("mssql uses bracket identifiers", () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), "mssql");
    expect(sql).toContain("CREATE TABLE [users]");
    expect(sql).toContain("[id] integer NOT NULL");
    expect(sql).toContain("BEGIN;");
  });

  test("oracle uses double-quoted identifiers", () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), "oracle");
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain("BEGIN;");
  });

  test("unlisted dialect falls back to double-quoted identifiers", () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), "mongodb");
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain('"id" integer NOT NULL');
  });

  test("added table with foreign keys emits ADD CONSTRAINT after CREATE TABLE", () => {
    const diff = makeAddedTableDiff();
    diff.tables[0].foreignKeys = [
      {
        action: "added",
        columnName: "dept_id",
        targetReferencedTable: "departments",
        targetReferencedColumn: "id",
        changes: ["Added FK"],
      },
    ];
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).toContain(
      'ALTER TABLE "users" ADD CONSTRAINT "fk_users_dept_id" FOREIGN KEY ("dept_id") REFERENCES "departments"("id");',
    );
  });
});

// ============================================================================
// DROP TABLE
// ============================================================================

describe("generateMigrationSQL: DROP TABLE", () => {
  test("generates DROP TABLE IF EXISTS", () => {
    const sql = generateMigrationSQL(makeDroppedTableDiff(), "postgres");
    expect(sql).toContain('DROP TABLE IF EXISTS "legacy"');
  });

  test("mysql uses backtick for DROP", () => {
    const sql = generateMigrationSQL(makeDroppedTableDiff(), "mysql");
    expect(sql).toContain("DROP TABLE IF EXISTS `legacy`");
  });
});

// ============================================================================
// ALTER TABLE
// ============================================================================

describe("generateMigrationSQL: ALTER TABLE", () => {
  test("postgres: ADD COLUMN, DROP COLUMN, ALTER COLUMN TYPE/NULL/DEFAULT", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "postgres");
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN "phone" varchar(20)');
    expect(sql).toContain('ALTER TABLE "users" DROP COLUMN "legacy_col"');
    expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(255)');
    expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL');
    expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "name" SET DEFAULT \'unknown\'');
  });

  test("mysql: MODIFY COLUMN syntax", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "mysql");
    expect(sql).toContain("ALTER TABLE `users` MODIFY COLUMN `name` varchar(255) NOT NULL");
  });

  test("sqlite: column drop produces comment", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "sqlite");
    expect(sql).toContain('-- SQLite: Cannot drop column "legacy_col" directly');
    expect(sql).toContain('-- SQLite: Cannot alter column "name" type directly');
  });

  test("mssql: ALTER COLUMN syntax", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "mssql");
    expect(sql).toContain("ALTER TABLE [users] ALTER COLUMN [name] varchar(255) NOT NULL");
    expect(sql).toContain("ALTER TABLE [users] ADD DEFAULT 'unknown' FOR [name]");
  });

  test("oracle: MODIFY() syntax", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "oracle");
    expect(sql).toContain('ALTER TABLE "users" MODIFY ("name"');
  });
});

// ============================================================================
// Index operations in ALTER TABLE
// ============================================================================

describe("generateMigrationSQL: indexes in ALTER", () => {
  test("CREATE INDEX for added index", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "postgres");
    expect(sql).toContain('CREATE INDEX "idx_phone" ON "users" ("phone")');
  });

  test("CREATE UNIQUE INDEX for added unique index", () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), "postgres");
    expect(sql).toContain("CREATE UNIQUE INDEX");
  });

  test("DROP INDEX for removed index (postgres)", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "postgres");
    expect(sql).toContain('DROP INDEX IF EXISTS "idx_legacy"');
  });

  test("DROP INDEX ON for removed index (mysql)", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "mysql");
    expect(sql).toContain("DROP INDEX `idx_legacy` ON `users`");
  });
});

// ============================================================================
// Foreign key operations in ALTER TABLE
// ============================================================================

describe("generateMigrationSQL: foreign keys in ALTER", () => {
  test("ADD CONSTRAINT for added FK", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "postgres");
    expect(sql).toContain('ADD CONSTRAINT "fk_users_dept_id" FOREIGN KEY ("dept_id") REFERENCES "departments"("id")');
  });

  test("DROP CONSTRAINT for removed FK (postgres)", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "postgres");
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "fk_users_old_ref"');
  });

  test("DROP FOREIGN KEY for removed FK (mysql)", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "mysql");
    expect(sql).toContain("DROP FOREIGN KEY `fk_users_old_ref`");
  });

  test("SQLite FK drop produces comment", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "sqlite");
    expect(sql).toContain("-- SQLite: Cannot drop foreign key directly");
  });
});

// ============================================================================
// Column def edge cases
// ============================================================================

describe("generateMigrationSQL: column def edge cases", () => {
  test("column def uses sourceType fallback when targetType undefined", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "added",
          tableName: "test_table",
          columns: [
            {
              action: "added",
              columnName: "col1",
              sourceType: "integer",
              targetType: undefined as unknown as string,
              targetNullable: true,
              changes: ["Added"],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 1, removed: 0, modified: 0 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).toContain('"col1" integer');
  });

  test("column def uses TEXT fallback when both types undefined", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "added",
          tableName: "test_table",
          columns: [{ action: "added", columnName: "col1", targetNullable: true, changes: ["Added"] }],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 1, removed: 0, modified: 0 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).toContain('"col1" TEXT');
  });

  test("column def includes DEFAULT clause", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "added",
          tableName: "test_table",
          columns: [
            {
              action: "added",
              columnName: "status",
              targetType: "varchar(20)",
              targetNullable: true,
              targetDefault: "'active'",
              changes: ["Added"],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 1, removed: 0, modified: 0 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).toContain("\"status\" varchar(20) DEFAULT 'active'");
  });

  test("CREATE TABLE without PRIMARY KEY", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "added",
          tableName: "logs",
          columns: [
            {
              action: "added",
              columnName: "message",
              targetType: "text",
              targetNullable: true,
              targetIsPrimary: false,
              changes: ["Added"],
            },
            {
              action: "added",
              columnName: "level",
              targetType: "varchar(10)",
              targetNullable: true,
              targetIsPrimary: false,
              changes: ["Added"],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 1, removed: 0, modified: 0 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).toContain('CREATE TABLE "logs"');
    expect(sql).not.toContain("PRIMARY KEY");
  });
});

// ============================================================================
// PostgreSQL-specific ALTER edge cases
// ============================================================================

describe("generateMigrationSQL: PostgreSQL ALTER edge cases", () => {
  test("nullable-only change (no type change) generates SET NOT NULL", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "modified",
          tableName: "users",
          columns: [
            {
              action: "modified",
              columnName: "email",
              sourceType: "varchar(255)",
              targetType: "varchar(255)",
              sourceNullable: true,
              targetNullable: false,
              changes: ["Nullable changed"],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 0, removed: 0, modified: 1 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).not.toContain("TYPE");
    expect(sql).toContain("SET NOT NULL");
  });

  test("DROP NOT NULL (targetNullable=true)", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "modified",
          tableName: "users",
          columns: [
            {
              action: "modified",
              columnName: "email",
              sourceType: "varchar(255)",
              targetType: "varchar(255)",
              sourceNullable: false,
              targetNullable: true,
              changes: ["Nullable changed"],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 0, removed: 0, modified: 1 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).toContain("DROP NOT NULL");
  });

  test("DROP DEFAULT (targetDefault falsy)", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "modified",
          tableName: "users",
          columns: [
            {
              action: "modified",
              columnName: "status",
              sourceType: "varchar(20)",
              targetType: "varchar(20)",
              sourceDefault: "'active'",
              targetDefault: undefined,
              changes: ["Default changed"],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 0, removed: 0, modified: 1 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).toContain("DROP DEFAULT");
  });

  test("type-only change (no nullable/default changes)", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "modified",
          tableName: "users",
          columns: [
            {
              action: "modified",
              columnName: "age",
              sourceType: "smallint",
              targetType: "integer",
              sourceNullable: true,
              targetNullable: true,
              changes: ["Type changed"],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 0, removed: 0, modified: 1 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).toContain("TYPE integer");
    expect(sql).not.toContain("NOT NULL");
    expect(sql).not.toContain("DEFAULT");
  });
});

// ============================================================================
// MSSQL + Oracle ALTER edge cases
// ============================================================================

describe("generateMigrationSQL: MSSQL/Oracle ALTER edge cases", () => {
  test("MSSQL modified column without default change (no ADD DEFAULT)", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "modified",
          tableName: "users",
          columns: [
            {
              action: "modified",
              columnName: "name",
              sourceType: "varchar(100)",
              targetType: "varchar(255)",
              sourceDefault: undefined,
              targetDefault: undefined,
              changes: ["Type changed"],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 0, removed: 0, modified: 1 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "mssql");
    expect(sql).toContain("ALTER COLUMN [name] varchar(255)");
    expect(sql).not.toContain("ADD DEFAULT");
  });

  test("MSSQL bracket escaping with ] in table name", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "removed",
          tableName: "table]name",
          columns: [],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 0, removed: 1, modified: 0 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "mssql");
    expect(sql).toContain("[table]]name]");
  });

  test("Oracle MODIFY with default value", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "modified",
          tableName: "users",
          columns: [
            {
              action: "modified",
              columnName: "status",
              sourceType: "VARCHAR2(10)",
              targetType: "VARCHAR2(50)",
              targetDefault: "'active'",
              changes: ["Type changed", "Default changed"],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 0, removed: 0, modified: 1 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "oracle");
    expect(sql).toContain("MODIFY");
    expect(sql).toContain("DEFAULT 'active'");
  });
});

// ============================================================================
// Dialects the modified-column path had no branch for (#269)
// ============================================================================

function makeModifiedColumnDiff(col: Partial<ColumnDiff>): SchemaDiff {
  return {
    tables: [
      {
        action: "modified",
        tableName: "events",
        columns: [{ action: "modified", columnName: "note", changes: ["Changed"], ...col }],
        indexes: [],
        foreignKeys: [],
      },
    ],
    summary: { added: 0, removed: 0, modified: 1 },
    hasChanges: true,
  };
}

describe("generateMigrationSQL: ClickHouse ALTER", () => {
  test("modified column uses MODIFY COLUMN, not PostgreSQL ALTER COLUMN", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "clickhouse");
    expect(sql).toContain('ALTER TABLE "users" MODIFY COLUMN "name" varchar(255) DEFAULT \'unknown\';');
    expect(sql).not.toContain("ALTER COLUMN");
    expect(sql).not.toContain("SET NOT NULL");
  });

  test("a nullability change rides in the declared type instead of a NULL modifier", () => {
    const sql = generateMigrationSQL(
      makeModifiedColumnDiff({
        sourceType: "String",
        targetType: "Nullable(String)",
        sourceNullable: false,
        targetNullable: true,
      }),
      "clickhouse",
    );
    expect(sql).toContain('ALTER TABLE "events" MODIFY COLUMN "note" Nullable(String);');
    expect(sql).not.toContain("DROP NOT NULL");
    expect(sql).not.toContain("NOT NULL");
  });

  test("dropping a default emits the explicit REMOVE DEFAULT form", () => {
    const sql = generateMigrationSQL(
      makeModifiedColumnDiff({ sourceType: "String", targetType: "String", sourceDefault: "'n/a'" }),
      "clickhouse",
    );
    expect(sql).toContain('ALTER TABLE "events" MODIFY COLUMN "note" String;');
    expect(sql).toContain('ALTER TABLE "events" MODIFY COLUMN "note" REMOVE DEFAULT;');
    expect(sql).not.toContain("DROP DEFAULT");
  });

  test("modified column falls back to String when neither type is known", () => {
    const sql = generateMigrationSQL(makeModifiedColumnDiff({}), "clickhouse");
    expect(sql).toContain('MODIFY COLUMN "note" String;');
    expect(sql).not.toContain("REMOVE DEFAULT");
  });

  // `clickhouse/introspect.ts:readDefault` reports a computed column's default as
  // "<KIND> <expression>", so the DEFAULT keyword must not be prefixed onto it. Live-probed against
  // clickhouse-server 26.7.1.1315: `DEFAULT MATERIALIZED toYear(d)` is a syntax error (code 62).
  test("a MATERIALIZED default is emitted verbatim, never behind the DEFAULT keyword", () => {
    const sql = generateMigrationSQL(
      makeModifiedColumnDiff({ targetType: "Int32", targetDefault: "MATERIALIZED toYear(d)" }),
      "clickhouse",
    );
    expect(sql).toContain('ALTER TABLE "events" MODIFY COLUMN "note" Int32 MATERIALIZED toYear(d);');
    expect(sql).not.toContain("DEFAULT MATERIALIZED");
  });

  test("dropping a MATERIALIZED property removes that kind, not DEFAULT", () => {
    const sql = generateMigrationSQL(
      makeModifiedColumnDiff({ targetType: "Int32", sourceDefault: "MATERIALIZED toYear(d)" }),
      "clickhouse",
    );
    expect(sql).toContain('ALTER TABLE "events" MODIFY COLUMN "note" REMOVE MATERIALIZED;');
    expect(sql).not.toContain("REMOVE DEFAULT");
  });

  test("dropping an ALIAS property removes that kind", () => {
    const sql = generateMigrationSQL(
      makeModifiedColumnDiff({ targetType: "Int32", sourceDefault: "ALIAS toYear(d)" }),
      "clickhouse",
    );
    expect(sql).toContain('ALTER TABLE "events" MODIFY COLUMN "note" REMOVE ALIAS;');
  });

  // Introducing an ephemeral property IS valid (live-probed: accepted as long as the table keeps a
  // physical column) — it is only its removal that ClickHouse has no syntax for, see the next case.
  test("an EPHEMERAL target default is emitted as its own clause", () => {
    const sql = generateMigrationSQL(
      makeModifiedColumnDiff({ targetType: "String", targetDefault: "EPHEMERAL 'e'" }),
      "clickhouse",
    );
    expect(sql).toContain('ALTER TABLE "events" MODIFY COLUMN "note" String EPHEMERAL \'e\';');
    expect(sql).not.toContain("DEFAULT EPHEMERAL");
  });

  // REMOVE accepts DEFAULT, MATERIALIZED or ALIAS only — live-probed, EPHEMERAL is rejected with
  // code 62 — so the honest answer is a comment rather than a statement that cannot run.
  test("an EPHEMERAL property cannot be removed, so it is reported instead of emitted", () => {
    const sql = generateMigrationSQL(
      makeModifiedColumnDiff({ targetType: "String", sourceDefault: "EPHEMERAL 'e'" }),
      "clickhouse",
    );
    expect(sql).toContain('-- ClickHouse: Cannot remove the EPHEMERAL property of column "note".');
    expect(sql).not.toContain("REMOVE EPHEMERAL");
    expect(sql).not.toContain('MODIFY COLUMN "note" REMOVE');
  });
});

describe("generateMigrationSQL: Cassandra spells ADD and DROP without the COLUMN keyword", () => {
  // All three measured on 5.0.9. `ALTER TABLE probe.tmp_ok ADD COLUMN extra TEXT` is
  // "line 1:42 mismatched input 'TEXT' expecting EOF" and `... DROP COLUMN extra` is
  // "mismatched input 'extra' expecting EOF", while `ADD extra text` and
  // `DROP extra` both succeed. The keyword is simply not in CQL's ALTER grammar, so
  // inheriting the shared spelling would emit two statements the server refuses.
  test("an added column uses CQL's own ADD spelling", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "cassandra");

    expect(sql).toContain('ALTER TABLE "users" ADD "phone" varchar(20);');
    expect(sql).not.toContain("ADD COLUMN");
  });

  test("a removed column uses CQL's own DROP spelling", () => {
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "cassandra");

    expect(sql).toContain('ALTER TABLE "users" DROP "legacy_col";');
    expect(sql).not.toContain("DROP COLUMN");
  });

  test("an added column carries no NOT NULL and no DEFAULT, because CQL has neither", () => {
    // Measured: `CREATE TABLE probe.t (id UUID PRIMARY KEY, name TEXT NOT NULL)` is
    // "no viable alternative at input 'NOT'", and the same shape with `DEFAULT 'x'`
    // or `UNIQUE` fails the same way. A CQL column definition is a name and a type.
    // The modified-table path is where this is observable, because the created-table
    // path is declined outright (see the next describe).
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "cassandra");

    expect(sql).toContain('ALTER TABLE "users" ADD "phone" varchar(20);');
    expect(sql).not.toContain("NOT NULL");
    expect(sql).not.toContain("DEFAULT");
  });

  test("no transaction wrapper, because CQL has neither BEGIN nor COMMIT", () => {
    // Measured on 5.0.9: `BEGIN;` answers "line 1:5 mismatched input ';' expecting
    // K_BATCH" and `COMMIT;` answers "no viable alternative at input 'COMMIT'". CQL's
    // only grouping is `BEGIN BATCH ... APPLY BATCH`, which is not a transaction and
    // takes no DDL. The shared wrapper is gated on `!== "sqlite"` alone, so Cassandra
    // inherited it the moment the type id existed - putting a statement the server
    // refuses on the first line of a migration whose ALTERs otherwise run.
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "cassandra");

    expect(sql).not.toContain("BEGIN;");
    expect(sql).not.toContain("COMMIT;");
  });

  test("no foreign-key statement, because the clause is not in the grammar", () => {
    // Measured on 5.0.9: `ALTER TABLE probe.customers ADD CONSTRAINT fk_x FOREIGN KEY
    // (id) REFERENCES probe.orders (id)` is "line 1:48 mismatched input 'FOREIGN'
    // expecting EOF", and `DROP CONSTRAINT IF EXISTS fk_x` is "mismatched input 'IF'".
    //
    // Reachable even though the provider reports `declaresForeignKeys: false`, which is
    // what makes this worth a branch: `SchemaDiff.tsx` takes the dialect from the CURRENT
    // connection and the diff from a snapshot that may belong to a DIFFERENT one, so a
    // Cassandra connection compared against a PostgreSQL snapshot carries foreign keys
    // into this generator. The sqlite branch beside it declines the same way.
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "cassandra");

    expect(sql).not.toContain("FOREIGN KEY");
    expect(sql).not.toContain("ADD CONSTRAINT");
    expect(sql).not.toContain("DROP CONSTRAINT");
    expect(sql).toContain("-- Apache Cassandra: Cannot add a foreign key");
    expect(sql).toContain("-- Apache Cassandra: Cannot drop a foreign key");
  });

  test("libSQL declines both directions too, because SQLite declares a key only in CREATE TABLE", () => {
    // Measured over Hrana on sqld 0.24.33: `ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY
    // (c) REFERENCES u(id)` is "near CONSTRAINT ... syntax error", and so is the DROP.
    // The generic branch would emit both, so both are declined here - and the column
    // statements around them are NOT: libSQL accepts ADD COLUMN and DROP COLUMN, which
    // is what makes this narrower than the sqlite branch beside it.
    const sql = generateMigrationSQL(makeModifiedTableDiff(), "libsql");

    expect(sql).not.toContain("ADD CONSTRAINT");
    expect(sql).not.toContain("DROP CONSTRAINT");
    expect(sql).toContain("-- libSQL: Cannot add a foreign key");
    expect(sql).toContain("-- libSQL: Cannot drop a foreign key");
    expect(sql).toContain("ADD COLUMN");
    expect(sql).toContain("DROP COLUMN");
    // SQLite runs its own transaction and this provider could not continue one it
    // emitted, so the file carries no wrapper.
    expect(sql).not.toContain("BEGIN;");
  });
});

describe("generateMigrationSQL: Cassandra declines CREATE TABLE rather than guess the partitioning", () => {
  // `src/components/SchemaDiff.tsx` calls this generator with the connection's `type`
  // and never consults `supportsCreateTable`, so the refusal the provider already
  // publishes (`cassandra/index.ts`) has to be repeated on this path or the two
  // contradict each other.
  //
  // Measured on 5.0.9 against two probe tables that differ only in one pair of
  // brackets - `probe.composite_pk` is `PRIMARY KEY ((tenant, day), ts)` and
  // `probe.pk_flat` is `PRIMARY KEY (tenant, day, ts)`. `SELECT * FROM probe.pk_flat
  // WHERE tenant = 'a'` is served; the same restriction on `probe.composite_pk`
  // answers code 2200, "Cannot execute this query as it might involve data filtering
  // and thus may have unpredictable performance". `system_schema.columns` reports the
  // same three columns as key columns for both, and `ColumnDiff` keeps only
  // `targetIsPrimary` - so the diff cannot say which of the two physical layouts was
  // meant, and the shared `PRIMARY KEY (a, b, c)` serializer would silently pick the
  // flat one.
  test("an added table emits a refusal naming the reason, not CREATE TABLE", () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), "cassandra");

    expect(sql).toContain('-- Apache Cassandra: Cannot generate CREATE TABLE for "users".');
    expect(sql).toContain("partition key and clustering columns");
    // Not the statement, and not the statement commented out either.
    expect(sql).not.toMatch(/^\s*(--\s*)?CREATE TABLE/m);
    expect(sql).not.toContain("PRIMARY KEY (");
    expect(sql).not.toContain('"id" integer');
  });

  test("the declined table takes its indexes with it, since there is no table to index", () => {
    const sql = generateMigrationSQL(makeAddedTableDiff(), "cassandra");

    expect(sql).not.toContain("idx_users_email");
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX/);
  });
});

/**
 * Exhaustive by construction, in the spirit of `PICKER_COVERAGE` in
 * `tests/hooks/use-connection-form.test.ts`: a new `DatabaseType` fails typecheck here until it is
 * classified, so it cannot silently re-inherit the generator's PostgreSQL branch — which is the whole
 * of #269. `"has-own-branch"` means the modified-column chain answers that id in its own dialect.
 */
const MODIFIED_COLUMN_COVERAGE: Record<DatabaseType, { label: string; reason: string } | "has-own-branch"> = {
  postgres: "has-own-branch",
  mysql: "has-own-branch",
  sqlite: "has-own-branch",
  // NOT "has-own-branch": libSQL accepts DROP COLUMN and RENAME COLUMN (measured on
  // sqld 0.24.33), so it takes the generic branch for those and only the column
  // MODIFICATION is inexpressible - which is what NO_COLUMN_MODIFICATION records.
  libsql: {
    label: "libSQL",
    reason: "SQLite cannot retype a column; recreate the table and copy the rows.",
  },
  oracle: "has-own-branch",
  mssql: "has-own-branch",
  clickhouse: "has-own-branch",
  couchbase: { label: "Couchbase", reason: "schemaless JSON documents" },
  druid: { label: "Apache Druid", reason: "no ALTER TABLE" },
  // Measured on Trino 476 and NOT an "unsupported" guess: the PostgreSQL branch's own
  // text is a SYNTAX error here (`ALTER TABLE ... ALTER COLUMN id TYPE varchar` ->
  // "line 1:50: mismatched input 'TYPE'. Expecting: '.', 'DROP', 'SET'"), and Trino's
  // own spelling then hands the question to the catalog, which answered "This
  // connector does not support setting column types". So there is no one statement a
  // portable migration could carry.
  trino: { label: "Trino", reason: "the connector" },
  // Neither grammar has ALTER at all (measured on Elasticsearch 9.1.4 and OpenSearch
  // 3.8.0), and a mapping's existing field cannot be retyped even outside SQL, so the
  // comment sends the user to a reindex rather than to a statement.
  elasticsearch: { label: "Elasticsearch", reason: "reindexing into an index" },
  opensearch: { label: "OpenSearch", reason: "reindexing into an index" },
  // Measured on Cassandra 5.0.9, and the reason is the engine's own sentence:
  // `ALTER TABLE probe.customers ALTER name TYPE blob` answers "Altering column types
  // is no longer supported". The PostgreSQL branch's text would not even parse
  // (`ALTER COLUMN` is not in CQL's grammar), so nothing portable can be emitted.
  cassandra: { label: "Apache Cassandra", reason: "no longer supports altering a column's type" },
  mongodb: { label: "MongoDB", reason: "schemaless" },
  redis: { label: "Redis", reason: "no column definitions" },
  libredb: { label: "LibreDB", reason: "JSON command grammar" },
};

describe("generateMigrationSQL: dialects that cannot modify a column", () => {
  for (const [dialect, expected] of Object.entries(MODIFIED_COLUMN_COVERAGE)) {
    if (expected === "has-own-branch") continue;

    test(`${dialect}: modified column emits a comment naming the limitation, never PostgreSQL DDL`, () => {
      const sql = generateMigrationSQL(makeModifiedTableDiff(), dialect as DatabaseType);
      expect(sql).toContain(`-- ${expected.label}: Cannot alter column "name".`);
      expect(sql).toContain(expected.reason);
      expect(sql).not.toContain("ALTER COLUMN");
      expect(sql).not.toContain("MODIFY COLUMN");
      expect(sql).not.toContain("MODIFY (");
    });
  }
});

// ============================================================================
// Multi-table diff
// ============================================================================

describe("generateMigrationSQL: multi-table batch", () => {
  test("handles added + removed + modified in one batch", () => {
    const diff: SchemaDiff = {
      tables: [
        {
          action: "removed",
          tableName: "legacy",
          columns: [{ action: "removed", columnName: "id", sourceType: "int", changes: [] }],
          indexes: [],
          foreignKeys: [],
        },
        {
          action: "added",
          tableName: "new_table",
          columns: [
            {
              action: "added",
              columnName: "id",
              targetType: "integer",
              targetNullable: false,
              targetIsPrimary: true,
              changes: [],
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
        {
          action: "modified",
          tableName: "users",
          columns: [
            { action: "added", columnName: "phone", targetType: "varchar(20)", targetNullable: true, changes: [] },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
      summary: { added: 1, removed: 1, modified: 1 },
      hasChanges: true,
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(sql).toContain('DROP TABLE IF EXISTS "legacy"');
    expect(sql).toContain('CREATE TABLE "new_table"');
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN "phone"');
  });
});
