/**
 * Migration SQL from a schema diff.
 *
 * **Only part of this generator is dialect-aware, and the rest emits one shape for
 * everyone (#284).** Stated here because the difference is invisible from a call
 * site: `generateMigrationSQL(diff, dialect)` takes a dialect either way.
 *
 * - Dialect-aware: the modified-column path, which branches per engine and names
 *   the limitation in a comment where an engine has no such statement (#269); the
 *   `ADD` / `DROP` keyword, which CQL spells without `COLUMN`; `CREATE TABLE`,
 *   which is refused outright for Cassandra (see CASSANDRA_NO_CREATE_TABLE); the
 *   transaction wrapper, which Cassandra and SQLite's two type ids each do
 *   without; and the foreign-key statements, which CQL has no grammar for at all
 *   and which SQLite's grammar takes only inside `CREATE TABLE` (see
 *   FOREIGN_KEY_ONLY_IN_CREATE_TABLE).
 * - Not yet: the transaction wrapper for everyone ELSE (`BEGIN;` / `COMMIT;` is
 *   only valid for PostgreSQL and MySQL — MSSQL spells it `BEGIN TRANSACTION`,
 *   Oracle opens a PL/SQL block and auto-commits DDL anyway, and five remaining
 *   type ids have no transactional DDL at all), the rest of `ADD COLUMN` and
 *   `DROP COLUMN`, and the index/FK fallbacks that emit `DROP INDEX IF EXISTS`.
 *
 * Cassandra is ahead of the others here for a reason worth stating: it is the one
 * dialect whose OTHER statements were each measured against a live server, so the
 * wrapper and the FK lines would have been the only unrunnable lines in an
 * otherwise runnable migration. Elsewhere they are one problem among several, and
 * the emitted forms still want checking against a live server first.
 *
 * So the output is correct for PostgreSQL, largely correct for MySQL and SQLite,
 * and can be unrunnable elsewhere. Tracked rather than fixed here because the
 * emitted forms want checking against a live MSSQL and Oracle before they are
 * settled, the way #264 and #265 did.
 */
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
  // Measured over Hrana on sqld 0.24.33, and the entry exists because the PostgreSQL
  // branch this id would otherwise inherit emits text libSQL cannot parse:
  // `ALTER TABLE t ALTER COLUMN c TYPE integer` is "unexpected end of input" and the
  // MySQL spelling `MODIFY COLUMN` is "syntax error around `MODIFY`". No SQLite has a
  // column TYPE change, and libSQL is SQLite - unlike DROP COLUMN and RENAME COLUMN,
  // which it DOES accept (both measured), so this row is narrower than the `sqlite`
  // branch below and deliberately so. Nullability is the one exception and it does not
  // reach libSQL: SQLite gained `ALTER COLUMN ... SET/DROP NOT NULL` in 3.53.0 (measured
  // 2026-08-27 on 3.53.0 - it rewrites the stored schema and is enforced on insert),
  // while sqld 0.24.33 ships 3.47.0, so declining every modification is still right here.
  // The `sqlite` branch below declines it too, and deliberately: that provider runs on
  // whichever SQLite its runtime bundles - `bun:sqlite` or `node:sqlite`, chosen at runtime
  // with `LIBREDB_SQLITE_DRIVER` as an override - so emitting the statement would write a
  // migration file that succeeds on one deployment and fails on another. A file handed to a
  // human to run elsewhere makes that guess worse than the decline.
  libsql: {
    label: "libSQL",
    reason: "SQLite cannot retype a column; recreate the table and copy the rows.",
  },
  couchbase: {
    label: "Couchbase",
    reason: "Collections hold schemaless JSON documents, so there is no column definition to change.",
  },
  druid: {
    label: "Apache Druid",
    reason: "Druid SQL has no ALTER TABLE; rewrite the datasource with REPLACE INTO through an MSQ task.",
  },
  // Measured 2026-08-20 on Trino 476, and the entry exists because the PostgreSQL
  // branch this id would otherwise inherit emits text Trino cannot even PARSE:
  // `ALTER TABLE ... ALTER COLUMN id TYPE varchar` is "line 1:50: mismatched input
  // 'TYPE'. Expecting: '.', 'DROP', 'SET'". Trino's own spelling
  // (`ALTER COLUMN id SET DATA TYPE varchar`) parses and then hands the question to
  // the catalog, which answered "This connector does not support setting column
  // types" - so there is no single statement a portable migration could carry, and
  // which one would work is a property of the catalog rather than of Trino.
  trino: {
    label: "Trino",
    reason:
      "Whether a column can be retyped is the connector's answer, not Trino's; run the change in the system the catalog points at.",
  },
  // Measured 2026-08-19: `ALTER TABLE probe_orders ADD COLUMN x INT` and
  // `... MODIFY COLUMN customer TEXT` are refused by both grammars - Elasticsearch
  // 9.1.4 with `parsing_exception`, "mismatched input 'ALTER' expecting {'(',
  // 'DEBUG', 'DESC', 'DESCRIBE', 'EXPLAIN', 'SELECT', 'SHOW', 'SYS', 'WITH'}" (the
  // grammar lists everything it accepts, and no DDL is among them), OpenSearch 3.8.0
  // with `SQLFeatureNotSupportedException`, "Query must start with SELECT, DELETE,
  // SHOW or DESCRIBE". A mapping is also not editable in place even outside SQL: an
  // existing field's type cannot be changed at all, which is why the reason says
  // reindex rather than "use the mapping API".
  elasticsearch: {
    label: "Elasticsearch",
    reason: "Elasticsearch SQL reads only; change a field by reindexing into an index whose mapping declares it.",
  },
  opensearch: {
    label: "OpenSearch",
    reason: "OpenSearch SQL reads only; change a field by reindexing into an index whose mapping declares it.",
  },
  // Measured on Cassandra 5.0.9: `ALTER TABLE probe.customers ALTER name TYPE blob`
  // answers 8704, "Altering column types is no longer supported" - the operation was
  // REMOVED from the engine (it corrupted data), not merely unimplemented. The
  // PostgreSQL branch this id would otherwise inherit emits `ALTER COLUMN … TYPE …`,
  // which is not even in CQL's ALTER grammar, so there is no statement to emit at all.
  cassandra: {
    label: "Apache Cassandra",
    reason:
      "Cassandra no longer supports altering a column's type; add a new column and migrate the values, or recreate the table.",
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
  // A CQL column definition is a name and a type, full stop. Measured on 5.0.9:
  // `name TEXT NOT NULL`, `name TEXT UNIQUE` and `name TEXT DEFAULT 'x'` are each
  // "no viable alternative at input" - none of the three qualifiers exists in the
  // grammar. Nullability is not a column property there (only a primary-key
  // component cannot be null) and there are no defaults at all.
  if (dialect === "cassandra") return `${escapeIdentifier(col.columnName, dialect)} ${type}`;
  const nullable = col.targetNullable === false ? " NOT NULL" : "";
  const defaultVal = col.targetDefault ? ` DEFAULT ${col.targetDefault}` : "";
  return `${escapeIdentifier(col.columnName, dialect)} ${type}${nullable}${defaultVal}`;
}

