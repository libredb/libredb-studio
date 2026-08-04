import type { DatabaseType } from "@/lib/types";
// The shared quoter, which also escapes an embedded closing quote character — this
// file used to carry its own copy that did not, so a schema object named with one
// produced SQL that ended the quoted span early (PR #289 review).
import { quoteIdentifier as escapeIdentifier } from "@/lib/sql/identifier";
import type { SchemaDiff, TableDiff, ColumnDiff } from "./types";

/**
 * ClickHouse column-default kinds as `system.columns.default_kind` reports them, and as
 * `clickhouse/introspect.ts:readDefault` prefixes them onto the expression it hands the diff engine.
 * `DEFAULT` is the only kind that arrives bare, so a value starting with one of these already names
 * its own clause and must not be put behind another `DEFAULT` keyword.
 *
 * Live-probed against the pinned `clickhouse-server:26.7.1.1315` build:
 * `MODIFY COLUMN "y" Int32 DEFAULT MATERIALIZED toYear(d)` is a syntax error (code 62) while
 * `MODIFY COLUMN "y" Int32 MATERIALIZED toYear(d)` is accepted, and switching kind in one statement
 * works. `REMOVE` takes `DEFAULT`, `MATERIALIZED` or `ALIAS` only — `REMOVE EPHEMERAL` is rejected
 * (code 62, "Expected one of: DEFAULT, MATERIALIZED, ALIAS, COMMENT, CODEC, TTL, SETTINGS") — and
 * `REMOVE DEFAULT` against a column that has none is an error too (code 36), which is why the branch
 * below only emits it for a default that existed.
 */
const CLICKHOUSE_DEFAULT_KINDS = ["MATERIALIZED", "ALIAS", "EPHEMERAL"];
const CLICKHOUSE_REMOVABLE_KINDS = ["DEFAULT", "MATERIALIZED", "ALIAS"];

function clickhouseDefaultKind(value: string): string {
  return CLICKHOUSE_DEFAULT_KINDS.find((kind) => value.startsWith(`${kind} `)) ?? "DEFAULT";
}

/**
 * Canonical type ids whose engine has no column-modification statement at all.
 *
 * The modified-column path below branches per dialect and ends in a PostgreSQL `else`, so every id
 * without a branch used to be handed `ALTER TABLE ... ALTER COLUMN` no matter what it can run
 * (#269). Naming the limitation in a comment instead is this generator's own precedent — the SQLite
 * branch already answers an inexpressible change that way, because a comment a human can read beats
 * DDL the target engine can only reject.
 *
 * The value completes `-- <label>: Cannot alter column "<name>". <reason>`. The labels deliberately
 * repeat `db-ui-config.ts`'s display names instead of reading them from it: that registry carries React
 * icon components, which this pure SQL module must not pull in, and the `SQLite` comments elsewhere in
 * this file spell their engine out the same way.
 */
const NO_COLUMN_MODIFICATION: Partial<Record<DatabaseType, { label: string; reason: string }>> = {
  couchbase: {
    label: "Couchbase",
    reason: "Collections hold schemaless JSON documents, so there is no column definition to change.",
  },
  druid: {
    label: "Apache Druid",
    reason: "Druid SQL has no ALTER TABLE; rewrite the datasource with REPLACE INTO through an MSQ task.",
  },
  mongodb: {
    label: "MongoDB",
    reason: "Collections are schemaless, so there is no column definition to change.",
  },
  redis: {
    label: "Redis",
    reason: "Keys are not tables and have no column definitions to change.",
  },
  libredb: {
    label: "LibreDB",
    reason: "The embedded engine speaks a JSON command grammar, not SQL DDL.",
  },
};

function generateColumnDef(col: ColumnDiff, dialect: DatabaseType): string {
  const type = col.targetType || col.sourceType || "TEXT";
  const nullable = col.targetNullable === false ? " NOT NULL" : "";
  const defaultVal = col.targetDefault ? ` DEFAULT ${col.targetDefault}` : "";
  return `${escapeIdentifier(col.columnName, dialect)} ${type}${nullable}${defaultVal}`;
}

