/**
 * The Db2 LUW object surface (#786, #789): what the engine holds, as containers, kinds and
 * objects, read from the SYSCAT catalog views.
 *
 * Everything here is either a statement or a pure function over the rows a statement
 * answered, so the provider in `index.ts` only runs statements and every rule about Db2's
 * catalog lives in one file. The facts each rule rests on were measured against
 * icr.io/db2_community/db2:12.1.0.0 with `docker/db2-init/01-object-fixture.sql` and are
 * recorded in `docs/providers/db2.md`.
 *
 * NOTHING A CALLER SUPPLIES IS INTERPOLATED. A schema, an object name, a catalog type code
 * and a row bound all reach Db2 as `?` markers, so no identifier escaper is involved in any
 * read below.
 */
import { QueryError } from "../../../errors";
import { applySourceBound, containerDepth, declaredKinds } from "../../../object-kinds";
import type {
  ColumnSchema,
  Container,
  ContainerLevelSpec,
  ContainerLevels,
  DatabaseObject,
  ForeignKeySchema,
  IndexSchema,
  KindCount,
  ObjectDetail,
  ObjectKindSpec,
  ObjectSourcePart,
  ProviderCapabilities,
} from "../../../types";

const SOURCE = { hasSource: true, sourceLanguage: "sql" } as const;

export const DB2_CONTAINER_LEVELS: ContainerLevels = [{ id: "schema", label: "Schema", labelPlural: "Schemas" }];

/**
 * Nine kinds, each answered by one SYSCAT view.
 *
 * Source is declared where SYSCAT keeps the statement the author ran: VIEWS.TEXT for a view
 * and for a materialized query table, ROUTINES.TEXT and TRIGGERS.TEXT. A table, an alias, a
 * sequence and a module have no stored text, and Db2 offers no read-only way to generate one
 * (`db2look` is a client tool and `SYSPROC.DB2LK_GENERATE_DDL` writes to SYSTOOLS tables).
 *
 * No `index` kind: SYSCAT.INDEXES is keyed by the table an index is on, so an index belongs in
 * `describeObject`'s answer. No `nickname` kind: nicknames exist only with federation enabled,
 * and the fixture cannot produce one.
 */
export const DB2_OBJECT_KINDS: readonly ObjectKindSpec[] = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
  { id: "view", role: "relation", label: "View", labelPlural: "Views", ...SOURCE },
  {
    id: "materialized_query_table",
    role: "relation",
    label: "Materialized Query Table",
    labelPlural: "Materialized Query Tables",
    ...SOURCE,
  },
  { id: "alias", role: "config", label: "Alias", labelPlural: "Aliases" },
  { id: "sequence", role: "config", label: "Sequence", labelPlural: "Sequences" },
  // A module is ONE node holding routines, the same leaf-group shape as an Oracle package: its
  // routines carry ROUTINEMODULENAME and are left out of the schema-level routine folders.
  { id: "module", role: "group", label: "Module", labelPlural: "Modules", childKinds: ["procedure", "function"] },
  { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures", ...SOURCE },
  { id: "function", role: "routine", label: "Function", labelPlural: "Functions", ...SOURCE },
  { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table", ...SOURCE },
];

/** SYSCAT.TABLES.TYPE per relation-shaped kind. */
const TABLE_TYPE: Readonly<Record<string, string>> = {
  table: "T",
  view: "V",
  materialized_query_table: "S",
  alias: "A",
};

/** SYSCAT.ROUTINES.ROUTINETYPE per routine kind. */
const ROUTINE_TYPE: Readonly<Record<string, string>> = { procedure: "P", function: "F" };

/** What `COUNTS_SQL` labels each row with, and the kind that row counts. */
const KIND_BY_COUNT_LABEL: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(TABLE_TYPE).map(([kind, type]) => [`TABLES:${type}`, kind])),
  ...Object.fromEntries(Object.entries(ROUTINE_TYPE).map(([kind, type]) => [`ROUTINES:${type}`, kind])),
  SEQUENCES: "sequence",
  MODULES: "module",
  TRIGGERS: "trigger",
};

