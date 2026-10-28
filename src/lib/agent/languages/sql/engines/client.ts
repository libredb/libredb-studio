/**
 * The SQL engines' client overlays (#1821): what a browser bundle may hold of each SQL engine's dialect. Client tier,
 * read only through `languages/engines/client.ts`. Each one says which of its server members the engine supplies, and
 * is typed from that engine's server overlay through `import type` alone, which loads nothing: a client overlay that
 * disagrees with its server overlay does not compile.
 */
import type { ClientDialectOf } from "../../pack";
import type { CLICKHOUSE_SERVER_OVERLAY } from "./clickhouse";
import type { DUCKDB_SERVER_OVERLAY } from "./duckdb";
import type { LIBSQL_SERVER_OVERLAY } from "./libsql";
import type { MSSQL_SERVER_OVERLAY } from "./mssql";
import type { MYSQL_SERVER_OVERLAY } from "./mysql";
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
