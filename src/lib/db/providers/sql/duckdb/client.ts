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
 *   closes that, independently of `access_mode`: a WRITABLE handle with it set refuses every
 *   file route while `CREATE`/`INSERT` on the database still run (measured on v1.5.5-r.5),
 *   which is the editor's denied posture (non-admin DuckDB file access). It is passed alongside - see
 *   `openDuckDBClient`.
 * - With `autoinstall_known_extensions` and `autoload_known_extensions` at their defaults,
 *   opening a SQLite file made the engine fetch the ~34 MB `sqlite_scanner` extension from
 *   extensions.duckdb.org, attach the file and checkpoint its WAL (#1404). Both are off on
 *   every handle, and a file without DuckDB's header is refused before the engine sees it.
 */

import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
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
  /**
   * Roll back a transaction left open on this connection, and say whether there was
   * one to roll back (D71).
   *
   * It lives on the client rather than in the provider because DuckDB v1.5.5 publishes
   * NO transaction-state reading, so the only answer available is the engine's own
   * refusal of the ROLLBACK, and reading a driver error is driver vocabulary. Measured
   * 2026-08-27 and re-measured 2026-09-13 on v1.5.5 / @duckdb/node-api 1.5.5-r.4:
   * `current_transaction_id()` answers in both states (a new id per implicit
   * transaction outside one, the transaction's own id inside), `transaction_timestamp()`
   * is an alias of `get_current_timestamp()`, and the client context object carries only
   * a connection id. `duckdb_functions()` lists no other candidate.
   */
  endOpenTransaction(): Promise<boolean>;
  /** Ask the engine to abandon whatever this connection is running. */
  interrupt(): void;
  close(): void;
}