// ----------------------------------------------------------------------------
// Statements
// ----------------------------------------------------------------------------

/**
 * The schemas, minus the ones Db2 owns.
 *
 * By NAME and not by owner, because the owner cannot tell them apart: measured, the schema Db2
 * creates implicitly on a user's first unqualified CREATE is OWNER SYSIBM, OWNERTYPE 'S', the
 * same as SYSCAT's. An upper-case `SYS` prefix is reserved (CREATE SCHEMA SYSX answers
 * SQL0553N), and NULLID and SQLJ are created with every database. A delimited lower-case
 * `"sysx"` is a legal user schema, and `LIKE` is case-sensitive, so it stays listed.
 *
 * RTRIM because SCHEMANAME comes back blank-padded to eight characters.
 */
export const CONTAINERS_SQL = `SELECT RTRIM(SCHEMANAME) AS NAME,
         CASE WHEN SCHEMANAME = CURRENT SCHEMA THEN 1 ELSE 0 END AS IS_SESSION_DEFAULT
         FROM SYSCAT.SCHEMATA
         WHERE SCHEMANAME NOT LIKE 'SYS%' AND SCHEMANAME NOT IN ('NULLID', 'SQLJ')`;

/**
 * How many of each kind one schema holds, in ONE statement that binds the schema five times.
 *
 * A routine counts only when it is not in a module and its ORIGIN is one a person wrote:
 * E external, F federated, Q SQL-bodied, U sourced. B (built-in), M (template), R and S
 * (system-generated) are Db2's own. A sequence counts only with SEQTYPE 'S': 'I' is the
 * sequence behind an identity column and 'A' an alias of a sequence.
 */
export const COUNTS_SQL = `SELECT 'TABLES:' CONCAT TYPE AS KIND, COUNT(*) AS N
         FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE IN ('T', 'V', 'S', 'A') GROUP BY TYPE
         UNION ALL
         SELECT 'SEQUENCES', COUNT(*) FROM SYSCAT.SEQUENCES WHERE SEQSCHEMA = ? AND SEQTYPE = 'S'
         UNION ALL
         SELECT 'MODULES', COUNT(*) FROM SYSCAT.MODULES WHERE MODULESCHEMA = ? AND MODULETYPE IN ('M', 'P')
         UNION ALL
         SELECT 'ROUTINES:' CONCAT ROUTINETYPE, COUNT(*)
         FROM SYSCAT.ROUTINES
         WHERE ROUTINESCHEMA = ? AND ROUTINETYPE IN ('P', 'F') AND ROUTINEMODULENAME IS NULL
           AND ORIGIN IN ('E', 'F', 'Q', 'U')
         GROUP BY ROUTINETYPE
         UNION ALL
         SELECT 'TRIGGERS', COUNT(*) FROM SYSCAT.TRIGGERS WHERE TRIGSCHEMA = ?`;

/** Tables, views, materialized query tables and aliases. VIEWS.VALID answers for the two view shapes only. */
const LIST_TABLES_SQL = `SELECT t.TABNAME AS NAME, t.STATUS, t.CARD, v.VALID
         FROM SYSCAT.TABLES t
         LEFT JOIN SYSCAT.VIEWS v ON v.VIEWSCHEMA = t.TABSCHEMA AND v.VIEWNAME = t.TABNAME
         WHERE t.TABSCHEMA = ? AND t.TYPE = ?`;

const LIST_SEQUENCES_SQL = `SELECT SEQNAME AS NAME FROM SYSCAT.SEQUENCES WHERE SEQSCHEMA = ? AND SEQTYPE = 'S'`;

const LIST_MODULES_SQL = `SELECT MODULENAME AS NAME FROM SYSCAT.MODULES WHERE MODULESCHEMA = ? AND MODULETYPE IN ('M', 'P')`;

