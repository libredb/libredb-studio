import type { QueryResult } from "@/lib/types";

/**
 * The type each column of a result was DECLARED with, for the four drivers that hand
 * back a wire-format code instead of a name.
 *
 * Six provider families already fill `QueryResult.columnTypes` because their wire
 * format spells the type out (ClickHouse `Nullable(String)`, Trino, Druid, Cassandra,
 * the two search engines). The four node drivers do not: `pg` reports a `pg_type` OID,
 * `mysql2` a protocol type code plus flags, and only `oracledb` (`dbTypeName`) and
 * `mssql` (`type.declaration`) hand over a name - so those two need no table here and
 * read their metadata directly in their own providers.
 *
 * Why this matters, and why nothing here looks at a VALUE: a value-shaped guess can
 * only ever recover integer, boolean and text, because `pg` returns `numeric` as a
 * string to keep its precision and a `timestamp` is a string by the time it has been
 * through JSON. Measured before this module existed, `SELECT rental_rate, last_update,
 * film_id FROM film` exported as `("rental_rate" TEXT, "last_update" TIMESTAMP,
 * "film_id" BIGINT)` - one wrong type, one lost precision, and one integer column
 * widened. Guessing from the string's SHAPE is not an option either: it would type a
 * text column holding `2026-01-01` as a timestamp.
 *
 * The spelling rule is `QueryResult.columnTypes`' own: the way the engine spells it.
 * Each of the four names its types the way that engine's OWN catalog does, so a
 * declared type reads the same as the schema tree's entry for the same column
 * (`information_schema.COLUMNS.DATA_TYPE`, or Oracle's `ALL_TAB_COLUMNS.DATA_TYPE`) -
 * lowercase for Postgres, MySQL and SQL Server, uppercase for Oracle.
 *
 * No value is touched anywhere in this module: a `numeric` stays the string the driver
 * returned. This only adds the declaration.
 */

/**
 * Collects the declared types of one result, dropping the columns that declared none.
 *
 * Returns a spreadable object rather than a map, because the established convention
 * (`toQueryResult` in the Trino and ClickHouse providers) is to omit `columnTypes`
 * ENTIRELY when it would be empty, so a consumer can decide from the field's presence
 * alone. Nine call sites across the four providers spread this.
 *
 * `Object.fromEntries` rather than assignment into a literal: a column name is
 * arbitrary SQL output, and `columnTypes["__proto__"] = t` on an object literal
 * REPLACES the prototype instead of adding a property (measured in bun 1.3.14), which
 * would leave the key absent for every consumer that asks with `Object.hasOwn`.
 */
export function declaredColumnTypes(
  pairs: Iterable<readonly [string, string | undefined]>,
): Pick<QueryResult, "columnTypes"> {
  const declared = new Map<string, string>();
  for (const [name, type] of pairs) {
    // Last-wins: `SELECT 1 AS c, 'x' AS c` declares two columns called `c`, and the
    // row object every one of these drivers builds keeps the last one's value - so the
    // last one's type is the one that describes what the grid shows.
    if (type !== undefined) declared.set(name, type);
  }
  return declared.size > 0 ? { columnTypes: Object.fromEntries(declared) } : {};
}

