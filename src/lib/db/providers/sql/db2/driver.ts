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
 * `securityMechanism` is named with exactly one value. db2-node 1.0.24 refuses to fall back to
 * the plaintext mechanism a stock `AUTHENTICATION=SERVER` server answers with, unless the
 * connection asks for it by name, so the insecure opt-in asks for `userPassword`.
 */

import { ConnectionError } from "../../../errors";

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