/**
 * Routines of one type. SPECIFICNAME is the address: Db2 overloads a routine name by its
 * parameter types, and measured, the two ORDER_TOTAL functions in the fixture carry one
 * ROUTINENAME and two SPECIFICNAMEs. It is also the name `DROP SPECIFIC FUNCTION` takes.
 */
const LIST_ROUTINES_SQL = `SELECT SPECIFICNAME AS SEGMENT, ROUTINENAME AS NAME, VALID
         FROM SYSCAT.ROUTINES
         WHERE ROUTINESCHEMA = ? AND ROUTINETYPE = ? AND ROUTINEMODULENAME IS NULL
           AND ORIGIN IN ('E', 'F', 'Q', 'U')`;

/**
 * Triggers, with the table they nest under when there is one in THIS schema.
 *
 * A trigger's schema may differ from its table's (measured: REPORTING.ORDERS_AUDIT fires on
 * APP.ORDERS). Nesting it under `[REPORTING, ORDERS]` would address a table that does not
 * exist, so such a trigger hangs off its own schema instead, which is the shape an attached
 * kind with no base object in the container already takes.
 */
const LIST_TRIGGERS_SQL = `SELECT TRIGNAME AS NAME,
         CASE WHEN TABSCHEMA = TRIGSCHEMA THEN TABNAME END AS PARENT,
         VALID
         FROM SYSCAT.TRIGGERS
         WHERE TRIGSCHEMA = ?`;

/**
 * Columns. KEYSEQ is the column's position in the PRIMARY KEY and NULL outside it, so no
 * separate key read is needed. `CODEPAGE` 0 on a character type is `FOR BIT DATA`.
 */
const COLUMNS_SELECT = `COLNAME AS COLUMN_NAME, TYPENAME, LENGTH, SCALE, CODEPAGE, NULLS, "DEFAULT" AS DEFAULT_VALUE, KEYSEQ`;

/**
 * Foreign keys, one row per column pair.
 *
 * The referenced key is joined on its TABLE as well as its schema and name: a constraint name
 * is unique per table, not per schema (measured, two tables in APP both carried a key named
 * PK), so a join without TABNAME pairs one foreign key with every same-named key in the schema.
 */
const FOREIGN_KEYS_FROM = `FROM SYSCAT.REFERENCES r
         JOIN SYSCAT.KEYCOLUSE fk
           ON fk.CONSTNAME = r.CONSTNAME AND fk.TABSCHEMA = r.TABSCHEMA AND fk.TABNAME = r.TABNAME
         JOIN SYSCAT.KEYCOLUSE pk
           ON pk.CONSTNAME = r.REFKEYNAME AND pk.TABSCHEMA = r.REFTABSCHEMA AND pk.TABNAME = r.REFTABNAME
              AND pk.COLSEQ = fk.COLSEQ`;
const FOREIGN_KEYS_SELECT = `fk.COLNAME AS COLUMN_NAME, RTRIM(r.REFTABSCHEMA) AS REF_SCHEMA, r.REFTABNAME AS REF_TABLE, pk.COLNAME AS REF_COLUMN`;

/**
 * Indexes, one row per column. Filtered by the TABLE's schema: a system-generated key index
 * lives in INDSCHEMA SYSIBM while its table is in the user's schema (measured on the fixture's
 * "Mixed Case" table), so filtering by INDSCHEMA would drop it.
 */
const INDEXES_FROM = `FROM SYSCAT.INDEXES i
         JOIN SYSCAT.INDEXCOLUSE ic ON ic.INDSCHEMA = i.INDSCHEMA AND ic.INDNAME = i.INDNAME`;
const INDEXES_SELECT = `RTRIM(i.INDSCHEMA) AS INDEX_SCHEMA, i.INDNAME AS INDEX_NAME, i.UNIQUERULE, ic.COLNAME AS COLUMN_NAME`;

export const OBJECT_COLUMNS_SQL = `SELECT ${COLUMNS_SELECT}
         FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY COLNO`;

