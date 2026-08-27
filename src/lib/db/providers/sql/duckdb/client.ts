/**
 * DuckDB driver seam (issue #424)
 *
 * Everything that knows `@duckdb/node-api` exists lives in this file: the instance
 * and connection lifecycle, the read-only open, the interrupt, and the one shape the
 * rest of the provider consumes. `duckdb-seam-guard.test.ts` fails the build when the
 * driver's vocabulary appears anywhere else in this directory, for the same reason the
 * libSQL directory keeps Hrana behind one file - the provider logic is engine logic,
 * not driver logic.
 *
 * The import is DYNAMIC and lives inside `openDuckDBClient`, never at module scope.
 * That is not a style choice: `@duckdb/node-bindings-<platform>-<arch>` ships a ~70 MB
 * `libduckdb.so` that a top-level import would load into every process that so much as
 * touches the provider registry - the factory, the capabilities route, every other
 * engine. A `import type` for the driver's own types is fine and is used below: types
 * are erased, so they load nothing.
 *
 * Measured facts this seam encodes (DuckDB v1.5.5 / @duckdb/node-api 1.5.5-r.4,
 * 2026-08-27, and recorded in `.duckdb-measured.md`):
 *
 * - `getRowObjects()` throws on `JSON.stringify` ("Do not know how to serialize a
 *   BigInt"), so `getRowObjectsJson()` is the only row reader used here. It is not a
 *   preference: the API route serializes every result.
 * - `columnNames()` and `columnTypes()` answer even for an EMPTY row set, and
 *   `getRowObjectsJson()` carries no column information at all, so columns are read
 *   from the reader rather than from the first row.
 * - `access_mode: 'READ_ONLY'` refuses writes to the attached database AND refuses to
 *   create a missing file, but on its own it is not a filesystem sandbox: `COPY ... TO`,
 *   `read_text('/etc/hostname')` and `glob('/etc/*')` all succeeded on a handle whose
 *   `INSERT` was refused in the same session. `enable_external_access: 'false'` is what
 *   closes that, and it is passed alongside - see `openDuckDBClient`.
 */

import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { ConnectionError } from "../../../errors";

// ============================================================================
// Neutral result shape
// ============================================================================

/**
 * One statement's outcome, in the vocabulary the rest of the provider speaks.
 *
 * `rows` are the JSON projections `getRowObjectsJson()` produces, which is the only
 * reader that survives serialization: BIGINT, HUGEINT and DECIMAL arrive as decimal
 * STRINGS, LIST as an array, STRUCT as an object, INTERVAL as
 * `{months, days, micros}` and UUID as a string.
 */
export interface DuckDBStatementResult {
  /** Column order exactly as the engine declared it, present even for an empty row set. */
  columnNames: string[];
  /** DuckDB's own type text per column, positionally aligned with `columnNames`. */
  columnTypes: string[];
  rows: Record<string, unknown>[];
  /** Rows a DML statement changed, as the engine counted them. */
  rowsChanged: number;
}

/**
 * The provider's handle on one open database.
 *
 * A single connection, deliberately: DuckDB is embedded and in-process, there is no
 * pool to size, and `interrupt()` is a method on the CONNECTION - a pool would make
 * "cancel the running statement" ambiguous about which one.
 */
export interface DuckDBClient {
  /** The resolved path this handle holds, or `:memory:`. */
  readonly path: string;
  /** True when the instance was opened read-only AND with external access disabled. */
  readonly readOnly: boolean;
  run(sql: string, params?: unknown[]): Promise<DuckDBStatementResult>;
  /** Ask the engine to abandon whatever this connection is running. */
  interrupt(): void;
  close(): void;
}

export interface DuckDBOpenOptions {
  readOnly: boolean;
}

// ============================================================================
// Lock diagnosis
// ============================================================================

/**
 * DuckDB's own words for "another OS process holds this file".
 *
 * Worth its own message because the engine's sentence is accurate but unactionable
 * on its own, and because the situation is COMMON here rather than exotic: DuckDB
 * takes the lock at open and refuses a second opener even in read-only mode
 * (measured), so a user who left `duckdb warehouse.duckdb` running in a terminal
 * cannot open the same file in Studio at all. The holding PID is in the engine's
 * text and is the one thing that ends the confusion, so it is kept verbatim.
 */
const LOCK_CONFLICT_MARKER = "conflicting lock is held";