function generateCreateTable(table: TableDiff, dialect: DatabaseType): string {
  const lines: string[] = [];
  const id = escapeIdentifier(table.tableName, dialect);

  const colDefs = table.columns.filter((c) => c.action === "added").map((c) => `  ${generateColumnDef(c, dialect)}`);

  // Add primary key constraint
  const pkCols = table.columns.filter((c) => c.targetIsPrimary).map((c) => escapeIdentifier(c.columnName, dialect));

  lines.push(`CREATE TABLE ${id} (`);
  lines.push(colDefs.join(",\n"));
  if (pkCols.length > 0) {
    lines.push(`,  PRIMARY KEY (${pkCols.join(", ")})`);
  }
  lines.push(");");

  // Indexes
  table.indexes
    .filter((i) => i.action === "added")
    .forEach((idx) => {
      const unique = idx.targetUnique ? "UNIQUE " : "";
      const cols = (idx.targetColumns || []).map((c) => escapeIdentifier(c, dialect)).join(", ");
      lines.push(`CREATE ${unique}INDEX ${escapeIdentifier(idx.indexName, dialect)} ON ${id} (${cols});`);
    });

  // Foreign keys
  table.foreignKeys
    .filter((fk) => fk.action === "added")
    .forEach((fk) => {
      lines.push(
        `ALTER TABLE ${id} ADD CONSTRAINT ${escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect)} FOREIGN KEY (${escapeIdentifier(fk.columnName, dialect)}) REFERENCES ${escapeIdentifier(fk.targetReferencedTable || "", dialect)}(${escapeIdentifier(fk.targetReferencedColumn || "", dialect)});`,
      );
    });

  return lines.join("\n");
}

function generateDropTable(table: TableDiff, dialect: DatabaseType): string {
  return `DROP TABLE IF EXISTS ${escapeIdentifier(table.tableName, dialect)};`;
}

function generateAlterTable(table: TableDiff, dialect: DatabaseType): string {
  const lines: string[] = [];
  const id = escapeIdentifier(table.tableName, dialect);

  lines.push(`-- Alter table: ${table.tableName}`);

  // Added columns
  table.columns
    .filter((c) => c.action === "added")
    .forEach((col) => {
      lines.push(`ALTER TABLE ${id} ADD COLUMN ${generateColumnDef(col, dialect)};`);
    });

  // Removed columns
  table.columns
    .filter((c) => c.action === "removed")
    .forEach((col) => {
      if (dialect === "sqlite") {
        lines.push(`-- SQLite: Cannot drop column "${col.columnName}" directly. Requires table recreation.`);
      } else {
        lines.push(`ALTER TABLE ${id} DROP COLUMN ${escapeIdentifier(col.columnName, dialect)};`);
      }
    });

  // Modified columns
  const inexpressible = NO_COLUMN_MODIFICATION[dialect];
  table.columns
    .filter((c) => c.action === "modified")
    .forEach((col) => {
      if (dialect === "sqlite") {
        lines.push(`-- SQLite: Cannot alter column "${col.columnName}" type directly. Requires table recreation.`);
      } else if (dialect === "mysql") {
        const type = col.targetType || col.sourceType || "TEXT";
        const nullable = col.targetNullable === false ? " NOT NULL" : " NULL";
        const defaultVal = col.targetDefault ? ` DEFAULT ${col.targetDefault}` : "";
        lines.push(
          `ALTER TABLE ${id} MODIFY COLUMN ${escapeIdentifier(col.columnName, dialect)} ${type}${nullable}${defaultVal};`,
        );
      } else if (dialect === "oracle") {
        const type = col.targetType || col.sourceType || "VARCHAR2(255)";
        const nullable = col.targetNullable === false ? " NOT NULL" : " NULL";
        const defaultVal = col.targetDefault ? ` DEFAULT ${col.targetDefault}` : "";
        lines.push(
          `ALTER TABLE ${id} MODIFY (${escapeIdentifier(col.columnName, dialect)} ${type}${defaultVal}${nullable});`,
        );
      } else if (dialect === "mssql") {
        const type = col.targetType || col.sourceType || "NVARCHAR(MAX)";
        const nullable = col.targetNullable === false ? " NOT NULL" : " NULL";
        lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} ${type}${nullable};`);
        if (col.sourceDefault !== col.targetDefault && col.targetDefault) {
          lines.push(
            `ALTER TABLE ${id} ADD DEFAULT ${col.targetDefault} FOR ${escapeIdentifier(col.columnName, dialect)};`,
          );
        }
      } else if (dialect === "clickhouse") {
        // Nullability is part of the type here (`Nullable(T)`) — which is exactly what this
        // provider's introspection reports (`clickhouse/introspect.ts`) — so restating the declared
        // type covers a nullability change too; there is no `SET NOT NULL`. Dropping a default needs
        // the explicit `REMOVE <kind>` form: omitting the clause leaves the old default in place
        // (live-probed). See CLICKHOUSE_DEFAULT_KINDS for the kind vocabulary and its traps.
        const column = escapeIdentifier(col.columnName, dialect);
        const type = col.targetType || col.sourceType || "String";
        let declared = "";
        if (col.targetDefault) {
          const kind = clickhouseDefaultKind(col.targetDefault);
          declared = kind === "DEFAULT" ? ` DEFAULT ${col.targetDefault}` : ` ${col.targetDefault}`;
        }
        lines.push(`ALTER TABLE ${id} MODIFY COLUMN ${column} ${type}${declared};`);
        if (col.sourceDefault && !col.targetDefault) {
          const kind = clickhouseDefaultKind(col.sourceDefault);
          if (CLICKHOUSE_REMOVABLE_KINDS.includes(kind)) {
            lines.push(`ALTER TABLE ${id} MODIFY COLUMN ${column} REMOVE ${kind};`);
          } else {
            lines.push(
              `-- ClickHouse: Cannot remove the ${kind} property of column "${col.columnName}". REMOVE accepts DEFAULT, MATERIALIZED or ALIAS only; recreate the column.`,
            );
          }
        }
      } else if (inexpressible) {
        lines.push(`-- ${inexpressible.label}: Cannot alter column "${col.columnName}". ${inexpressible.reason}`);
      } else {
        // PostgreSQL
        if (col.sourceType !== col.targetType) {
          lines.push(
            `ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} TYPE ${col.targetType};`,
          );
        }
        if (col.sourceNullable !== col.targetNullable) {
          if (col.targetNullable) {
            lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} DROP NOT NULL;`);
          } else {
            lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} SET NOT NULL;`);
          }
        }
        if (col.sourceDefault !== col.targetDefault) {
          if (col.targetDefault) {
            lines.push(
              `ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} SET DEFAULT ${col.targetDefault};`,
            );
          } else {
            lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} DROP DEFAULT;`);
          }
        }
      }
    });

  // Added indexes
  table.indexes
    .filter((i) => i.action === "added")
    .forEach((idx) => {
      const unique = idx.targetUnique ? "UNIQUE " : "";
      const cols = (idx.targetColumns || []).map((c) => escapeIdentifier(c, dialect)).join(", ");
      lines.push(`CREATE ${unique}INDEX ${escapeIdentifier(idx.indexName, dialect)} ON ${id} (${cols});`);
    });

  // Removed indexes
  table.indexes
    .filter((i) => i.action === "removed")
    .forEach((idx) => {
      if (dialect === "mysql") {
        lines.push(`DROP INDEX ${escapeIdentifier(idx.indexName, dialect)} ON ${id};`);
      } else {
        lines.push(`DROP INDEX IF EXISTS ${escapeIdentifier(idx.indexName, dialect)};`);
      }
    });

  // Added foreign keys
  table.foreignKeys
    .filter((fk) => fk.action === "added")
    .forEach((fk) => {
      const constraintName = escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect);
      lines.push(
        `ALTER TABLE ${id} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${escapeIdentifier(fk.columnName, dialect)}) REFERENCES ${escapeIdentifier(fk.targetReferencedTable || "", dialect)}(${escapeIdentifier(fk.targetReferencedColumn || "", dialect)});`,
      );
    });

  // Removed foreign keys
  table.foreignKeys
    .filter((fk) => fk.action === "removed")
    .forEach((fk) => {
      const constraintName = escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect);
      if (dialect === "mysql") {
        lines.push(`ALTER TABLE ${id} DROP FOREIGN KEY ${constraintName};`);
      } else if (dialect === "sqlite") {
        lines.push(`-- SQLite: Cannot drop foreign key directly. Requires table recreation.`);
      } else {
        lines.push(`ALTER TABLE ${id} DROP CONSTRAINT IF EXISTS ${constraintName};`);
      }
    });

  return lines.join("\n");
}