export const OBJECT_FOREIGN_KEYS_SQL = `SELECT ${FOREIGN_KEYS_SELECT}
         ${FOREIGN_KEYS_FROM}
         WHERE r.TABSCHEMA = ? AND r.TABNAME = ?
         ORDER BY r.CONSTNAME, fk.COLSEQ`;

export const OBJECT_INDEXES_SQL = `SELECT ${INDEXES_SELECT}
         ${INDEXES_FROM}
         WHERE i.TABSCHEMA = ? AND i.TABNAME = ?
         ORDER BY i.INDSCHEMA, i.INDNAME, ic.COLSEQ`;

/**
 * The objects a bulk read describes, bound `[schema, type]` or `[schema, type, limit + 1]`.
 *
 * The bound reads ONE row more than the caller asked for, so the read itself says whether it
 * stopped short. `FETCH FIRST ? ROWS ONLY` binds, measured, including inside the CTE below.
 */
export function bulkTargetSql(bounded: boolean): string {
  return `SELECT TABNAME AS OBJECT_NAME FROM SYSCAT.TABLES
         WHERE TABSCHEMA = ? AND TYPE = ?
         ORDER BY TABNAME${bounded ? " FETCH FIRST ? ROWS ONLY" : ""}`;
}

/**
 * The three detail reads for a whole kind, each restricted to the target above and bound
 * `[...targetBinds, schema]`. They select what the single reads select plus OBJECT_NAME, so one
 * mapper serves both and the bulk answer for a table cannot differ from its single answer.
 */
export function bulkDetailSql(bounded: boolean): { columns: string; foreignKeys: string; indexes: string } {
  const target = `WITH TARGET AS (${bulkTargetSql(bounded)})`;
  return {
    columns: `${target}
         SELECT TABNAME AS OBJECT_NAME, ${COLUMNS_SELECT}
         FROM SYSCAT.COLUMNS
         WHERE TABSCHEMA = ? AND TABNAME IN (SELECT OBJECT_NAME FROM TARGET)
         ORDER BY TABNAME, COLNO`,
    foreignKeys: `${target}
         SELECT r.TABNAME AS OBJECT_NAME, ${FOREIGN_KEYS_SELECT}
         ${FOREIGN_KEYS_FROM}
         WHERE r.TABSCHEMA = ? AND r.TABNAME IN (SELECT OBJECT_NAME FROM TARGET)
         ORDER BY r.TABNAME, r.CONSTNAME, fk.COLSEQ`,
    indexes: `${target}
         SELECT i.TABNAME AS OBJECT_NAME, ${INDEXES_SELECT}
         ${INDEXES_FROM}
         WHERE i.TABSCHEMA = ? AND i.TABNAME IN (SELECT OBJECT_NAME FROM TARGET)
         ORDER BY i.TABNAME, i.INDSCHEMA, i.INDNAME, ic.COLSEQ`,
  };
}

/** A view's or a materialized query table's text, only when the object IS that kind. */
const SOURCE_VIEW_SQL = `SELECT v.TEXT
         FROM SYSCAT.VIEWS v
         JOIN SYSCAT.TABLES t ON t.TABSCHEMA = v.VIEWSCHEMA AND t.TABNAME = v.VIEWNAME
         WHERE v.VIEWSCHEMA = ? AND v.VIEWNAME = ? AND t.TYPE = ?`;

const SOURCE_ROUTINE_SQL = `SELECT TEXT, ORIGIN
         FROM SYSCAT.ROUTINES
         WHERE ROUTINESCHEMA = ? AND SPECIFICNAME = ? AND ROUTINETYPE = ? AND ROUTINEMODULENAME IS NULL`;

/** A trigger addressed under its table, which the listing produces only when both share a schema. */
const SOURCE_NESTED_TRIGGER_SQL = `SELECT TEXT
         FROM SYSCAT.TRIGGERS
         WHERE TRIGSCHEMA = ? AND TABSCHEMA = TRIGSCHEMA AND TABNAME = ? AND TRIGNAME = ?`;