/**
 * `pg` reports a column's type as a `pg_type` OID (`field.dataTypeID`), never a name.
 *
 * A STATIC table rather than a `pg_catalog` lookup, deliberately:
 *
 * - The OIDs of the built-in types are compiled into the server (`pg_type.dat`) and
 *   are never reused for a different type, so a table generated once is correct on
 *   every version - a newer server can only ever add OIDs this table does not know.
 * - A lookup would need a round trip that three of the four call sites cannot make.
 *   `query()` releases its pooled client before the result is assembled, and the
 *   agent's read-only profile (`queryReadOnly`) promises EXACTLY ONE statement inside
 *   `BEGIN READ ONLY` before it rolls back and runs `DISCARD ALL` - a catalog SELECT
 *   smuggled in beside it would break that promise for a column label.
 *
 * The table is generated, and reproducing it is the way to extend it:
 *
 *   SELECT t.oid, format_type(t.oid, NULL) FROM pg_type t
 *     JOIN pg_namespace n ON n.oid = t.typnamespace
 *    WHERE t.oid < 16384 AND n.nspname = 'pg_catalog'
 *      AND t.typtype IN ('b','r','m','e','d')
 *      AND format_type(t.oid, NULL) NOT LIKE 'pg\_%'
 *    ORDER BY t.oid;
 *
 * `format_type` is the authority on the spelling because it is what Postgres itself
 * prints: OID 20 is `bigint`, not the internal `int8` that `pg`'s own
 * `types.builtins` is keyed by. Excluded from the generated set: the pseudo-types (no
 * column can have one), the `pg_*` catalog rowtypes and their arrays (unreachable as a
 * result column's declared type), and the `information_schema` domains, whose OIDs are
 * assigned per database at initdb and so are NOT stable.
 *
 * A user-defined OID (>= 16384: an enum, a composite, an extension type) is absent
 * rather than wrong. Measured by running `SELECT *` through `pg` over every table and
 * view in dvdrental's `public` schema - 128 result columns, the largest real database
 * on hand - 125 are named, none wrongly, and 3 are absent: `film.rating` and the two
 * views over it, all three the enum `mpaa_rating`. Arrays are named (`text[]`).
 *
 * A DOMAIN does not even reach that case: measured, `film.release_year` is the domain
 * `year` in `pg_attribute` (OID 16516) and `pg` reports it as OID 23, its base type -
 * so the result says `integer`, which is what the wire actually carries.
 */
const PG_BUILTIN_TYPE_NAMES: Record<number, string | undefined> = {
  16: "boolean",
  17: "bytea",
  18: '"char"',
  19: "name",
  20: "bigint",
  21: "smallint",
  22: "int2vector",
  23: "integer",
  24: "regproc",
  25: "text",
  26: "oid",
  27: "tid",
  28: "xid",
  29: "cid",
  30: "oidvector",
  114: "json",
  142: "xml",
  143: "xml[]",
  199: "json[]",
  271: "xid8[]",
  600: "point",
  601: "lseg",
  602: "path",
  603: "box",
  604: "polygon",
  628: "line",
  629: "line[]",
  650: "cidr",
  651: "cidr[]",
  700: "real",
  701: "double precision",
  718: "circle",
  719: "circle[]",
  774: "macaddr8",
  775: "macaddr8[]",
  790: "money",
  791: "money[]",
  829: "macaddr",
  869: "inet",
  1000: "boolean[]",
  1001: "bytea[]",
  1002: '"char"[]',
  1003: "name[]",
  1005: "smallint[]",
  1006: "int2vector[]",
  1007: "integer[]",
  1008: "regproc[]",
  1009: "text[]",
  1010: "tid[]",
  1011: "xid[]",
  1012: "cid[]",
  1013: "oidvector[]",
  1014: "character[]",
  1015: "character varying[]",
  1016: "bigint[]",
  1017: "point[]",
  1018: "lseg[]",
  1019: "path[]",
  1020: "box[]",
  1021: "real[]",
  1022: "double precision[]",
  1027: "polygon[]",
  1028: "oid[]",
  1033: "aclitem",
  1034: "aclitem[]",
  1040: "macaddr[]",
  1041: "inet[]",
  1042: "character",
  1043: "character varying",
  1082: "date",
  1083: "time without time zone",
  1114: "timestamp without time zone",
  1115: "timestamp without time zone[]",
  1182: "date[]",
  1183: "time without time zone[]",
  1184: "timestamp with time zone",
  1185: "timestamp with time zone[]",
  1186: "interval",
  1187: "interval[]",
  1231: "numeric[]",
  1263: "cstring[]",
  1266: "time with time zone",
  1270: "time with time zone[]",
  1560: "bit",
  1561: "bit[]",
  1562: "bit varying",
  1563: "bit varying[]",
  1700: "numeric",
  1790: "refcursor",
  2201: "refcursor[]",
  2202: "regprocedure",
  2203: "regoper",
  2204: "regoperator",
  2205: "regclass",
  2206: "regtype",
  2207: "regprocedure[]",
  2208: "regoper[]",
  2209: "regoperator[]",
  2210: "regclass[]",
  2211: "regtype[]",
  2949: "txid_snapshot[]",
  2950: "uuid",
  2951: "uuid[]",
  2970: "txid_snapshot",
  3614: "tsvector",
  3615: "tsquery",
  3642: "gtsvector",
  3643: "tsvector[]",
  3644: "gtsvector[]",
  3645: "tsquery[]",
  3734: "regconfig",
  3735: "regconfig[]",
  3769: "regdictionary",
  3770: "regdictionary[]",
  3802: "jsonb",
  3807: "jsonb[]",
  3904: "int4range",
  3905: "int4range[]",
  3906: "numrange",
  3907: "numrange[]",
  3908: "tsrange",
  3909: "tsrange[]",
  3910: "tstzrange",
  3911: "tstzrange[]",
  3912: "daterange",
  3913: "daterange[]",
  3926: "int8range",
  3927: "int8range[]",
  4072: "jsonpath",
  4073: "jsonpath[]",
  4089: "regnamespace",
  4090: "regnamespace[]",
  4096: "regrole",
  4097: "regrole[]",
  4191: "regcollation",
  4192: "regcollation[]",
  4451: "int4multirange",
  4532: "nummultirange",
  4533: "tsmultirange",
  4534: "tstzmultirange",
  4535: "datemultirange",
  4536: "int8multirange",
  5069: "xid8",
  6150: "int4multirange[]",
  6151: "nummultirange[]",
  6152: "tsmultirange[]",
  6153: "tstzmultirange[]",
  6155: "datemultirange[]",
  6157: "int8multirange[]",
};