export function generateMigrationSQL(diff: SchemaDiff, dialect: DatabaseType): string {
  if (!diff.hasChanges) {
    return "-- No schema changes detected.";
  }

  const sections: string[] = [];
  sections.push(`-- Migration generated at ${new Date().toISOString()}`);
  sections.push(`-- Dialect: ${dialect}`);
  sections.push(
    `-- Changes: ${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.modified} modified`,
  );
  sections.push("");

  if (dialect !== "sqlite") {
    sections.push("BEGIN;");
    sections.push("");
  }

  // Drop tables first (reverse dependency order)
  const droppedTables = diff.tables.filter((t) => t.action === "removed");
  if (droppedTables.length > 0) {
    sections.push("-- Drop removed tables");
    droppedTables.forEach((t) => sections.push(generateDropTable(t, dialect)));
    sections.push("");
  }

  // Create new tables
  const addedTables = diff.tables.filter((t) => t.action === "added");
  if (addedTables.length > 0) {
    sections.push("-- Create new tables");
    addedTables.forEach((t) => {
      sections.push(generateCreateTable(t, dialect));
      sections.push("");
    });
  }

  // Alter existing tables
  const modifiedTables = diff.tables.filter((t) => t.action === "modified");
  if (modifiedTables.length > 0) {
    sections.push("-- Modify existing tables");
    modifiedTables.forEach((t) => {
      sections.push(generateAlterTable(t, dialect));
      sections.push("");
    });
  }

  if (dialect !== "sqlite") {
    sections.push("COMMIT;");
  }

  return sections.join("\n");
}
