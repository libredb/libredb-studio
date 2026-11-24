import { BUNDLED_CONNECTION_STRINGS } from "@/lib/db/engine-catalog/connection-string.generated";
import type { ConnectionStringEntry } from "@/lib/db/engine-catalog/projection";
import { boundFunction, type FunctionTable } from "@/lib/db/function-table";
import { COUCHBASE_PASTE_READER } from "@/lib/db/providers/document/couchbase/connection-string";
import { MONGODB_PASTE_READER } from "@/lib/db/providers/document/mongodb/connection-string";
import { OPCUA_SEED_CHECK } from "@/lib/db/providers/industrial/opcua/connection-string";
import { ETCD_SEED_CHECK } from "@/lib/db/providers/keyvalue/etcd/connection-string";
import { REDIS_PASTE_READER } from "@/lib/db/providers/keyvalue/redis-connection-string";
import { CLICKHOUSE_PASTE_READER } from "@/lib/db/providers/sql/clickhouse/connection-string";
import { DATABEND_PASTE_READER } from "@/lib/db/providers/sql/databend/connection-string";
import { DB2_PASTE_READER, DB2_URL_TLS } from "@/lib/db/providers/sql/db2/connection-string";
import { LIBSQL_PASTE_READER } from "@/lib/db/providers/sql/libsql/connection-string";
import { MSSQL_PASTE_READER, MSSQL_URL_TLS } from "@/lib/db/providers/sql/mssql-connection-string";
import { MYSQL_PASTE_READER, MYSQL_URL_TLS } from "@/lib/db/providers/sql/mysql-connection-string";
import { ORACLE_PASTE_READER } from "@/lib/db/providers/sql/oracle-connection-string";
import { POSTGRES_PASTE_READER, POSTGRES_URL_TLS } from "@/lib/db/providers/sql/postgres-connection-string";
import { SNOWFLAKE_PASTE_READER, SNOWFLAKE_SEED_CHECK } from "@/lib/db/providers/sql/snowflake/connection-string";
import { SPARK_PASTE_READER } from "@/lib/db/providers/sql/spark/connection-string";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";
import { NO_CONNECTION_CONNECTION_STRING } from "./no-connection";
import type {
  ConnectionStringPaste,
  ConnectionStringPasteReader,
  ConnectionStringSpec,
  SeedCheck,
  UrlTlsReader,
} from "./types";

/**
 * Studio's connection string function table: for each slot kind a declaration's connection string names a function at,
 * the functions Studio's own source holds, per engine and name. A name is bound only at its own kind, so a function
 * held as a URL TLS reader is never run as a seed check.
 */
export interface ConnectionStringFunctions {
  /** `urlTls`: the TLS a URL carries in its query string. */
  readonly urlTlsReaders: FunctionTable<UrlTlsReader>;
  /** `paste.reader`: the three operations that read a pasted connection string. */
  readonly pasteReaders: FunctionTable<ConnectionStringPasteReader>;
  /** `seedCheck`: the checks the engine's provider makes before any socket, run at seed load. */
  readonly seedChecks: FunctionTable<SeedCheck>;
}

/**
 * The functions the committed declarations name (docs/providers/CONTRACT.md, clause M-74), each the one Studio's source
 * holds for that engine at that slot, exported by the engine's own module beside its provider as `<ID>_URL_TLS`,
 * `<ID>_PASTE_READER` or `<ID>_SEED_CHECK`. The dialog runs the paste readers in the browser, so a pasted connection
 * string never reaches the server before Test Connection or Save. A function only a package would hold has no place
 * here: no package function runs in a browser, and a name this table does not hold is refused when the connection
 * string is composed. tests/unit/db/connection-string/compose.test.ts holds the table to exactly the names the
 * committed declarations give.
 */
export const CONNECTION_STRING_FUNCTIONS: ConnectionStringFunctions = Object.freeze({
  urlTlsReaders: Object.freeze({
    db2: Object.freeze({ urlTls: DB2_URL_TLS }),
    mssql: Object.freeze({ urlTls: MSSQL_URL_TLS }),
    mysql: Object.freeze({ urlTls: MYSQL_URL_TLS }),
    postgres: Object.freeze({ urlTls: POSTGRES_URL_TLS }),
  }),
  pasteReaders: Object.freeze({
    clickhouse: Object.freeze({ pasteReader: CLICKHOUSE_PASTE_READER }),
    couchbase: Object.freeze({ pasteReader: COUCHBASE_PASTE_READER }),
    databend: Object.freeze({ pasteReader: DATABEND_PASTE_READER }),
    db2: Object.freeze({ pasteReader: DB2_PASTE_READER }),
    libsql: Object.freeze({ pasteReader: LIBSQL_PASTE_READER }),
    mongodb: Object.freeze({ pasteReader: MONGODB_PASTE_READER }),
    mssql: Object.freeze({ pasteReader: MSSQL_PASTE_READER }),
    mysql: Object.freeze({ pasteReader: MYSQL_PASTE_READER }),
    oracle: Object.freeze({ pasteReader: ORACLE_PASTE_READER }),
    postgres: Object.freeze({ pasteReader: POSTGRES_PASTE_READER }),
    redis: Object.freeze({ pasteReader: REDIS_PASTE_READER }),
    snowflake: Object.freeze({ pasteReader: SNOWFLAKE_PASTE_READER }),
    spark: Object.freeze({ pasteReader: SPARK_PASTE_READER }),
  }),
  seedChecks: Object.freeze({
    etcd: Object.freeze({ seedCheck: ETCD_SEED_CHECK }),
    opcua: Object.freeze({ seedCheck: OPCUA_SEED_CHECK }),
    snowflake: Object.freeze({ seedCheck: SNOWFLAKE_SEED_CHECK }),
  }),
});