export function postgresColumnType(dataTypeID: number): string | undefined {
  return PG_BUILTIN_TYPE_NAMES[dataTypeID];
}

/**
 * The subset of mysql2's `FieldPacket` that describes a column's type.
 *
 * Declared here rather than imported: mysql2 types `flags` as `number | string[]`,
 * and every field below is optional in its own typings, so a provider passing a real
 * packet satisfies this shape without a cast.
 */
export interface MysqlColumnMetadata {
  columnType?: number;
  type?: number;
  characterSet?: number;
  columnLength?: number;
  decimals?: number;
  flags?: number | string[];
  extendedTypeName?: string;
}

/**
 * mysql2 reports a column's type as a protocol type code, which is NOT one type per
 * code. Measured on MySQL 26.7.0 over a 40-column probe table, three codes are shared:
 *
 *   ti    code=  1 len=         4 cs= 63 flags=    0        -> tinyint
 *   ti1   code=  1 len=         1 cs= 63 flags=    0        -> tinyint      (TINYINT(1))
 *   dec1  code=246 len=        12 cs= 63 dec=2              -> decimal
 *   ch    code=254 len=        40 cs=224 flags=    0        -> char
 *   bin   code=254 len=         8 cs= 63 flags=  128        -> binary
 *   en    code=254 len=         4 cs=224 flags=  256 [ENUM] -> enum
 *   st    code=254 len=        12 cs=224 flags= 2048 [SET]  -> set
 *   vc    code=253 len=       160 cs=224                    -> varchar
 *   vb    code=253 len=         9 cs= 63 flags=  128        -> varbinary
 *   tt    code=252 len=      1020 cs=224 flags=   16        -> tinytext
 *   tx    code=252 len=    262140 cs=224 flags=   16        -> text
 *   mt    code=252 len=  67108860 cs=224 flags=   16        -> mediumtext
 *   lt    code=252 len=4294967295 cs=224 flags=   16        -> longtext
 *   tb    code=252 len=       255 cs= 63 flags=  144        -> tinyblob
 *   bl    code=252 len=     65535 cs= 63 flags=  144        -> blob
 *   mb    code=252 len=  16777215 cs= 63 flags=  144        -> mediumblob
 *   lb    code=252 len=4294967295 cs= 63 flags=  144        -> longblob
 *
 * So: charset 63 (`binary`) is what separates a character type from a byte type - the
 * BLOB flag is set for both `tx` and `bl` and cannot do it. And all four text tiers
 * plus all four blob tiers arrive as ONE code, 252; only the length tells them apart,
 * so the tier is read from the length ceiling.
 *
 * Three things this deliberately does not do:
 *
 * - No length, precision or display width in the name. `int` reports len=11 and
 *   `decimal(10,2)` reports len=12/dec=2, and neither number is part of the declared
 *   type any more (MySQL 8.0.19 deprecated display width). `DATA_TYPE` in
 *   `information_schema` - which is what our own schema tree shows - is `decimal`, so
 *   that is what a declared type says here.
 * - No `unsigned` suffix, for the same reason: `DATA_TYPE` for `int unsigned` is
 *   plain `int`. Measured, the UNSIGNED flag is also set on `bit` and on `year`
 *   (`flags=96`), neither of which can be declared unsigned, so the flag is not even a
 *   reliable signal on its own.
 * - No distinction between `geometry` and `point`. Measured, both arrive as code 255;
 *   the protocol simply does not carry the subtype.
 */