/**
 * Why a Cassandra CREATE is refused here rather than emitted.
 *
 * A CQL primary key is two things at once: the partition key, which decides which node holds a row,
 * and the clustering columns, which order rows inside that partition. The brackets carry that
 * distinction and nothing else does. Measured on 5.0.9 with two probe tables that differ only in one
 * pair of them — `probe.composite_pk` is `PRIMARY KEY ((tenant, day), ts)`, `probe.pk_flat` is
 * `PRIMARY KEY (tenant, day, ts)`: `SELECT * FROM probe.pk_flat WHERE tenant = 'a'` is served, while
 * the same restriction on `probe.composite_pk` answers code 2200, "Cannot execute this query as it
 * might involve data filtering and thus may have unpredictable performance". So the two spellings are
 * different tables, not two ways of writing one.
 *
 * `system_schema.columns` distinguishes them by `kind` (`partition_key` vs `clustering`), but
 * `ColumnDiff` keeps only `targetIsPrimary` — both tables above reduce to the same three key columns —
 * so the bracketing is not recoverable from a diff and the shared `PRIMARY KEY (a, b, c)` serializer
 * below would silently pick the flat layout. Guessing the physical layout of a table is not a
 * cosmetic error, so this path declines the way the rest of the module declines: a comment naming the
 * limitation, which a human can read, instead of DDL that would run and be wrong.
 *
 * The provider already publishes `supportsCreateTable: false` (`sql/cassandra/index.ts`) for the
 * neighbouring reason — what `CreateTableModal` emits is not valid CQL — but `SchemaDiff.tsx` calls
 * this generator with the connection's type and never consults capabilities, so the refusal has to be
 * repeated here or the two contradict each other.
 */