/**
 * Engine `id`'s connection string, composed from `entry`, its projected connection string, and `functions`: the scheme
 * as declared; `readTls` the bound URL TLS reader, or null; `paste` null, or the declared catch-all flag, the bound
 * paste reader's three operations by identity and the declared formats; `validateSeed` the bound seed check, or null.
 * The row and its paste are frozen.
 *
 * @throws {Error} Naming the engine and the name, for a function name `functions` holds none for at its slot, including
 * a name it holds only at another slot.
 */
export function composeConnectionString(
  id: DatabaseType,
  entry: ConnectionStringEntry,
  functions: ConnectionStringFunctions,
): ConnectionStringSpec {
  const { scheme, urlTls, paste, seedCheck } = entry;
  let composedPaste: ConnectionStringPaste | null = null;
  if (paste !== null) {
    const reader = boundFunction(id, functions.pasteReaders, paste.reader);
    composedPaste = Object.freeze({
      catchAll: paste.catchAll,
      claims: reader.claims,
      names: reader.names,
      parse: reader.parse,
      formats: paste.formats,
    });
  }
  return Object.freeze({
    scheme,
    readTls: urlTls === null ? null : boundFunction(id, functions.urlTlsReaders, urlTls),
    paste: composedPaste,
    validateSeed: seedCheck === null ? null : boundFunction(id, functions.seedChecks, seedCheck),
  });
}

/**
 * Each engine's connection string facts, one row per type id, each composed when this module loads from the engine's
 * declaration (docs/providers/CONTRACT.md, clause M-74): its `connection.connectionString` scheme, URL TLS reader,
 * paste and seed check, which src/lib/db/engine-catalog/connection-string.generated.ts holds as
 * `BUNDLED_CONNECTION_STRINGS`, each named function bound through `CONNECTION_STRING_FUNCTIONS`. The generated record
 * is typed over the type-id union, so a new engine cannot ship without a declaration that says whether it has a scheme,
 * URL TLS or seed checks, and a name Studio holds no function for stops this module from loading, naming the engine and
 * the name.
 */
export const CONNECTION_STRING: Readonly<Record<DatabaseType, ConnectionStringSpec>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(BUNDLED_CONNECTION_STRINGS) as DatabaseType[]).map((id) => [
      id,
      composeConnectionString(id, BUNDLED_CONNECTION_STRINGS[id], CONNECTION_STRING_FUNCTIONS),
    ]),
  ) as Record<DatabaseType, ConnectionStringSpec>,
);

/**
 * The engines whose row reads a pasted connection string, in the order the parser offers a paste to them: the first
 * row that claims the text parses it. This is the one place that order is kept, and it matters in two cases only.
 * ClickHouse's `http://` and `https://` are a catch-all, so it comes last, after Snowflake, which claims an `https://`
 * URL on a Snowflake host as its own. And a bare Snowflake host claims any text with no space, `/`, `:`, `?`, `#` or
 * `@` before its suffix, so Databend's `BENDSQL_DSN=` shell line comes before it and SQL Server's `Server=` keyword
 * form after it, as each always has. Each such pair is declared in `CONNECTION_STRING_PASTE_OVERLAPS` below; every
 * other text is claimed by one row alone, which `tests/unit/db/connection-string/paste.test.ts` holds for every text
 * the parser tests paste.
 */
export const CONNECTION_STRING_PASTE_ORDER: readonly DatabaseType[] = Object.freeze([
  "databend",
  "spark",
  "snowflake",
  "mongodb",
  "postgres",
  "mysql",
  "redis",
  "oracle",
  "mssql",
  "db2",
  "couchbase",
  "libsql",
  "clickhouse",
]);

/** Two rows that may both claim one text, `first` walked first and so taking it from `second`, with a text both claim. */
export interface PasteOverlap {
  readonly first: DatabaseType;
  readonly second: DatabaseType;
  readonly text: string;
}

/**
 * The only pairs of rows that may both claim a text; the paste order above decides each. A text two rows claim that is
 * not a pair here is a row taking another engine's text, and the paste tests fail on it by name, a catch-all included:
 * a new row that claims ClickHouse's `http://` is a pair nobody declared.
 */
