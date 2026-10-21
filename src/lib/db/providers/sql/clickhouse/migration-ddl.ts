/**
 * ClickHouse's transaction support is experimental and setting-gated rather than a safe default, so the migration
 * has no wrapper (#284). The engine has no foreign-key constraint, and its indexes are declined because IndexDiff
 * carries column names/uniqueness, not ClickHouse's index expression, kind and granularity. It also cannot
 * distinguish its synthetic sorting-key rows.
 */
import {
  commentName,
  defaultSql,
  NO_FOREIGN_KEY_CONSTRAINT,
  standardAddColumn,
  standardDropColumn,
  standardDropTable,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { ColumnDiff, MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

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
 * `REMOVE DEFAULT` against a column that has none is an error too (code 36), which is why `modifyColumn`
 * below only emits it for a default that existed.
 */
const CLICKHOUSE_DEFAULT_KINDS = ["MATERIALIZED", "ALIAS", "EPHEMERAL"];
const CLICKHOUSE_REMOVABLE_KINDS = ["DEFAULT", "MATERIALIZED", "ALIAS"];

function clickhouseDefaultKind(value: string): string {
  return CLICKHOUSE_DEFAULT_KINDS.find((kind) => value.startsWith(`${kind} `)) ?? "DEFAULT";
}

function defaultClause(col: ColumnDiff): string {
  const value = defaultSql(col);
  if (value === undefined) return "";
  if (clickhouseDefaultKind(value) !== "DEFAULT") return ` ${value}`;
  return ` DEFAULT ${value}`;
}

const NO_PORTABLE_INDEX_DDL =
  "ClickHouse: Cannot generate index DDL. The diff does not record the index kind, expression or granularity; write the index change by hand.";

const ONLY_REMOVABLE_KINDS = "REMOVE accepts DEFAULT, MATERIALIZED or ALIAS only; recreate the column.";

export const CLICKHOUSE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  createTable: {
    kind: "written",
    primaryKey: standardPrimaryKey,
    foreignKey: () => ({ after: `-- ClickHouse: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}` }),
  },
  columnDef: (col, column) => {
    const type = col.targetType || col.sourceType || "TEXT";
    const nullable = col.targetNullable === false ? " NOT NULL" : "";
    return `${column} ${type}${nullable}${defaultClause(col)}`;
  },
  createIndex: () => `-- ${NO_PORTABLE_INDEX_DDL}`,
  dropIndex: () => `-- ${NO_PORTABLE_INDEX_DDL}`,
  addForeignKey: () => `-- ClickHouse: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
  dropForeignKey: () => `-- ClickHouse: Cannot drop a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: (col, column, table) => {
    // Nullability is part of the type here (`Nullable(T)`) — which is exactly what this
    // provider's introspection reports (`clickhouse/introspect.ts`) — so restating the declared
    // type covers a nullability change too; there is no `SET NOT NULL`. Dropping a default needs
    // the explicit `REMOVE <kind>` form: omitting the clause leaves the old default in place
    // (live-probed). See CLICKHOUSE_DEFAULT_KINDS for the kind vocabulary and its traps.
    const lines: string[] = [];
    const type = col.targetType || col.sourceType || "String";
    lines.push(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${type}${defaultClause(col)};`);
    if (col.sourceDefault && defaultSql(col) === undefined) {
      const kind = clickhouseDefaultKind(col.sourceDefault);
      if (CLICKHOUSE_REMOVABLE_KINDS.includes(kind)) {
        lines.push(`ALTER TABLE ${table} MODIFY COLUMN ${column} REMOVE ${kind};`);
      } else {
        lines.push(
          `-- ClickHouse: Cannot remove the ${kind} property of column "${commentName(col.columnName)}". ${ONLY_REMOVABLE_KINDS}`,
        );
      }
    }
    return lines;
  },
  dropTable: standardDropTable,
  reasons: [NO_PORTABLE_INDEX_DDL, NO_FOREIGN_KEY_CONSTRAINT, ONLY_REMOVABLE_KINDS],
};
