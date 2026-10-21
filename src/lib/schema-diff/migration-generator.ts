/**
 * Migration SQL from a schema diff. Each engine's statements, and the comment that names a limitation where the
 * engine has no statement to write (#284), are declared by its own module beside its provider and collected in
 * `src/lib/db/migration-ddl/` (spec 5.3); this file only orders them and quotes every identifier. The live
 * regression probe is tests/live/schema-diff-dialects.ts.
 *
 * A diff is not a complete migration plan: source constraint names and
 * cross-table dependency order are not recorded here, and a foreign key's
 * referenced table is written as the reading spelled it. Tables are named by
 * their full path when the diff carries one, and an object that is not a table
 * (a view, a materialized view) is named in a comment rather than altered.
 * Review the generated SQL before executing it against the target database.
 */
import { migrationDdlFor, migrationDialectHeader } from "@/lib/db/migration-ddl";
import { commentName } from "@/lib/db/migration-ddl/shared";
import type { ForeignKeyDdl, IndexDdl, InsideOrAfter, TableDdlWritten } from "@/lib/db/migration-ddl/types";
import type { DatabaseType } from "@/lib/types";
// The shared quoter, which also escapes an embedded closing quote character — this
// file used to carry its own copy that did not, so a schema object named with one
// produced SQL that ended the quoted span early (PR #289 review).
import { quoteIdentifier as escapeIdentifier } from "@/lib/sql/identifier";
import type { SchemaDiff, TableDiff, ForeignKeyDiff, IndexDiff } from "./types";

/**
 * The table as the statement names it: every segment of its path quoted on its own, container first, so
 * `b2a.t1` is `"b2a"."t1"` and never the `"t1"` that a search path resolves to another schema's table (SF-047,
 * BACKLOG D150). A diff with no paths, a snapshot taken before the object model, names it by `tableName` as before.
 */
function tableId(table: TableDiff, dialect: DatabaseType | undefined): string {
  if (table.path === undefined || table.path.length < 2) return escapeIdentifier(table.tableName, dialect);
  return table.path.map((segment) => escapeIdentifier(segment, dialect)).join(".");
}

/**
 * An index named in a `DROP INDEX` with no `ON <table>`: in the table's container, which is where the engine created
 * it, rather than wherever the session's search path points.
 */
function indexId(table: TableDiff, indexName: string, dialect: DatabaseType | undefined): string {
  if (table.path === undefined || table.path.length < 2) return escapeIdentifier(indexName, dialect);
  return [...table.path.slice(0, -1), indexName].map((segment) => escapeIdentifier(segment, dialect)).join(".");
}

/** What a comment calls the object: its label in the diff, else its name. */
function tableLabel(table: TableDiff): string {
  return commentName(table.label ?? table.tableName);
}

/**
 * Whether the migration may write table DDL for this object. Only a table: a view, a materialized view or a stream
 * that differs is named in a comment, because `ALTER TABLE` on a view alters nothing it should (MySQL measured: the
 * migration wrote `ALTER TABLE \`v1\` MODIFY COLUMN ...` for a view). An object whose reading declared no kind, a
 * snapshot from before the object model, is treated as a table, as it always was.
 */
function isTableDdlTarget(table: TableDiff): boolean {
  return table.kind === undefined || table.kind === "table";
}

/**
 * The comment that stands where a non-table object's DDL would be. It also says that a view left in place can stop an
 * ALTER or DROP below: PostgreSQL refuses to change the type of a column a view reads ("cannot alter type of a column
 * used by a view or rule"), so the script rolls back until that view is dropped first and recreated after.
 */
function skippedObject(table: TableDiff): string {
  return `-- Skipped ${tableLabel(table)} (${commentName(table.kind ?? "")}): only tables are created, altered or dropped here; change it by hand. If it reads a table changed below, drop it before this script and recreate it after.`;
}

/** The quoted parts of one index, as every module's index statements take them. */
function indexDdl(table: TableDiff, idx: IndexDiff, dialect: DatabaseType | undefined): IndexDdl {
  return {
    name: escapeIdentifier(idx.indexName, dialect),
    qualifiedName: indexId(table, idx.indexName, dialect),
    unique: idx.targetUnique === true,
    columns: (idx.targetColumns || []).map((c) => escapeIdentifier(c, dialect)),
  };
}