const MYSQL_TYPE_NAMES: Record<number, string | undefined> = {
  0: "decimal",
  1: "tinyint",
  2: "smallint",
  3: "int",
  4: "float",
  5: "double",
  6: "null",
  7: "timestamp",
  8: "bigint",
  9: "mediumint",
  10: "date",
  11: "time",
  12: "datetime",
  13: "year",
  // NEWDATE, an internal-only DATE representation that no modern server sends.
  14: "date",
  15: "varchar",
  16: "bit",
  // MySQL 9's VECTOR. Kept because a server newer than the probe can send it.
  242: "vector",
  245: "json",
  // NEWDECIMAL, the only DECIMAL a server has sent since 5.0; MySQL spells it `decimal`.
  246: "decimal",
  255: "geometry",
};

/** `binary`, character set 63 - the marker that a string type is really a byte type. */
const MYSQL_BINARY_CHARSET = 63;
const MYSQL_ENUM_FLAG = 256;
const MYSQL_SET_FLAG = 2048;

/**
 * The blob/text tiers, keyed by the largest `columnLength` each can report.
 *
 * A tier's ceiling is its byte capacity times the charset's maximum bytes per
 * character (4 for utf8mb4), and the tiers are 256x apart, so a ceiling of `capacity *
 * 4` never overlaps the next tier's floor: the widest `tinytext` is 1020 and the
 * narrowest `text` (latin1) is 65535. LONGTEXT is not multiplied - 4294967295 is the
 * protocol's own maximum.
 */
const MYSQL_BLOB_TIERS: readonly (readonly [number, string, string])[] = [
  [255 * 4, "tinytext", "tinyblob"],
  [65535 * 4, "text", "blob"],
  [16777215 * 4, "mediumtext", "mediumblob"],
  [Number.POSITIVE_INFINITY, "longtext", "longblob"],
];

export function mysqlColumnType(field: MysqlColumnMetadata): string | undefined {
  // MariaDB 10.5+ sends the real name of a type the protocol has no code for (`uuid`,
  // `inet6`, `point`) in the extended metadata. When it is there it is the only
  // spelling of that column there is, so it wins.
  if (typeof field.extendedTypeName === "string" && field.extendedTypeName.length > 0) {
    return field.extendedTypeName;
  }

  const code = field.columnType ?? field.type;
  if (code === undefined) return undefined;

  // mysql2's typings allow a string[] here; measured, the driver hands a number. The
  // array form is read as no flags, which costs precision on ENUM and SET, never
  // correctness.
  const flags = typeof field.flags === "number" ? field.flags : 0;
  const isBinary = field.characterSet === MYSQL_BINARY_CHARSET;

  if (code === 254 || code === 253) {
    if ((flags & MYSQL_ENUM_FLAG) !== 0) return "enum";
    if ((flags & MYSQL_SET_FLAG) !== 0) return "set";
    if (code === 253) return isBinary ? "varbinary" : "varchar";
    return isBinary ? "binary" : "char";
  }

  // 249/250/251 are TINY_BLOB/MEDIUM_BLOB/LONG_BLOB. Measured, this server sends 252
  // for all eight tiers and never these three, but a server that does send them has
  // named the tier itself, so the code is honoured over the length.
  if (code === 249) return isBinary ? "tinyblob" : "tinytext";
  if (code === 250) return isBinary ? "mediumblob" : "mediumtext";
  if (code === 251) return isBinary ? "longblob" : "longtext";
  if (code === 252) {
    // No length at all: name the family the charset already settled rather than
    // claiming a tier. `blob`/`text` is the tier the plain type name means.
    const length = field.columnLength ?? 65535;
    const tier = MYSQL_BLOB_TIERS.find(([ceiling]) => length <= ceiling)!;
    return isBinary ? tier[2] : tier[1];
  }

  return MYSQL_TYPE_NAMES[code];
}

