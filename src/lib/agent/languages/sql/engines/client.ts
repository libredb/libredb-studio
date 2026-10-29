/**
 * The SQL engines' client overlays (#1821): what a browser bundle may hold of each SQL engine's dialect. Client tier,
 * read only through `languages/engines/client.ts`. Each one says which of its server members the engine supplies, and
 * is typed from that engine's server overlay through `import type` alone, which loads nothing: a client overlay that
 * disagrees with its server overlay does not compile.
 */
import type { ClientDialectOf } from "../../pack";
import type { CASSANDRA_SERVER_OVERLAY } from "./cassandra";
import type { CLICKHOUSE_SERVER_OVERLAY } from "./clickhouse";
import type { DB2_SERVER_OVERLAY } from "./db2";
import type { DUCKDB_SERVER_OVERLAY } from "./duckdb";
import type { ELASTICSEARCH_SERVER_OVERLAY } from "./elasticsearch";
import type { INFLUXDB3_SERVER_OVERLAY } from "./influxdb3";
import type { LIBSQL_SERVER_OVERLAY } from "./libsql";
import type { MSSQL_SERVER_OVERLAY } from "./mssql";
import type { MYSQL_SERVER_OVERLAY } from "./mysql";
import type { OPENSEARCH_SERVER_OVERLAY } from "./opensearch";
import type { ORACLE_SERVER_OVERLAY } from "./oracle";
import type { POSTGRES_SERVER_OVERLAY } from "./postgres";
import type { SQLITE_SERVER_OVERLAY } from "./sqlite";

export const POSTGRES_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "supported",
    catalogCapture: "supported",
  } satisfies ClientDialectOf<(typeof POSTGRES_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof POSTGRES_SERVER_OVERLAY)["dialect"]> };
export const SQLITE_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "supported",
    catalogCapture: "supported",
  } satisfies ClientDialectOf<(typeof SQLITE_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof SQLITE_SERVER_OVERLAY)["dialect"]> };
export const DUCKDB_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "supported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof DUCKDB_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof DUCKDB_SERVER_OVERLAY)["dialect"]> };
export const MSSQL_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "supported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof MSSQL_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof MSSQL_SERVER_OVERLAY)["dialect"]> };
export const MYSQL_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "supported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof MYSQL_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof MYSQL_SERVER_OVERLAY)["dialect"]> };
export const CLICKHOUSE_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "supported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof CLICKHOUSE_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof CLICKHOUSE_SERVER_OVERLAY)["dialect"]> };
export const LIBSQL_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "supported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof LIBSQL_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof LIBSQL_SERVER_OVERLAY)["dialect"]> };
export const INFLUXDB3_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "supported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof INFLUXDB3_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof INFLUXDB3_SERVER_OVERLAY)["dialect"]> };
export const ELASTICSEARCH_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "unsupported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof ELASTICSEARCH_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof ELASTICSEARCH_SERVER_OVERLAY)["dialect"]> };
export const OPENSEARCH_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "unsupported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof OPENSEARCH_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof OPENSEARCH_SERVER_OVERLAY)["dialect"]> };
export const ORACLE_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "unsupported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof ORACLE_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof ORACLE_SERVER_OVERLAY)["dialect"]> };
export const DB2_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "unsupported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof DB2_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof DB2_SERVER_OVERLAY)["dialect"]> };
export const CASSANDRA_CLIENT_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: "supported",
    planEstimate: "unsupported",
    catalogCapture: "unsupported",
  } satisfies ClientDialectOf<(typeof CASSANDRA_SERVER_OVERLAY)["dialect"]>),
} as const satisfies { dialect: ClientDialectOf<(typeof CASSANDRA_SERVER_OVERLAY)["dialect"]> };