/** The quoted parts of one foreign key; the `fk_<table>_<column>` name is this generator's own. */
function foreignKeyDdl(table: TableDiff, fk: ForeignKeyDiff, dialect: DatabaseType | undefined): ForeignKeyDdl {
  return {
    constraint: escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect),
    column: escapeIdentifier(fk.columnName, dialect),
    references: `${escapeIdentifier(fk.targetReferencedTable || "", dialect)}(${escapeIdentifier(fk.targetReferencedColumn || "", dialect)})`,
  };
}

function generateCreateTable(table: TableDiff, spec: TableDdlWritten, dialect: DatabaseType | undefined): string {
  const lines: string[] = [];
  const id = tableId(table, dialect);

  if (spec.createTable.kind === "refused") return spec.createTable.createTableRefusal(id);
  const create = spec.createTable;

  const colDefs = table.columns
    .filter((c) => c.action === "added")
    .map((c) => `  ${spec.columnDef(c, escapeIdentifier(c.columnName, dialect))}`);

  // Add primary key constraint
  const pkCols = table.columns.filter((c) => c.targetIsPrimary).map((c) => escapeIdentifier(c.columnName, dialect));
  // An engine with no primary-key constraint answers `after`, a comment that declines the key.
  const key: InsideOrAfter | undefined = pkCols.length > 0 ? create.primaryKey(pkCols) : undefined;
  const keyWritten = key !== undefined && "inside" in key;

  // A key the target can only declare here has to be emitted here, so the closing paren is not
  // written until the constraint list is complete.
  const foreignKeys = table.foreignKeys
    .filter((fk) => fk.action === "added")
    .map((fk) => create.foreignKey(foreignKeyDdl(table, fk, dialect), id));

  lines.push(`CREATE TABLE ${id} (`);
  lines.push(colDefs.join(",\n"));
  if (key !== undefined && "inside" in key) {
    lines.push(key.inside);
  }
  foreignKeys.forEach((fk) => {
    if ("inside" in fk) lines.push(fk.inside);
  });
  lines.push(");");
  if (key !== undefined && "after" in key) {
    lines.push(key.after);
  }

  // Indexes, less the one the PRIMARY KEY line above already builds. An engine that reports
  // its key's index in the index list (PostgreSQL's `<table>_pkey`, MySQL's `PRIMARY`) creates
  // that index with the constraint, so emitting it again aborts the migration: measured on
  // PostgreSQL 18.6, `CREATE UNIQUE INDEX "ui_t_pkey"` after the CREATE TABLE is
  // `relation "ui_t_pkey" already exists` (#1395), and MySQL refuses an index named
  // `PRIMARY`. The index is recognised by what it is, a unique index over exactly the key's
  // columns, because its name is the engine's own choice. The columns are compared as a set,
  // since the PRIMARY KEY line is written in table order and `IndexDiff` carries no primary
  // flag; so a second unique index over the same columns, in any order, is skipped with it.
  const keyColumns = new Set(table.columns.filter((c) => c.targetIsPrimary).map((c) => c.columnName));
  const backsTheKey = (idx: IndexDiff): boolean => {
    const columns = idx.targetColumns ?? [];
    return (
      keyWritten &&
      idx.targetUnique === true &&
      columns.length === keyColumns.size &&
      columns.every((column) => keyColumns.has(column))
    );
  };
  table.indexes
    .filter((i) => i.action === "added" && !backsTheKey(i))
    .forEach((idx) => lines.push(spec.createIndex(indexDdl(table, idx, dialect), id)));

  // Foreign keys. Already emitted above for the engines that can only declare one inside the
  // statement; for everyone else this separate statement is the shape that has always been emitted here.
  foreignKeys.forEach((fk) => {
    if ("after" in fk) lines.push(fk.after);
  });

  return lines.join("\n");
}

