/**
 * Migration SQL from a schema diff. Each engine's statements, and the comment that names a limitation where the
 * engine has no statement to write (#284), are declared by its own module beside its provider and collected in
 * `src/lib/db/migration-ddl/` (spec 5.3); this file only orders them and quotes every identifier. The live
 * regression probe is tests/live/schema-diff-dialects.ts.
 *
 * A diff is not a complete migration plan: source constraint names are not
 * recorded here. New tables are created in the order their foreign keys need,
 * the table a key references first, and a key that closes a cycle between new
 * tables is added after all of them exist (R7); a dropped table is dropped
 * before any other change, whatever still references it. A foreign key's
 * referenced table is named by its path only where the target reading holds it,
 * and otherwise as the reading spelled it. Tables are named by
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
import type { ColumnDiff, SchemaDiff, TableDiff, ForeignKeyDiff, IndexDiff } from "./types";

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

/**
 * The referenced table as the statement names it: each segment of its path quoted on its own where the diff placed
 * it, so `app.customers` is `"app"."customers"` and not the one identifier `"app.customers"` that names no table
 * (D05). A reference the diff could not place is the reading's spelling quoted whole, as it always was.
 *
 * The containers it shares with the referencing table are left out, down to the innermost one, which is always kept:
 * SQL Server's REFERENCES takes `schema.table` and not the `database.schema.table` its tables are addressed by, and
 * no engine's foreign key leaves the referencing table's database. A table with no container is its name alone.
 */
function referencedTableId(table: TableDiff, fk: ForeignKeyDiff, dialect: DatabaseType | undefined): string {
  const path = fk.targetReferencedPath;
  if (path === undefined) return escapeIdentifier(fk.targetReferencedTable || "", dialect);
  const own = (table.path ?? []).slice(0, -1);
  let shared = 0;
  while (shared < own.length && shared < path.length - 2 && own[shared] === path[shared]) shared++;
  return path
    .slice(shared)
    .map((segment) => escapeIdentifier(segment, dialect))
    .join(".");
}

/** The quoted parts of one foreign key; the `fk_<table>_<column>` name is this generator's own. */
function foreignKeyDdl(table: TableDiff, fk: ForeignKeyDiff, dialect: DatabaseType | undefined): ForeignKeyDdl {
  return {
    constraint: escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect),
    column: escapeIdentifier(fk.columnName, dialect),
    references: `${referencedTableId(table, fk, dialect)}(${escapeIdentifier(fk.targetReferencedColumn || "", dialect)})`,
  };
}

/**
 * The column as every module's statements read it: its type is the declaration where the provider read one
 * (`character varying(50)`, `numeric(12,2)`), not the base name, which wrote a table without its lengths and
 * precisions (D05). Done here, once, so no engine module has to know the field exists.
 */
function written(col: ColumnDiff): ColumnDiff {
  return {
    ...col,
    sourceType: col.sourceDeclaredType ?? col.sourceType,
    targetType: col.targetDeclaredType ?? col.targetType,
  };
}

/** One table's identity, as its own path or, in a diff without paths, its name. */
function tableKey(path: readonly string[] | undefined, name: string): string {
  return JSON.stringify(path ?? [name]);
}

/** The table a foreign key references, keyed the way `tableKey` keys the table itself. */
function referenceKey(fk: ForeignKeyDiff): string {
  return tableKey(fk.targetReferencedPath, fk.targetReferencedTable ?? "");
}

/**
 * New tables in the order their foreign keys need: a table is written once every other new table it references
 * has been (R7). Measured on SQL Server 2022, MySQL 8.4 and Db2: in the reading's order, `rg_orders` and its key to
 * `rg_ext` came before `rg_ext` existed and the script stopped there. Stable, so a table nothing orders keeps its
 * place; a cycle is broken at its first table in the reading's order, and the key that closes it waits (`deferred`).
 */
function inDependencyOrder(tables: readonly TableDiff[]): TableDiff[] {
  const keys = new Set(tables.map((t) => tableKey(t.path, t.tableName)));
  const needs = (t: TableDiff): Set<string> =>
    new Set(
      t.foreignKeys
        .filter((fk) => fk.action === "added")
        .map(referenceKey)
        .filter((key) => keys.has(key) && key !== tableKey(t.path, t.tableName)),
    );
  const pending = tables.map((t) => ({ table: t, needs: needs(t) }));
  const written = new Set<string>();
  const ordered: TableDiff[] = [];
  while (pending.length > 0) {
    const ready = pending.findIndex((entry) => [...entry.needs].every((key) => written.has(key)));
    const [next] = pending.splice(ready === -1 ? 0 : ready, 1);
    ordered.push(next.table);
    written.add(tableKey(next.table.path, next.table.tableName));
  }
  return ordered;
}