const CASSANDRA_NO_CREATE_TABLE =
  "A CQL primary key splits into a partition key and clustering columns, and a schema diff records neither role, so the partitioning cannot be derived; write the CREATE TABLE by hand.";

/**
 * Canonical type ids whose grammar declares a foreign key ONLY as a `CREATE TABLE` table constraint,
 * with the label each one's comments carry. `sqlite` is the engine and `libsql` is a fork of it, so
 * the two answer identically; the labels are spelled out per id anyway, because a reader wants the
 * name of the engine they connected to (the same reason the neighbouring libSQL branches exist).
 *
 * SQLite's ALTER TABLE page enumerates every schema change the engine has - "rename table", "rename
 * column", "add column", "drop column", plus SET/DROP NOT NULL since 3.53.0 - and adding a constraint
 * is not among them; it routes such a change through its own 12-step table-recreation procedure.
 * Measured on sqlite3 3.53.3: `ALTER TABLE "users" ADD CONSTRAINT "fk_users_dept_id" FOREIGN KEY
 * ("dept_id") REFERENCES "departments"("id")` is `near "FOREIGN": syntax error` - the parser has
 * already taken `CONSTRAINT` for a column name and the quoted name for its type - and the same
 * statement over Hrana on sqld 0.24.33 is `near CONSTRAINT ... syntax error`. Two tokens, one verdict.
 *
 * Both emission paths read this map and answer it DIFFERENTLY, which is the point of naming the fact
 * once (#515). `generateCreateTable` is building the table right there, so it moves the key
 * INSIDE the statement, where SQLite's grammar does take it; `generateAlterTable` has no such place
 * to put it and declines with a comment. Declining on both paths would throw away a key the engine
 * can perfectly well hold.
 */
const FOREIGN_KEY_ONLY_IN_CREATE_TABLE: Partial<Record<DatabaseType, { label: string; reason: string }>> = {
  sqlite: {
    label: "SQLite",
    reason: "A foreign key is declarable only as a CREATE TABLE constraint; recreate the table and copy the rows.",
  },
  libsql: {
    label: "libSQL",
    reason: "SQLite declares one only in CREATE TABLE; recreate the table and copy the rows.",
  },
  // Measured on DuckDB v1.5.5, both arms. The table constraint this map selects is
  // accepted and readable back - `CREATE TABLE "users" (..., PRIMARY KEY ("id"),
  // FOREIGN KEY ("dept_id") REFERENCES "departments"("id"))` lands, and
  // `duckdb_constraints()` then reports it. The trailing ALTER the other ids get is
  // NOT: `ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id)` answers
  // "Not implemented Error: No support for that ALTER TABLE option yet!", which is
  // exactly what `generateAlterTable` already declines to emit for this id. Without
  // this entry the two halves disagreed: the created-table path emitted the very
  // statement the modified-table path documents as refused.
  duckdb: {
    label: "DuckDB",
    reason: "ALTER TABLE cannot add one yet; recreate the table and copy the rows.",
  },
};