function generateAlterTable(table: TableDiff, spec: TableDdlWritten, dialect: DatabaseType | undefined): string {
  const lines: string[] = [];
  const id = tableId(table, dialect);

  lines.push(`-- Alter table: ${tableLabel(table)}`);

  // Drop recorded dependencies before altering their columns or reusing their names.
  // Removed foreign keys
  table.foreignKeys
    .filter((fk) => fk.action === "removed")
    .forEach((fk) => {
      lines.push(spec.dropForeignKey(escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect), id));
    });

  // Changed indexes need replacement too. Drop the old definition before column
  // changes, then recreate it with the target columns and uniqueness below.
  table.indexes
    .filter((i) => i.action === "removed" || i.action === "modified")
    .forEach((idx) => lines.push(spec.dropIndex(indexDdl(table, idx, dialect), id)));

  // Added columns
  table.columns
    .filter((c) => c.action === "added")
    .forEach((col) => {
      lines.push(spec.addColumn(spec.columnDef(col, escapeIdentifier(col.columnName, dialect)), id));
    });

  // Removed columns
  table.columns
    .filter((c) => c.action === "removed")
    .forEach((col) => lines.push(spec.dropColumn(col, escapeIdentifier(col.columnName, dialect), id)));

  // Modified columns
  table.columns
    .filter((c) => c.action === "modified")
    .forEach((col) => lines.push(...spec.modifyColumn(col, escapeIdentifier(col.columnName, dialect), id)));

  // Added and replaced indexes
  table.indexes
    .filter((i) => i.action === "added" || i.action === "modified")
    .forEach((idx) => lines.push(spec.createIndex(indexDdl(table, idx, dialect), id)));

  // Added foreign keys
  table.foreignKeys
    .filter((fk) => fk.action === "added")
    .forEach((fk) => lines.push(spec.addForeignKey(foreignKeyDdl(table, fk, dialect), id)));

  return lines.join("\n");
}

export function generateMigrationSQL(diff: SchemaDiff, dialect: DatabaseType | undefined): string {
  if (!diff.hasChanges) {
    return "-- No schema changes detected.";
  }

  const spec = migrationDdlFor(dialect);
  const sections: string[] = [];
  sections.push(`-- Migration generated at ${new Date().toISOString()}`);
  sections.push(`-- Dialect: ${migrationDialectHeader(dialect)}`);
  sections.push(
    `-- Changes: ${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.modified} modified`,
  );
  sections.push("");

  if (spec.tableDdl === "refused") {
    sections.push(spec.refusal);
    return sections.join("\n");
  }

  // ONE definition, read twice: the opening and the closing halves of this wrapper used
  // to be two independent conditions, which is a shape that can diverge into a `BEGIN;`
  // with no `COMMIT;`. Each module's docblock says why its engine has a wrapper or none.
  const wrapper = spec.transactionWrapper;

  if (wrapper !== null) {
    sections.push(wrapper.begin);
    sections.push("");
  }

  // A view, a materialized view or a stream that differs: named, never written as a table (SF-047).
  const skipped = diff.tables.filter((t) => !isTableDdlTarget(t));
  if (skipped.length > 0) {
    sections.push("-- Objects that are not tables");
    skipped.forEach((t) => sections.push(skippedObject(t)));
    sections.push("");
  }

  // Drop tables first (reverse dependency order)
  const droppedTables = diff.tables.filter((t) => t.action === "removed" && isTableDdlTarget(t));
  if (droppedTables.length > 0) {
    sections.push("-- Drop removed tables");
    droppedTables.forEach((t) => sections.push(spec.dropTable(tableId(t, dialect))));
    sections.push("");
  }

  // Create new tables
  const addedTables = diff.tables.filter((t) => t.action === "added" && isTableDdlTarget(t));
  if (addedTables.length > 0) {
    sections.push("-- Create new tables");
    addedTables.forEach((t) => {
      sections.push(generateCreateTable(t, spec, dialect));
      sections.push("");
    });
  }

  // Alter existing tables
  const modifiedTables = diff.tables.filter((t) => t.action === "modified" && isTableDdlTarget(t));
  if (modifiedTables.length > 0) {
    sections.push("-- Modify existing tables");
    modifiedTables.forEach((t) => {
      sections.push(generateAlterTable(t, spec, dialect));
      sections.push("");
    });
  }

  if (wrapper !== null) {
    sections.push(wrapper.commit);
  }

  return sections.join("\n");
}
