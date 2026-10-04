/**
 * Db2 driver seam (#786).
 *
 * Everything that knows `db2-node` exists lives in this file: the import, and the narrow
 * shape the rest of the provider consumes. The seam guard
 * (`tests/unit/db/db2/seam-guard.test.ts`) fails the build when the package is imported
 * anywhere else under `src/`.
 *
 * The import is DYNAMIC and lives in the default argument of `loadDb2Driver`, never at
 * module scope. `db2-node` is one package carrying eight prebuilt N-API addons, and a
 * top-level import would load one of them into every process that so much as touches the
 * provider registry. The types below are written out rather than taken from the package,
 * so they name only what this provider uses and leave out two options on purpose:
 *
 * - `queryTimeout`: since 1.0.24 it cancels the statement on the server through
 *   `WLM_CANCEL_ACTIVITY` on a second session, which needs monitoring and cancel privileges a
 *   plain user may not hold, and then closes the connection. Wiring it, and `Client.cancel()`,
 *   is a change of its own (D148), measured with an unprivileged user.
 * - `currentSchema`: honoured since 1.0.24, and still not needed: every catalog statement binds
 *   its schema (M4), and a session schema would only change how the user's own SQL resolves.
 *
 * `securityMechanism` is named with exactly one value. db2-node 1.0.24 and later refuse to fall
 * back to the plaintext mechanism a stock `AUTHENTICATION=SERVER` server answers with, unless the
 * connection asks for it by name, so the insecure opt-in asks for `userPassword`.
 *
 * `query` takes one option, `rowMode: "array"`, and the provider's own `query()` is its one
 * caller: an object row keys by column name and keeps only the last of two columns named alike
 * (K15), an array row keeps both. The catalog reads stay on object rows, keyed by the names
 * their own statements give.
 */

import { ConnectionError, DatabaseError, QueryError, mapDatabaseError } from "../../../errors";

/** One result column as db2-node describes it. */
export interface Db2ColumnMeta {
  name: string;
  /** The driver's own spelling: `Integer`, `VarChar(50)`, `Decimal { precision: 9, scale: 2 }`. */
  typeName: string;
  /** Present only where the driver also names the Db2 type (measured: GRAPHIC and VARGRAPHIC). */
  db2TypeName?: string;
  nullable: boolean;
  precision?: number;
  scale?: number;
}

/** One statement's outcome. */
export interface Db2QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: Db2ColumnMeta[];
  diagnostics: string[];
}

/** One statement's outcome under `rowMode: "array"`: each row holds its values in column order. */
export interface Db2ArrayQueryResult extends Omit<Db2QueryResult, "rows"> {
  rows: unknown[][];
}

/** The only query option this provider passes. */
export interface Db2ArrayRows {
  rowMode: "array";
}

/** The connection options this provider passes, and nothing it must not pass. */
export interface Db2ClientOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  rejectUnauthorized?: boolean;
  sslClientHostnameValidation?: "Basic" | "OFF";
  /** A FILE PATH to a PEM file, never the PEM text itself. */
  caCert?: string;
  /**
   * Only the plaintext mechanism (DRDA SECMEC 3), and only without TLS behind the insecure
   * opt-in. Left out, the driver uses its encrypted default.
   */
  securityMechanism?: "userPassword";
  connectTimeout?: number;
}

export interface Db2Client {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<Db2QueryResult>;
  query(sql: string, params: unknown[] | undefined, options: Db2ArrayRows): Promise<Db2ArrayQueryResult>;
  close(): Promise<void>;
}

export interface Db2Driver {
  Client: new (options: Db2ClientOptions) => Db2Client;
}

/** The package, as every failure that is about its absence names it. */
const DRIVER_PACKAGE = "db2-node";

const DRIVER_ABSENT_MESSAGE =
  `Db2 is not available in this deployment: the ${DRIVER_PACKAGE} driver is not installed. ` +
  "Install it, or use an image that ships it, to open Db2 connections.";

/**
 * The absence of the driver package, told apart from every other import failure.
 *
 * NARROW ON PURPOSE, as DuckDB's is: only a resolution failure that names this package is
 * translated. A corrupt addon or another missing dependency answers null and is re-raised
 * untouched, because "Db2 is not installed" would be a false statement about either.
 */
export function describeDriverAbsence(error: unknown): ConnectionError | null {
  if (!(error instanceof Error)) return null;

  const code = (error as Error & { code?: unknown }).code;
  const unresolved =
    code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || error.message.includes("Cannot find module");
  if (!unresolved || !error.message.includes(DRIVER_PACKAGE)) return null;

  return new ConnectionError(DRIVER_ABSENT_MESSAGE, "db2");
}

/**
 * The `driverCode`s db2-node 1.0.25 puts on a failure it raises itself, about the statement's
 * parameters: their number, or a value that does not fit its target (K17, fixed).
 */
const PARAMETER_DRIVER_CODES = new Set(["DB2_PARAMETER_COUNT", "DB2_PARAMETER_TYPE"]);

/** The `driverCode`s of a failure that is the driver's own, not the statement's (K17, fixed). */
const DRIVER_FAULT_CODES = new Set(["DB2_PROTOCOL", "DB2_INVALID_OPTION"]);

/**
 * A driver failure as the product's error, classified by the `driverCode` db2-node 1.0.25 adds
 * to a failure no server answered (K17), and by the shared mapping otherwise.
 *
 * Such a failure carries no SQLSTATE, so before 1.0.25 only its words could classify it, and the
 * shared mapping's keywords read them wrongly: a parameter refusal was a generic error, and a
 * protocol message that happened to hold "column" or "timeout" would read as a query error or a
 * timeout. A parameter refusal is the statement's, a `QueryError`; a protocol or option failure
 * is the driver's, a plain `DatabaseError`; the message is passed on as the driver wrote it. A
 * server error has no `driverCode` and keeps the shared mapping, as does a code this list does
 * not know.
 */
export function mapDb2Error(error: unknown, sql?: string): DatabaseError {
  const driverCode = error instanceof Error ? (error as Error & { driverCode?: unknown }).driverCode : undefined;
  if (typeof driverCode === "string" && error instanceof Error) {
    if (PARAMETER_DRIVER_CODES.has(driverCode)) return new QueryError(error.message, "db2", sql);
    if (DRIVER_FAULT_CODES.has(driverCode)) return new DatabaseError(error.message, "db2", undefined, sql);
  }
  return mapDatabaseError(error, "db2", sql);
}

/**
 * The driver import, behind a function so the absence path has a seam.
 *
 * The loader is a parameter with a default rather than a module-scope import: making a
 * real import fail is not something a test can arrange, and both arms of the catch are
 * load-bearing.
 */
export async function loadDb2Driver(
  load: () => Promise<Db2Driver> = () => import("db2-node") as unknown as Promise<Db2Driver>,
): Promise<Db2Driver> {
  try {
    return await load();
  } catch (error) {
    const absence = describeDriverAbsence(error);
    if (absence) throw absence;
    throw error;
  }
}
