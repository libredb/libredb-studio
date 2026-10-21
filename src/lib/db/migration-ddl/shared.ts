/**
 * The PostgreSQL-shaped statements the migration generator falls through to when an engine says
 * nothing else. Each is a named export, so an engine module shares one by importing it, never by
 * spreading another module's spec.
 */
import type { ColumnDiff, ForeignKeyDdl, IndexDdl, InsideOrAfter, TableDdlWritten } from "./types";

// Object names are untrusted metadata. Quoting protects SQL identifiers, but a
// newline in a -- comment can start an executable statement outside that quote.
export function commentName(name: string): string {
  return name.replace(/[\r\n\u2028\u2029]/g, " ");
}

/**
 * The text that goes after DEFAULT: the engine's own SQL where the provider measured it, and
 * the raw field otherwise.
 *
 * `targetDefault` is the VALUE the column defaults to, and a value is not SQL. Measured on
 * MariaDB 12.3.2: `CREATE TABLE t (note varchar(20) DEFAULT abc)` is ERROR 1054 (42S22)
 * Unknown column 'abc' in 'DEFAULT', while `DEFAULT 'abc'` is accepted. Dialects whose
 * provider declares no expression fall back to the raw field and are unchanged.
 *
 * Every caller gates on `=== undefined` and never on truthiness, because the empty string is
 * a default a column really has. `diffColumns` compares the same quantity by presence, so a
 * truthiness gate here would report a change the migration then silently does not carry.
 */
export function defaultSql(col: ColumnDiff): string | undefined {
  return col.targetDefaultSql ?? col.targetDefault;
}

export const BEGIN_COMMIT = { begin: "BEGIN;", commit: "COMMIT;" } as const;

export const NO_FOREIGN_KEY_CONSTRAINT = "The engine has no foreign-key constraint.";

export const standardColumnDef: TableDdlWritten["columnDef"] = (col, column) => {
  const type = col.targetType || col.sourceType || "TEXT";
  const nullable = col.targetNullable === false ? " NOT NULL" : "";
  const value = defaultSql(col);
  const defaultVal = value === undefined ? "" : ` DEFAULT ${value}`;
  return `${column} ${type}${nullable}${defaultVal}`;
};

export const standardPrimaryKey = (columns: readonly string[]): InsideOrAfter => ({
  inside: `,  PRIMARY KEY (${columns.join(", ")})`,
});

export const standardAddForeignKey: TableDdlWritten["addForeignKey"] = (fk: ForeignKeyDdl, table) =>
  `ALTER TABLE ${table} ADD CONSTRAINT ${fk.constraint} FOREIGN KEY (${fk.column}) REFERENCES ${fk.references};`;

export const standardCreateTableForeignKey = (fk: ForeignKeyDdl, table: string): InsideOrAfter => ({
  after: standardAddForeignKey(fk, table),
});

export const standardDropForeignKey: TableDdlWritten["dropForeignKey"] = (constraint, table) =>
  `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint};`;

export const standardCreateIndex: TableDdlWritten["createIndex"] = (index: IndexDdl, table) =>
  `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${index.name} ON ${table} (${index.columns.join(", ")});`;

export const standardDropIndex: TableDdlWritten["dropIndex"] = (index) =>
  `DROP INDEX IF EXISTS ${index.qualifiedName};`;

export const standardAddColumn: TableDdlWritten["addColumn"] = (definition, table) =>
  `ALTER TABLE ${table} ADD COLUMN ${definition};`;

export const standardDropColumn: TableDdlWritten["dropColumn"] = (_col, column, table) =>
  `ALTER TABLE ${table} DROP COLUMN ${column};`;

/** One statement per facet that changed: the type, the nullability, the default. */
export const standardModifyColumn: TableDdlWritten["modifyColumn"] = (col, column, table) => {
  const lines: string[] = [];
  if (col.sourceType !== col.targetType) {
    lines.push(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${col.targetType};`);
  }
  if (col.sourceNullable !== col.targetNullable) {
    lines.push(`ALTER TABLE ${table} ALTER COLUMN ${column} ${col.targetNullable ? "DROP" : "SET"} NOT NULL;`);
  }
  if (col.sourceDefault !== col.targetDefault) {
    const declaredDefault = defaultSql(col);
    lines.push(
      declaredDefault !== undefined
        ? `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${declaredDefault};`
        : `ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT;`,
    );
  }
  return lines;
};

export const standardDropTable: TableDdlWritten["dropTable"] = (table) => `DROP TABLE IF EXISTS ${table};`;