/** A trigger addressed under its schema, which the listing produces only for another schema's table. */
const SOURCE_SCHEMA_TRIGGER_SQL = `SELECT TEXT
         FROM SYSCAT.TRIGGERS
         WHERE TRIGSCHEMA = ? AND TRIGNAME = ? AND TABSCHEMA <> TRIGSCHEMA`;

// ----------------------------------------------------------------------------
// Addressing
// ----------------------------------------------------------------------------

function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The segment of `path` that belongs to the declared `schema` level, never `path[0]`: a
 * level's position is a property of the declaration (standing ruling 5g).
 */
function schemaSegment(capabilities: ProviderCapabilities, path: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === "schema");
  const segment = index < 0 ? undefined : path.slice(0, levels.length)[index];
  if (segment === undefined) {
    throw new QueryError(
      `A Db2 path needs a "schema" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      "db2",
    );
  }
  return segment;
}

/** The one schema a container path names, refused by name at any other depth. */
export function containerSchema(capabilities: ProviderCapabilities, container: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  if (container.length !== levels.length) {
    throw new QueryError(
      `A Db2 container path is [${levels.map((level) => level.label.toLowerCase()).join(", ")}], ` +
        `received ${JSON.stringify(container)}`,
      "db2",
    );
  }
  return schemaSegment(capabilities, container);
}

/** The declared kind, or a refusal naming the kind a caller asked for. */
export function requireKind(capabilities: ProviderCapabilities, kind: string): ObjectKindSpec {
  const spec = declaredKinds(capabilities).find((candidate) => candidate.id === kind);
  if (spec === undefined) throw new QueryError(`Db2 declares no object kind "${kind}"`, "db2");
  return spec;
}

/**
 * That `path` has a shape this kind can take. An attached kind takes either depth, because a
 * trigger on another schema's table hangs off its own schema.
 */
export function assertObjectPathShape(
  capabilities: ProviderCapabilities,
  spec: ObjectKindSpec,
  path: readonly string[],
): void {
  const levels = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
  const shapes =
    spec.attachedTo === undefined
      ? [[...levels, "name"]]
      : [
          [...levels, spec.attachedTo, "name"],
          [...levels, "name"],
        ];
  if (!shapes.some((shape) => shape.length === path.length)) {
    throw new QueryError(
      `A Db2 "${spec.id}" path is ${shapes.map((shape) => `[${shape.join(", ")}]`).join(" or ")}, ` +
        `received ${JSON.stringify(path)}`,
      "db2",
    );
  }
}

/** The schema and the object's own name for a path whose shape was already checked. */
export function objectAddress(
  capabilities: ProviderCapabilities,
  path: readonly string[],
): { schema: string; name: string } {
  return { schema: schemaSegment(capabilities, path), name: path[path.length - 1] };
}

// ----------------------------------------------------------------------------
// Containers and counts
// ----------------------------------------------------------------------------

export interface ContainerRow {
  NAME: string;
  IS_SESSION_DEFAULT: number;
}

export function containersFromRows(rows: readonly ContainerRow[]): Container[] {
  return rows
    .map((row) => ({
      path: [row.NAME],
      name: row.NAME,
      level: 0,
      isSessionDefault: Number(row.IS_SESSION_DEFAULT) === 1,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

export interface KindCountRow {
  KIND: string;
  N: number | string;
}

/**
 * Every declared kind seeded at zero, then overwritten with what the statement answered, so a
 * kind this schema holds none of still draws a folder with a 0.
 */
export function countsFromRows(
  kinds: readonly ObjectKindSpec[],
  rows: readonly KindCountRow[],
): Record<string, KindCount> {
  const counts: Record<string, KindCount> = Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 }]));
  for (const row of rows) {
    const kind = KIND_BY_COUNT_LABEL[String(row.KIND).trimEnd()];
    if (kind !== undefined && kind in counts) counts[kind] = { count: Number(row.N) };
  }
  return counts;
}

/**
 * Db2's own sentence against every kind the refused read covered. Not `mapDatabaseError`: this
 * is rendered as the reason a folder has no number, and a refusal is never a zero.
 */
export function unavailableCounts(kinds: readonly ObjectKindSpec[], error: unknown): Record<string, KindCount> {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.fromEntries(kinds.map((kind) => [kind.id, { unavailable: reason }]));
}

// ----------------------------------------------------------------------------
// Listings
// ----------------------------------------------------------------------------

/** The statement and binds that list one kind, or undefined for a kind with no listing. */
export function listingStatement(schema: string, kind: string): { sql: string; params: unknown[] } | undefined {
  if (Object.hasOwn(TABLE_TYPE, kind)) return { sql: LIST_TABLES_SQL, params: [schema, TABLE_TYPE[kind]] };
  if (Object.hasOwn(ROUTINE_TYPE, kind)) return { sql: LIST_ROUTINES_SQL, params: [schema, ROUTINE_TYPE[kind]] };
  if (kind === "sequence") return { sql: LIST_SEQUENCES_SQL, params: [schema] };
  if (kind === "module") return { sql: LIST_MODULES_SQL, params: [schema] };
  if (kind === "trigger") return { sql: LIST_TRIGGERS_SQL, params: [schema] };
  return undefined;
}

export interface ObjectRow {
  NAME: string;
  SEGMENT?: string;
  PARENT?: string | null;
  STATUS?: string;
  VALID?: string | null;
  CARD?: number | string | null;
}

/**
 * The status a reader acts on, in Db2's documented meaning of its codes, and nothing otherwise.
 *
 * VALID is 'Y' for nearly every object, so publishing it would badge every row. 'N' is an
 * object Db2 will revalidate on next use (measured: a view over a dropped table, under
 * AUTO_REVAL DEFERRED) and 'X' one that is inoperative. TABLES.STATUS 'C' is set integrity
 * pending and 'X' inoperative; 'N' is normal.
 */
function notableStatus(row: ObjectRow): { status?: string } {
  const valid = row.VALID?.trimEnd();
  if (valid === "N") return { status: "INVALID" };
  if (valid === "X") return { status: "INOPERATIVE" };
  const status = row.STATUS?.trimEnd();
  if (status === "C") return { status: "SET INTEGRITY PENDING" };
  if (status === "X") return { status: "INOPERATIVE" };
  return {};
}

/**
 * CARD as a row count only when it is a measurement. -1 means RUNSTATS never ran, which is an
 * absence, and clamping it to 0 would show an empty table.
 */
function measuredRowCount(row: ObjectRow): { rowCount?: number } {
  if (row.CARD === undefined || row.CARD === null) return {};
  const card = Number(row.CARD);
  return Number.isFinite(card) && card >= 0 ? { rowCount: card } : {};
}

/** One listed object. The last segment is SEGMENT where the listing has one and NAME otherwise. */
export function objectFromRow(container: readonly string[], kind: string, row: ObjectRow): DatabaseObject {
  const segment = row.SEGMENT ?? row.NAME;
  const parent = row.PARENT;
  const path = parent === null || parent === undefined ? [...container, segment] : [...container, parent, segment];
  const counted = kind === "table" || kind === "materialized_query_table" ? measuredRowCount(row) : {};
  return { path, name: row.NAME, kind, ...notableStatus(row), ...counted };
}

// ----------------------------------------------------------------------------
// Detail
// ----------------------------------------------------------------------------

/** The SYSCAT.TABLES.TYPE a relation kind is stored under, or undefined for a kind that is not one. */
export function relationTableType(kind: string): string | undefined {
  return kind === "alias" || !Object.hasOwn(TABLE_TYPE, kind) ? undefined : TABLE_TYPE[kind];
}

const LENGTH_TYPES = new Set([
  "CHARACTER",
  "VARCHAR",
  "GRAPHIC",
  "VARGRAPHIC",
  "BINARY",
  "VARBINARY",
  "CLOB",
  "BLOB",
  "DBCLOB",
]);
const BIT_DATA_TYPES = new Set(["CHARACTER", "VARCHAR"]);

/**
 * The column type as Db2 would accept it back in DDL.
 *
 * The bare TYPENAME is not enough: schema diff compares these strings and the migration
 * generator writes one into `SET DATA TYPE`, where `VARCHAR` with no length is a syntax error.
 * Measured on 12.1: LENGTH is the declared length for the character, graphic, binary and LOB
 * types; DECIMAL carries precision in LENGTH and scale in SCALE; TIMESTAMP carries its
 * fractional precision in SCALE (6 when declared bare); DECFLOAT reports its storage in bytes,
 * 8 for DECFLOAT(16) and 16 for DECFLOAT(34); a character column with CODEPAGE 0 is FOR BIT DATA.
 */
function columnType(row: Record<string, unknown>): string {
  const name = String(row.TYPENAME).trimEnd();
  const length = Number(row.LENGTH);
  const scale = Number(row.SCALE);
  if (LENGTH_TYPES.has(name)) {
    const bitData = BIT_DATA_TYPES.has(name) && Number(row.CODEPAGE) === 0 ? " FOR BIT DATA" : "";
    return `${name}(${length})${bitData}`;
  }
  if (name === "DECIMAL") return `DECIMAL(${length},${scale})`;
  if (name === "TIMESTAMP" && scale !== 6) return `TIMESTAMP(${scale})`;
  if (name === "DECFLOAT") return length === 16 ? "DECFLOAT(34)" : "DECFLOAT(16)";
  return name;
}

export interface DetailRows {
  readonly columns: readonly Record<string, unknown>[];
  readonly foreignKeys: readonly Record<string, unknown>[];
  readonly indexes: readonly Record<string, unknown>[];
}

/**
 * Three row sets turned into one `ObjectDetail`, for the single and the bulk read both.
 *
 * `schema` is the object's own and decides only how a reference is spelled: bare within the
 * schema and qualified outside it, because a bare name for the crossing case addresses a table
 * in the wrong schema.
 */
export function objectDetailFromRows(path: readonly string[], schema: string, rows: DetailRows): ObjectDetail {
  const columns: ColumnSchema[] = rows.columns.map((row) => {
    const column: ColumnSchema = {
      name: String(row.COLUMN_NAME),
      type: columnType(row),
      nullable: String(row.NULLS) === "Y",
      isPrimary: row.KEYSEQ !== null && row.KEYSEQ !== undefined,
    };
    return row.DEFAULT_VALUE === null || row.DEFAULT_VALUE === undefined
      ? column
      : { ...column, defaultValue: String(row.DEFAULT_VALUE) };
  });

  // Keyed by schema AND name, because two index schemas may each hold an index of one name.
  const byIndex = new Map<string, IndexSchema>();
  for (const row of rows.indexes) {
    const key = `${String(row.INDEX_SCHEMA)}\0${String(row.INDEX_NAME)}`;
    const rule = String(row.UNIQUERULE);
    const index = byIndex.get(key) ?? {
      name: String(row.INDEX_NAME),
      columns: [],
      unique: rule === "U" || rule === "P",
    };
    index.columns.push(String(row.COLUMN_NAME));
    byIndex.set(key, index);
  }

  const foreignKeys: ForeignKeySchema[] = rows.foreignKeys.map((row) => ({
    columnName: String(row.COLUMN_NAME),
    referencedTable:
      String(row.REF_SCHEMA) === schema ? String(row.REF_TABLE) : `${String(row.REF_SCHEMA)}.${String(row.REF_TABLE)}`,
    referencedColumn: String(row.REF_COLUMN),
  }));

  return { path: [...path], columns, indexes: [...byIndex.values()], foreignKeys };
}

/** The rows of one bulk read grouped by the object each belongs to. */
export function byObjectName(rows: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const name = String(row.OBJECT_NAME);
    const held = grouped.get(name);
    if (held === undefined) grouped.set(name, [row]);
    else held.push(row);
  }
  return grouped;
}

// ----------------------------------------------------------------------------
// Source
// ----------------------------------------------------------------------------

/**
 * The statement and binds that read one object's text. The kind decides the view; the path
 * depth decides which of a trigger's two addresses is meant, and each binds exactly the
 * segments its own text names.
 */
export function sourceStatement(
  kind: string,
  address: { schema: string; name: string },
  path: readonly string[],
): { sql: string; params: unknown[] } {
  if (kind === "view" || kind === "materialized_query_table") {
    return { sql: SOURCE_VIEW_SQL, params: [address.schema, address.name, TABLE_TYPE[kind]] };
  }
  if (kind === "trigger") {
    return path.length === 3
      ? { sql: SOURCE_NESTED_TRIGGER_SQL, params: [address.schema, path[1], address.name] }
      : { sql: SOURCE_SCHEMA_TRIGGER_SQL, params: [address.schema, address.name] };
  }
  if (Object.hasOwn(ROUTINE_TYPE, kind)) {
    return { sql: SOURCE_ROUTINE_SQL, params: [address.schema, address.name, ROUTINE_TYPE[kind]] };
  }
  throw new QueryError(`Db2 declares readable source for the kind "${kind}" but has no statement that reads it`, "db2");
}

/** Why a routine row has no text, by its ORIGIN. Only a routine with SQL of its own keeps one. */
function missingRoutineText(origin: string): string {
  if (origin === "E") {
    return "This is an EXTERNAL routine: its body is compiled code outside the database, so SYSCAT.ROUTINES.TEXT is NULL and Db2 keeps no SQL text for it.";
  }
  if (origin === "U") {
    return "This is a SOURCED routine: it is defined as another function, so SYSCAT.ROUTINES.TEXT is NULL and Db2 keeps no SQL text for it.";
  }
  if (origin === "F") {
    return "This is a FEDERATED procedure: its body lives on the remote data source, so SYSCAT.ROUTINES.TEXT is NULL here.";
  }
  return `SYSCAT.ROUTINES.TEXT is NULL for this routine (ORIGIN '${origin}'), so Db2 keeps no SQL text for it.`;
}

/**
 * One source row as the single part a Db2 document carries: the stored text, or a refusal
 * saying why there is none. The two arms are whole literals and neither spreads the other, so
 * a part can never carry both `text` and `unavailable`.
 *
 * STORED and COMPLETE, measured: a view created through ibm_db with irregular spacing and a
 * trailing `--` comment read back from SYSCAT.VIEWS.TEXT byte-identical, and every text begins
 * with its CREATE, so it runs as given.
 */
export function sourcePartFromRow(
  row: Record<string, unknown>,
  language: string,
  limit: number | undefined,
  where: string,
): ObjectSourcePart {
  const text = row.TEXT;
  if (text === null || text === undefined) {
    const reason =
      row.ORIGIN === undefined
        ? `SYSCAT answered no definition text for ${where}.`
        : missingRoutineText(String(row.ORIGIN).trimEnd());
    return { id: "definition", label: "Definition", unavailable: reason };
  }
  if (typeof text !== "string") {
    // A defect in this file or the driver rather than a fact about the object, and reporting
    // it as Db2's answer would tell a reader their definition is broken.
    throw new QueryError(`Db2 answered the definition of ${where} as ${typeof text} rather than a string`, "db2");
  }
  if (text.trim() === "") {
    return { id: "definition", label: "Definition", unavailable: `SYSCAT answered an empty definition for ${where}.` };
  }
  const bounded = applySourceBound(text, limit);
  return {
    id: "definition",
    label: "Definition",
    text: bounded.text,
    language,
    form: "complete",
    origin: "stored",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}