/** `pg`'s `result.fields`, narrowed to what a declared type needs. */
export interface PgFieldMetadata {
  name: string;
  dataTypeID?: number;
}

/** The declared types of a `pg` result, ready to spread into a `QueryResult`. */
export function postgresColumnTypes(fields: readonly PgFieldMetadata[] | undefined): Pick<QueryResult, "columnTypes"> {
  return declaredColumnTypes(
    (fields ?? []).map((field) => [
      field.name,
      field.dataTypeID === undefined ? undefined : postgresColumnType(field.dataTypeID),
    ]),
  );
}

/** The declared types of a mysql2 result, ready to spread into a `QueryResult`. */
export function mysqlColumnTypes(
  fields: readonly (MysqlColumnMetadata & { name: string })[] | undefined,
): Pick<QueryResult, "columnTypes"> {
  return declaredColumnTypes((fields ?? []).map((field) => [field.name, mysqlColumnType(field)]));
}

/**
 * `oracledb`'s `metaData`, which needs no table: it carries `dbTypeName` - Oracle's
 * own spelling, uppercase as `ALL_TAB_COLUMNS.DATA_TYPE` has it. Measured on Oracle
 * Free 23ai over `r5_types`: `NUMBER`, `BINARY_DOUBLE`, `VARCHAR2`, `CLOB`,
 * `TIMESTAMP`, `DATE`, `BLOB`, and `TIMESTAMP WITH TIME ZONE` for `SYSTIMESTAMP`.
 *
 * `precision`/`scale` sit beside it (10 and 2 for `NUMBER(10,2)`) and are deliberately
 * left out, for the reason MySQL's are: `DATA_TYPE` is the type, and a computed column
 * reports precision 0 (`COUNT(*)`) or scale -127 (`1/3`), which no `NUMBER(p,s)` built
 * from them would mean.
 */
export interface OracleColumnMetadata {
  name: string;
  dbTypeName?: unknown;
}

export function oracleColumnTypes(
  metaData: readonly OracleColumnMetadata[] | undefined,
): Pick<QueryResult, "columnTypes"> {
  return declaredColumnTypes(
    (metaData ?? []).map((column) => [
      column.name,
      typeof column.dbTypeName === "string" ? column.dbTypeName : undefined,
    ]),
  );
}

/**
 * `mssql`'s `recordset.columns`, which also needs no table: each entry's `type` is the
 * driver's type object, whose `declaration` is T-SQL's own lowercase spelling.
 * Measured on SQL Server 2022 CU26 over `types`: `bigint`, `decimal`, `float`, `bit`,
 * `nvarchar`, `varchar`, `datetime2`, `date`, `uniqueidentifier`, `varbinary` - the
 * same words as `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` for those columns.
 *
 * `type` is a factory FUNCTION for some types and an object for others, and both carry
 * `declaration`, so this reads the property off either without caring which.
 */
export interface MssqlColumnMetadata {
  type?: { declaration?: unknown } | (() => unknown);
}

export function mssqlColumnTypes(
  columns: Record<string, MssqlColumnMetadata> | undefined,
): Pick<QueryResult, "columnTypes"> {
  return declaredColumnTypes(
    Object.entries(columns ?? {}).map(([name, column]) => {
      const declaration = (column.type as { declaration?: unknown } | undefined)?.declaration;
      return [name, typeof declaration === "string" ? declaration : undefined];
    }),
  );
}