export interface DuckDBOpenOptions {
  /** The agent read-only profile: `READ_ONLY` and external access disabled. */
  readOnly: boolean;
  /**
   * The editor on an existing file this process cannot write (a `:ro` mount, a file mode
   * 0444, a file of another user). Opened `READ_ONLY`: a read-write open of such a file
   * answers "Permission denied" and cannot read it at all (measured on v1.5.5), while this
   * is still the editor. On its own it leaves the filesystem around the file reachable; the
   * denied editor posture pairs it with `denyExternalAccess` (see below).
   */
  unwritableFile?: boolean;
  /**
   * The denied editor posture (non-admin DuckDB file access): open a WRITABLE editor handle, but with
   * `enable_external_access: 'false'` so no statement reaches a file or the network outside
   * the database. It is what every non-admin role gets, and every role on a seed a non-admin
   * role can use (`editorExecutionContext`). Distinct from `readOnly`, which also closes file
   * access but makes the database itself read-only; this keeps the editor's writes and takes
   * only the statement-level file reach away, never the choice of the database file itself.
   * Composes with `unwritableFile` (`READ_ONLY` plus external access off). An admin editor
   * with full reach leaves it unset.
   */
  denyExternalAccess?: boolean;
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

/**
 * DuckDB's own words for "you asked me to roll back and there is nothing open".
 *
 * Measured on v1.5.5: `ROLLBACK` on a connection with no transaction answers
 * "TransactionContext Error: cannot rollback - no transaction is active", and the
 * connection is untouched by the refusal — the very next statement runs normally. That
 * is what makes an attempted rollback a safe way to ASK the question on an engine that
 * publishes no other reading of it (see `DuckDBClient.endOpenTransaction`).
 */
const NO_TRANSACTION_MARKER = "cannot rollback - no transaction is active";

/** The driver package, as every failure that is about its absence names it. */
const DRIVER_PACKAGE = "@duckdb/node-api";

/**
 * What an operator is told when the driver is not installed.
 *
 * A constant rather than an expression inside the branch below: it names the
 * remedy, which is the only reason this message exists, and a module-level
 * string cannot drift out of the coverage the branch has.
 */
const DRIVER_ABSENT_MESSAGE =
  `DuckDB is not available in this deployment: the ${DRIVER_PACKAGE} driver is not installed. ` +
  "The libredb-studio -alpine-slim image leaves it out to stay small; the default and -alpine tags ship it. " +
  "Use one of those tags, or install the driver, to open DuckDB connections.";

/**
 * The absence of the driver package, told apart from every other import failure
 * (issue #840).
 *
 * The `-alpine-slim` image ships without `@duckdb/node-api` deliberately - it is
 * four packages ending in a ~70 MB `libduckdb.so`, the largest removable item in
 * that image - so on that tag this import is expected to fail, and the operator
 * needs to be told which tags do carry it. Raw, the failure reads as
 * "Failed to load external module @duckdb/node-api-<hash>: Error: Cannot find
 * module ... Require stack: - /app/.next/server/chunks/...", which answers
 * neither question and prints the deployment's own file layout into a browser
 * toast.
 *
 * NARROW ON PURPOSE. Only a resolution failure that NAMES THIS PACKAGE is
 * translated; anything else answers null and is re-raised untouched by the
 * caller. "DuckDB is not installed in this image" is a false statement about a
 * corrupt binding or about some other dependency going missing, and it would
 * send the operator off to change tags over an unrelated fault.
 */
export function describeDriverAbsence(error: unknown): ConnectionError | null {
  if (!(error instanceof Error)) return null;

  const code = (error as Error & { code?: unknown }).code;
  const unresolved =
    code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || error.message.includes("Cannot find module");
  if (!unresolved || !error.message.includes(DRIVER_PACKAGE)) return null;

  return new ConnectionError(DRIVER_ABSENT_MESSAGE, "duckdb");
}

/**
 * The driver import, behind its own function so the absence path has a seam.
 *
 * The loader is a parameter with a default rather than a module-scope import:
 * making a real import fail is not something a test can arrange, and both arms
 * of the catch below are load-bearing. The default is the one production uses
 * and is exercised by every DuckDB integration test.
 */
export async function loadDuckDBDriver(
  load: () => Promise<typeof import("@duckdb/node-api")> = () => import("@duckdb/node-api"),
): Promise<typeof import("@duckdb/node-api")> {
  try {
    return await load();
  } catch (error) {
    const absence = describeDriverAbsence(error);
    if (absence) throw absence;
    throw error;
  }
}

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
// The file must be a DuckDB database
// ============================================================================

/** DuckDB's in-memory target. Accepted wherever a path is, and never touched on disk. */
export const MEMORY_TARGET = ":memory:";

/** Where every DuckDB database file, an encrypted one included, carries `DUCK` (measured on v1.5.5). */
const DUCKDB_MAGIC_OFFSET = 8;
const DUCKDB_MAGIC = "DUCK";

/** The 16 bytes every SQLite database file starts with (https://www.sqlite.org/fileformat2.html). */
const SQLITE_HEADER = "SQLite format 3\0";

/** The first bytes of the file at `path`, or null when it cannot be read here. */
function readHeader(path: string): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return header.subarray(0, fs.readSync(fd, header, 0, header.length, 0));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Refuse an existing file that is not a DuckDB database, before the engine opens it (#1404).
 *
 * The engine does not refuse one: it recognises a SQLite file and attaches it through the
 * `sqlite_scanner` extension, installing that from the network when it is missing and
 * checkpointing the SQLite WAL into the file, and the connection then reports success on
 * a database that is not DuckDB's. Reading the header first leaves the file untouched.
 *
 * A path that cannot be read here (missing, unreadable, a directory) is left to the
 * engine, which creates the missing file or names the failure in its own words.
 */
function assertDuckDBFile(path: string): void {
  if (path === MEMORY_TARGET) return;
  const header = readHeader(path);
  if (header === null) return;

  const magic = header.subarray(DUCKDB_MAGIC_OFFSET, DUCKDB_MAGIC_OFFSET + DUCKDB_MAGIC.length);
  if (magic.toString("latin1") === DUCKDB_MAGIC) return;

  if (header.toString("latin1") === SQLITE_HEADER) {
    throw new ConnectionError(
      `${path} is a SQLite database file, not a DuckDB database file. Open it with a SQLite connection. DuckDB did not open it, so it is unchanged.`,
      "duckdb",
    );
  }
  throw new ConnectionError(
    `${path} is not a DuckDB database file: a DuckDB file carries "${DUCKDB_MAGIC}" at byte ${DUCKDB_MAGIC_OFFSET}, and this one does not. DuckDB did not open it, so it is unchanged.`,
    "duckdb",
  );
}

// ============================================================================
// Open
// ============================================================================

/**
 * On every handle: no extension is fetched or loaded behind the user's back, and none
 * from outside DuckDB's own signed set (#1404).
 */
const EXTENSION_POLICY = {
  autoinstall_known_extensions: "false",
  autoload_known_extensions: "false",
  allow_community_extensions: "false",
};

/**
 * The engine options for one open; `openDuckDBClient` says why each is there.
 *
 * Composed from the posture rather than enumerated per profile, so the four handles the
 * provider opens are the four combinations of two independent facts:
 *
 * - `access_mode: 'READ_ONLY'` when the database itself must not be written: the agent
 *   read-only profile (`readOnly`) or an editor on a file this process cannot write
 *   (`unwritableFile`).
 * - `enable_external_access: 'false'` when no statement may reach a file or the network outside
 *   the database: the agent profile (`readOnly`) or the denied editor (`denyExternalAccess`).
 *
 * So: agent read-only = both; full-reach editor = neither; denied editor = external access off,
 * database still writable; denied editor on an unwritable file = both.
 *
 * `privateTempDir` is passed for a handle whose external access is off, and it goes into the map
 * BEFORE `enable_external_access` on purpose: the engine refuses a `temp_directory` set after that
 * ("Failed to set config", measured). See `openDuckDBClient` for why the handle needs a private one.
 */
function openConfig(options: DuckDBOpenOptions, privateTempDir: string | null): Record<string, string> {
  const config: Record<string, string> = { ...EXTENSION_POLICY };
  if (options.readOnly || options.unwritableFile) config.access_mode = "READ_ONLY";
  // Must precede `enable_external_access` below: once that is off the engine refuses a temp_directory.
  if (privateTempDir !== null) config.temp_directory = privateTempDir;
  if (options.readOnly || options.denyExternalAccess) config.enable_external_access = "false";
  return config;
}

/**
 * Open one DuckDB database and hand back the neutral handle.
 *
 * Three options are passed on EVERY handle, and two more on the read-only profile.
 * Everything else DuckDB can be configured with is left at its default on purpose: a
 * setting this provider chose would have to be defended per deployment.
 *
 * - `autoinstall_known_extensions: 'false'` and `autoload_known_extensions: 'false'` - no
 *   extension is fetched from the network or loaded because a statement or a file
 *   happened to need one (#1404). An explicit `INSTALL` and `LOAD` still work, and a
 *   session can `SET` either back on; the engine's own refusal names both routes.
 *   Neither stops an extension ALREADY installed on the host from being loaded to attach
 *   a file it recognises (measured), which is why `assertDuckDBFile` runs first.
 * - `allow_community_extensions: 'false'` - a community extension is third-party native
 *   code DuckDB does not vet, so `INSTALL x FROM community` is refused ("doesn't have a
 *   valid signature", measured). Unlike the two above it cannot be turned back on inside
 *   a session: `SET` and `SET GLOBAL` answer "Cannot change allow_community_extensions
 *   setting while database is running" (measured). `allow_unsigned_extensions` is already
 *   off by default and is fixed at open the same way, so only DuckDB's own signed
 *   extensions can load on any handle.
 *
 * Two more options draw the two boundaries, each passed independently of the other:
 *
 * - `access_mode: 'READ_ONLY'` - no write reaches the attached database. Passed on the agent
 *   read-only profile (`readOnly`) and on an editor file this process cannot write
 *   (`unwritableFile`).
 * - `enable_external_access: 'false'` - no statement reaches the filesystem AROUND the
 *   database. Passed on the agent profile (`readOnly`) AND on the denied editor
 *   (`denyExternalAccess`, non-admin DuckDB file access). It is drawn here rather than in the statement guard
 *   because a name denylist cannot see a quoted function name (`"read_text"(...)`), a bare
 *   path in `FROM` (DuckDB's replacement scan makes `FROM '/tmp/x.csv'` a `read_csv_auto`),
 *   or a statement smuggled through a string literal. Measured on v1.5.5: every one of those
 *   forms answers `Permission Error: Cannot access file "..." - file system operations are
 *   disabled by configuration`, while ordinary reads of the attached database, `duckdb_*()`
 *   catalog reads, `pragma_database_size()` and `pragma_storage_info()` are untouched - and,
 *   on a writable handle with external access off, `CREATE`/`INSERT`/`UPDATE`/`DELETE` and
 *   `ATTACH ':memory:'` still run, which is what makes the denied editor read-write.
 *
 * Both are fixed at OPEN and neither can be undone by a later statement: `SET`
 * and `SET GLOBAL enable_external_access = true` both answer `Invalid Input Error:
 * Cannot enable external access while database is running` (measured). That is the
 * property that lets the postures rely on them - `SET memory_limit` IS allowed on a
 * read-only handle, so "the engine refuses to be reconfigured" is not a given.
 *
 * A handle with external access off also gets a PRIVATE temp directory, created here with
 * `mkdtemp` (mode 0700) and removed in `close()`. DuckDB still allow-lists a denied handle's own
 * temp directory, and the default for every `:memory:` database in the process is the shared
 * `<cwd>/.tmp`: without a private one, a denied `:memory:` handle could `glob`, `read_blob` and
 * `COPY ... TO` another session's spill files there (measured). A private per-handle directory makes
 * `allowed_directories` that directory alone. The full-reach editor keeps the engine default, since
 * it can reach any file regardless.
 *
 * So the handle has three editor postures and the agent one:
 *
 * - AGENT READ-ONLY (`readOnly`): both options. The database is read-only and no statement
 *   reaches a file outside it.
 * - FULL-REACH EDITOR (neither extra option): an admin's editor connection, where `COPY ... TO`
 *   and `read_csv_auto('...')` are features rather than escapes; measured unaffected. On a
 *   file it cannot write it adds `access_mode` alone (`unwritableFile`).
 * - DENIED EDITOR (`denyExternalAccess`): writable, but `enable_external_access: 'false'`, so
 *   the database is editable and no statement reaches a file or the network outside it. Every
 *   non-admin role gets it, and every role on a seed a non-admin role can use. On a file it
 *   cannot write it also carries `access_mode` (`unwritableFile`).
 */
export async function openDuckDBClient(path: string, options: DuckDBOpenOptions): Promise<DuckDBClient> {
  // Inside the function, never at module scope - see the file header. Through
  // loadDuckDBDriver so that a deployment without the driver says so (#840).
  const { DuckDBInstance: Instance } = await loadDuckDBDriver();

  assertDuckDBFile(path);

  // A handle with external access off gets a private temp directory, so its spill files and its
  // `allowed_directories` allow-list are its own rather than the process-wide `<cwd>/.tmp` a
  // `:memory:` handle would otherwise share. The full-reach editor keeps the engine default.
  const privateTempDir =
    options.readOnly === true || options.denyExternalAccess === true
      ? await fs.promises.mkdtemp(join(os.tmpdir(), "libredb-duckdb-"))
      : null;

  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  try {
    instance = await Instance.create(path, openConfig(options, privateTempDir));
    connection = await instance.connect();
  } catch (error) {
    // The open failed, so nothing will ever close this handle: remove its private temp directory here.
    if (privateTempDir !== null) fs.rmSync(privateTempDir, { recursive: true, force: true });
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
    async endOpenTransaction(): Promise<boolean> {
      try {
        await connection.run("ROLLBACK");
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only the engine's own "there was nothing to roll back" is an answer. Anything
        // else is a real failure and is raised: a rollback that failed for another
        // reason has left the connection in a state this seam must not paper over.
        if (message.includes(NO_TRANSACTION_MARKER)) return false;
        throw error;
      }
    },
    interrupt(): void {
      connection.interrupt();
    },
    close(): void {
      connection.disconnectSync();
      instance.closeSync();
      // Remove the private temp directory this handle opened with (if any). `force` makes an
      // already-gone directory a no-op; anything else is raised rather than swallowed.
      if (privateTempDir !== null) fs.rmSync(privateTempDir, { recursive: true, force: true });
    },
  };
}