export const CONNECTION_STRING_PASTE_OVERLAPS: readonly PasteOverlap[] = Object.freeze([
  { first: "databend", second: "snowflake", text: "BENDSQL_DSN=x.snowflakecomputing.com" },
  { first: "snowflake", second: "mssql", text: "Server=x.snowflakecomputing.com" },
  { first: "snowflake", second: "clickhouse", text: "https://x.snowflakecomputing.com" },
]);

/** One engine's paste reader, with the type it belongs to. */
export interface PasteRow {
  readonly type: DatabaseType;
  readonly paste: ConnectionStringPaste;
}

/** The paste reader of each type in `order`, from `rows`, in that order; a listed row that reads no paste is refused. */
export function pasteRows(
  order: readonly DatabaseType[],
  rows: Readonly<Record<DatabaseType, ConnectionStringSpec>>,
): readonly PasteRow[] {
  return Object.freeze(
    order.map((type) => {
      const paste = rows[type].paste;
      if (paste === null) throw new Error(`the paste order lists ${type}, whose row reads no paste`);
      return { type, paste };
    }),
  );
}

/** Each row's paste reader with its type, in `CONNECTION_STRING_PASTE_ORDER`: the rows the parser walks. */
export const CONNECTION_STRING_PASTES: readonly PasteRow[] = pasteRows(
  CONNECTION_STRING_PASTE_ORDER,
  CONNECTION_STRING,
);

/**
 * The spec for a connection's type: `NO_CONNECTION_CONNECTION_STRING` without one, and the engine's row for a type id,
 * read through `typeIdRow`, so any other value is refused by name and a prototype key never reaches an
 * `Object.prototype` member.
 *
 * @throws {UnknownProviderError} When `type` is defined and not a type id: a string that names no provider, `""`,
 * `null`, or a value that is not text.
 */
export function connectionStringFor(type: string | undefined): ConnectionStringSpec {
  if (type === undefined) return NO_CONNECTION_CONNECTION_STRING;
  return typeIdRow(CONNECTION_STRING, type);
}

/**
 * The canonical URI scheme each engine is reachable by, for the engines that HAVE one.
 * Built from the `scheme` of each engine's row in `CONNECTION_STRING` above, which its declaration states, so a
 * scheme is added there. Its key order is `CONNECTION_STRING`'s and carries no meaning: readers look a type up by
 * key, and the login signature orders by the engine list.
 *
 * Deliberately partial, and the gaps are the point: SQLite is a file path, LibreDB is
 * embedded in the process, and Druid is reached over plain HTTP through the form. Inventing
 * `sqlite://` or `druid://` to make the map look complete would put a scheme on the login
 * page that no row's `paste` reads - a claim the product does not honour,
 * which is the class of defect issue #425 exists to remove.
 *
 * Cassandra is absent for a different reason again, and a stronger one: its driver needs
 * a REQUIRED `localDataCenter` alongside the contact points (measured on 4.9.0 - it
 * refuses to construct a client without one), and no URI convention in use carries that
 * field. A `cassandra://host:9042/keyspace` form would therefore parse into a connection
 * that cannot open, which is worse than no paste at all.
 *
 * Trino is the sharpest version of that gap, and worth naming because it looks like it
 * belongs here: it HAS a canonical URL, `jdbc:trino://host:port/catalog/schema`. That is
 * a JDBC URL and not a URI - `new URL()` reads its scheme as `jdbc:` - and stripping the
 * prefix to make one would invent a `trino://` form no Trino tool emits. So the id is
 * absent, its capabilities say `supportsConnectionString: false`, and its form offers no
 * paste toggle. Pinned by tests/unit/lib/connection-string-parser.test.ts.
 *
 * Apache Spark is absent on purpose too, though its `sc://` address is pasted and decomposed (`parseSparkConnectUri`):
 * the login signature prints every scheme here with the tail `user@db.internal:<port>/app`, and Spark's grammar
 * refuses both a user part and a path, so the hero would show an address the product refuses.
 *
 * Aliases the parser also accepts (`postgresql://`, `mongodb+srv://`, `rediss://`,
 * `sqlserver://`, `couchbases://`, and ClickHouse's `http(s)://`) are not listed: this map
 * answers "what is the one scheme to show a reader for this engine", not "what will parse".
 *
 * `tests/unit/lib/connection-string-parser.test.ts` pins the entries against the parser
 * itself - every scheme here must round-trip to its own `DatabaseType` - so the map cannot
 * drift away from the rows' paste claims without failing CI.
 */
export const ENGINE_URI_SCHEMES: Partial<Record<DatabaseType, string>> = Object.fromEntries(
  Object.entries(CONNECTION_STRING).flatMap(([type, spec]) => (spec.scheme === null ? [] : [[type, spec.scheme]])),
);