function generateCreateTable(table: TableDiff, dialect: DatabaseType): string {
  const lines: string[] = [];
  const id = escapeIdentifier(table.tableName, dialect);

  // Declined whole, indexes and foreign keys included: there would be no table for them to attach to.
  if (dialect === "cassandra") {
    return `-- Apache Cassandra: Cannot generate CREATE TABLE for ${id}. ${CASSANDRA_NO_CREATE_TABLE}`;
  }

  const colDefs = table.columns.filter((c) => c.action === "added").map((c) => `  ${generateColumnDef(c, dialect)}`);

  // Add primary key constraint
  const pkCols = table.columns.filter((c) => c.targetIsPrimary).map((c) => escapeIdentifier(c.columnName, dialect));

  // A key the target can only declare here has to be emitted here, so the closing paren is not
  // written until the constraint list is complete.
  const addedForeignKeys = table.foreignKeys.filter((fk) => fk.action === "added");
  const keyIsTableConstraint = FOREIGN_KEY_ONLY_IN_CREATE_TABLE[dialect] !== undefined;

  lines.push(`CREATE TABLE ${id} (`);
  lines.push(colDefs.join(",\n"));
  if (pkCols.length > 0) {
    lines.push(`,  PRIMARY KEY (${pkCols.join(", ")})`);
  }
  if (keyIsTableConstraint) {
    // SQLite's CREATE TABLE takes "one or more column definitions, optionally followed by a list of
    // table constraints", one of which is `FOREIGN KEY ( column-name, ... ) REFERENCES ...`. Hence
    // the position: after the columns AND after the PRIMARY KEY line, never before them - the same
    // constraint placed ahead of a column definition is `near "FOREIGN": syntax error` (measured on
    // sqlite3 3.53.3, where the form below is accepted and `PRAGMA foreign_key_list` then reports the
    // key).
    //
    // The `fk_<table>_<column>` name the other dialects carry is dropped rather than translated into
    // a `CONSTRAINT name` prefix, which SQLite would also accept: the name is this generator's own
    // invention rather than anything the diff recorded, and SQLite never reads a foreign key's name
    // back out - `PRAGMA foreign_key_list` has no name column - so it could only ever be write-only.
    addedForeignKeys.forEach((fk) => {
      lines.push(
        `,  FOREIGN KEY (${escapeIdentifier(fk.columnName, dialect)}) REFERENCES ${escapeIdentifier(fk.targetReferencedTable || "", dialect)}(${escapeIdentifier(fk.targetReferencedColumn || "", dialect)})`,
      );
    });
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

  // Foreign keys. Already emitted above for the ids that can only declare one inside the statement;
  // for everyone else this separate ALTER is the shape that has always been emitted here.
  if (!keyIsTableConstraint) {
    addedForeignKeys.forEach((fk) => {
      lines.push(
        `ALTER TABLE ${id} ADD CONSTRAINT ${escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect)} FOREIGN KEY (${escapeIdentifier(fk.columnName, dialect)}) REFERENCES ${escapeIdentifier(fk.targetReferencedTable || "", dialect)}(${escapeIdentifier(fk.targetReferencedColumn || "", dialect)});`,
      );
    });
  }

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
      // CQL spells it without the COLUMN keyword, measured on 5.0.9: `ADD COLUMN extra
      // TEXT` is "line 1:42 mismatched input 'TEXT' expecting EOF" while `ADD extra
      // text` succeeds.
      const keyword = dialect === "cassandra" ? "ADD" : "ADD COLUMN";
      lines.push(`ALTER TABLE ${id} ${keyword} ${generateColumnDef(col, dialect)};`);
    });

  // Removed columns
  table.columns
    .filter((c) => c.action === "removed")
    .forEach((col) => {
      if (dialect === "sqlite") {
        lines.push(`-- SQLite: Cannot drop column "${col.columnName}" directly. Requires table recreation.`);
      } else {
        // Same measurement in the other direction: `DROP COLUMN extra` is "mismatched
        // input 'extra' expecting EOF" on CQL, while `DROP extra` succeeds.
        const keyword = dialect === "cassandra" ? "DROP" : "DROP COLUMN";
        lines.push(`ALTER TABLE ${id} ${keyword} ${escapeIdentifier(col.columnName, dialect)};`);
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
      // Cassandra has no foreign key to add: `ADD CONSTRAINT ... FOREIGN KEY` is
      // "mismatched input 'FOREIGN' expecting EOF" (measured on 5.0.9), which is also
      // why the provider reports `declaresForeignKeys: false`. This branch exists
      // because that report does not reach here: `SchemaDiff.tsx` reads the dialect
      // from the current connection and the diff from a snapshot that may be another
      // connection's, so a relational schema's keys arrive with a CQL dialect.
      if (dialect === "cassandra") {
        lines.push(
          `-- Apache Cassandra: Cannot add a foreign key on ${escapeIdentifier(fk.columnName, dialect)}. The clause is not in CQL's grammar; enforce the relationship in the application.`,
        );
        return;
      }
      // No ALTER adds a foreign key on these ids, so the honest line names the table recreation
      // instead (see FOREIGN_KEY_ONLY_IN_CREATE_TABLE for the three measurements). For `sqlite` and
      // `libsql` it is SQLite's grammar; for `duckdb` it is a refusal at execution -
      // `ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id)` parses and then answers
      // "Not implemented Error: No support for that ALTER TABLE option yet!" (v1.5.5), as does the
      // UNIQUE form, while `ADD CONSTRAINT ... PRIMARY KEY` is the one arm that lands. Unlike the
      // created-table path, there is nothing to move the key into: the table already exists, and
      // this generator does not write the recreation.
      const declined = FOREIGN_KEY_ONLY_IN_CREATE_TABLE[dialect];
      if (declined) {
        lines.push(
          `-- ${declined.label}: Cannot add a foreign key on ${escapeIdentifier(fk.columnName, dialect)}. ${declined.reason}`,
        );
        return;
      }
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
      } else if (dialect === "libsql") {
        // The generic `DROP CONSTRAINT` branch below is not parseable here, measured on
        // sqld 0.24.33: `ALTER TABLE t DROP CONSTRAINT fk_x` is "near CONSTRAINT …
        // syntax error". Same limit as SQLite, named separately so the comment names
        // the engine the reader connected to.
        lines.push(`-- libSQL: Cannot drop a foreign key directly. Requires table recreation.`);
      } else if (dialect === "duckdb") {
        // The generic branch below is refused here too, measured on v1.5.5: `ALTER
        // TABLE t DROP CONSTRAINT IF EXISTS fk_x` is "Not implemented Error: No
        // support for that ALTER TABLE option yet!" - and a `Not implemented` is not
        // an `IF EXISTS` no-op, so the line would fail a migration rather than skip.
        lines.push(`-- DuckDB: Cannot drop a foreign key directly. Requires table recreation.`);
      } else if (dialect === "cassandra") {
        // `DROP CONSTRAINT IF EXISTS fk_x` is "mismatched input 'IF' expecting EOF"
        // (measured), and dropping what was never declarable is not a statement.
        lines.push(`-- Apache Cassandra: Cannot drop a foreign key. CQL never declared one.`);
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

  // ONE definition, read twice: the opening and the closing halves of this wrapper used
  // to be two independent conditions, which is a shape that can diverge into a `BEGIN;`
  // with no `COMMIT;`.
  //
  // SQLite runs its own transaction, and libSQL is SQLite - the same reasoning, with
  // one addition of its own: this provider closes its Hrana stream in the same request
  // as each statement, so a BEGIN it emitted could not be continued by the app that
  // generated the file. Cassandra has no transaction at all. Measured on
  // 5.0.9: `BEGIN;` is "line 1:5 mismatched input ';' expecting K_BATCH" and `COMMIT;`
  // is "no viable alternative at input 'COMMIT'". The only grouping CQL has is
  // `BEGIN BATCH ... APPLY BATCH`, which is not a transaction and takes no DDL, so
  // there is nothing to translate the wrapper INTO - it can only be left out. The
  // wrapper is still wrong for the other engines named in the module docstring; that
  // stays tracked there, and unlike them Cassandra emits DDL this generator was taught
  // to spell correctly, so the wrapper would be the only unrunnable line in it.
  const wrapsInTransaction = dialect !== "sqlite" && dialect !== "libsql" && dialect !== "cassandra";

  if (wrapsInTransaction) {
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

  if (wrapsInTransaction) {
    sections.push("COMMIT;");
  }

  return sections.join("\n");
}