/** The PID DuckDB named as holding the lock, when its message names one. */
export function readLockHolderPid(message: string): number | null {
  const match = /\(PID (\d+)\)/.exec(message);
  return match === null ? null : Number(match[1]);
}

/**
 * The open failure, translated.
 *
 * Two shapes get their own sentence because both are ordinary and neither explains
 * itself: the cross-process lock above, and a read-only open of a file that is not
 * there (DuckDB does not create it, by design, which is exactly what makes the
 * read-only handle safe - but "database does not exist" arriving as a raw stack
 * trace tells nobody that).
 */
export function describeOpenFailure(error: unknown, path: string, readOnly: boolean): ConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (lowered.includes(LOCK_CONFLICT_MARKER)) {
    const pid = readLockHolderPid(message);
    const holder = pid === null ? "another process" : `process ${pid}`;
    return new ConnectionError(
      `DuckDB file ${path} is locked by ${holder}. DuckDB admits one operating-system process per database file, in read-only mode too, so the other process has to release it first. Engine message: ${message}`,
      "duckdb",
    );
  }

  if (readOnly && lowered.includes("does not exist")) {
    return new ConnectionError(
      `DuckDB database ${path} does not exist and a read-only handle will not create one. Engine message: ${message}`,
      "duckdb",
    );
  }

  return new ConnectionError(`Failed to open DuckDB database ${path}: ${message}`, "duckdb");
}

// ============================================================================
// Open
// ============================================================================

/**
 * Open one DuckDB database and hand back the neutral handle.
 *
 * TWO options are passed, and only for the read-only profile. Everything else DuckDB
 * can be configured with is left at its default on purpose: a setting this provider
 * chose would have to be defended per deployment.
 *
 * - `access_mode: 'READ_ONLY'` - no write reaches the attached database.
 * - `enable_external_access: 'false'` - no statement reaches the filesystem AROUND it.
 *   This is the read-only profile's real boundary, and it is drawn here rather than in
 *   the statement guard because a name denylist cannot see a quoted function name
 *   (`"read_text"(...)`), a bare path in `FROM` (DuckDB's replacement scan makes
 *   `FROM '/tmp/x.csv'` a `read_csv_auto`), or a statement smuggled through a string
 *   literal. Measured on v1.5.5: every one of those forms answers
 *   `Permission Error: Cannot access file "..." - file system operations are disabled
 *   by configuration`, while ordinary reads of the attached database, `duckdb_*()`
 *   catalog reads, `pragma_database_size()` and `pragma_storage_info()` are untouched.
 *
 * Both are fixed at OPEN and neither can be undone by a later statement: `SET`
 * and `SET GLOBAL enable_external_access = true` both answer `Invalid Input Error:
 * Cannot enable external access while database is running` (measured). That is the
 * property that lets the profile rely on them - `SET memory_limit` IS allowed on a
 * read-only handle, so "the engine refuses to be reconfigured" is not a given.
 *
 * The WRITABLE handle passes neither. It is the ordinary editor connection, where
 * `COPY ... TO` and `read_csv_auto('...')` are features rather than escapes; measured
 * unaffected by this change.
 */
export async function openDuckDBClient(path: string, options: DuckDBOpenOptions): Promise<DuckDBClient> {
  // Inside the function, never at module scope - see the file header.
  const { DuckDBInstance: Instance } = await import("@duckdb/node-api");

  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  try {
    instance = await Instance.create(
      path,
      options.readOnly ? { access_mode: "READ_ONLY", enable_external_access: "false" } : {},
    );
    connection = await instance.connect();
  } catch (error) {
    throw describeOpenFailure(error, path, options.readOnly);
  }

  return {
    path,
    readOnly: options.readOnly,
    async run(sql: string, params?: unknown[]): Promise<DuckDBStatementResult> {
      // `runAndReadAll(sql, undefined)` and `runAndReadAll(sql)` are not the same call
      // to the binding, so the parameterless form is issued as such.
      const reader =
        params === undefined
          ? await connection.runAndReadAll(sql)
          : await connection.runAndReadAll(sql, params as Parameters<typeof connection.runAndReadAll>[1]);

      return {
        columnNames: reader.columnNames(),
        columnTypes: reader.columnTypes().map(String),
        rows: reader.getRowObjectsJson() as Record<string, unknown>[],
        rowsChanged: reader.rowsChanged,
      };
    },
    interrupt(): void {
      connection.interrupt();
    },
    close(): void {
      connection.disconnectSync();
      instance.closeSync();
    },
  };
}