function generateCreateTable(
  table: TableDiff,
  spec: TableDdlWritten,
  dialect: DatabaseType | undefined,
  /** Whether a key's referenced table is a new one this script has not created yet: its ALTER waits (R7). */
  notYetCreated: (fk: ForeignKeyDiff) => boolean,
  deferred: string[],
): string {
  const lines: string[] = [];
  const id = tableId(table, dialect);

  if (spec.createTable.kind === "refused") return spec.createTable.createTableRefusal(id);
  const create = spec.createTable;

  const colDefs = table.columns
    .filter((c) => c.action === "added")
    .map((c) => `  ${spec.columnDef(written(c), escapeIdentifier(c.columnName, dialect))}`);

  // Add primary key constraint
  const pkCols = table.columns.filter((c) => c.targetIsPrimary).map((c) => escapeIdentifier(c.columnName, dialect));
  // An engine with no primary-key constraint answers `after`, a comment that declines the key.
  const key: InsideOrAfter | undefined = pkCols.length > 0 ? create.primaryKey(pkCols) : undefined;
  const keyWritten = key !== undefined && "inside" in key;

  // A key the target can only declare here has to be emitted here, so the closing paren is not
  // written until the constraint list is complete.
  const added = table.foreignKeys.filter((fk) => fk.action === "added");
  const foreignKeys = added.map((fk) => create.foreignKey(foreignKeyDdl(table, fk, dialect), id));

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
  // One into a new table not created yet, the key that closes a cycle, waits until every new table exists.
  foreignKeys.forEach((fk, index) => {
    if ("after" in fk) (notYetCreated(added[index]) ? deferred : lines).push(fk.after);
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
      lines.push(spec.addColumn(spec.columnDef(written(col), escapeIdentifier(col.columnName, dialect)), id));
    });

  // Removed columns
  table.columns
    .filter((c) => c.action === "removed")
    .forEach((col) => lines.push(spec.dropColumn(written(col), escapeIdentifier(col.columnName, dialect), id)));

  // Modified columns
  table.columns
    .filter((c) => c.action === "modified")
    .forEach((col) => lines.push(...spec.modifyColumn(written(col), escapeIdentifier(col.columnName, dialect), id)));

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

  // What the new tables and columns need first: a schema, a sequence (R9). Only an existing table's container is
  // known to exist, so only a new table's is handed over.
  const prerequisites = new Set<string>();
  diff.tables
    .filter((t) => isTableDdlTarget(t) && t.action !== "removed")
    .forEach((t) => {
      const container =
        t.action === "added" && t.path !== undefined && t.path.length > 1
          ? t.path
              .slice(0, -1)
              .map((segment) => escapeIdentifier(segment, dialect))
              .join(".")
          : undefined;
      const columns = t.columns.filter((c) => c.action === "added");
      spec.prerequisites?.(container, columns).forEach((statement) => prerequisites.add(statement));
    });
  if (prerequisites.size > 0) {
    sections.push("-- What the new tables and columns need first");
    sections.push(...prerequisites);
    sections.push("");
  }

  // Create new tables
  const addedTables = inDependencyOrder(diff.tables.filter((t) => t.action === "added" && isTableDdlTarget(t)));
  if (addedTables.length > 0) {
    sections.push("-- Create new tables");
    const uncreated = new Set(addedTables.map((t) => tableKey(t.path, t.tableName)));
    const deferred: string[] = [];
    addedTables.forEach((t) => {
      uncreated.delete(tableKey(t.path, t.tableName));
      sections.push(generateCreateTable(t, spec, dialect, (fk) => uncreated.has(referenceKey(fk)), deferred));
      sections.push("");
    });
    if (deferred.length > 0) {
      sections.push("-- Foreign keys between new tables that reference each other");
      sections.push(...deferred);
      sections.push("");
    }
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

  // What ties a prerequisite back to its column, once the column exists: a sequence's owner.
  const ownership = diff.tables
    .filter((t) => isTableDdlTarget(t) && t.action !== "removed")
    .flatMap(
      (t) =>
        spec.ownership?.(
          tableId(t, dialect),
          t.columns
            .filter((c) => c.action === "added")
            .map((c) => [c, escapeIdentifier(c.columnName, dialect)] as const),
        ) ?? [],
    );
  if (ownership.length > 0) {
    sections.push("-- What the new columns own");
    sections.push(...new Set(ownership));
    sections.push("");
  }

  if (wrapper !== null) {
    sections.push(wrapper.commit);
  }

  return sections.join("\n");
}
