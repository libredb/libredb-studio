/**
 * The host files core decides for a provider before it is built (FND-2 slice 3).
 *
 * A provider package runs in Studio's own process (the provider plugins design section 0.1), so which file on Studio's
 * host a connection opens, and which directory OPC UA keeps its client identity in, are core's decisions, not a
 * provider's: a provider that resolved a path against the working directory at connect, or read a setting of
 * Studio's, would answer by whatever the process's working directory and environment were then. The legacy adapter's
 * open (`openLegacyEngine` in src/lib/provider-host/legacy-adapter/open.ts), which the provider factory's
 * `createDatabaseProvider` (`./factory`) opens through, calls the functions here and hands the provider their outcome.
 *
 * `admittedFileConnection`: the file a connection names where its engine record grants `opensLocalFile` (SQLite, DuckDB
 * and LibreDB), resolved against the working directory when the provider is built and refused, by name, when it is one
 * of Studio's own storage files, compared with the storage location this process took (`storageLocation` in
 * `@/lib/data-dir`). The provider opens the absolute path it is handed under `ADMITTED_FILE` (`@/lib/types`), through
 * `requireAdmittedFile` in `./utils/admitted-file`.
 *
 * `admittedHostPathConnection`: the files on Studio's host the fields its engine record's `hostPathFields` grant names
 * (OPC UA's client certificate and private key), admitted the same way and handed to the provider under
 * `ADMITTED_HOST_PATHS`, which it reads through `requireAdmittedHostPath` in `./utils/admitted-file`.
 *
 * Both admissions also refuse, by name, a path in the server's providers directory (`providersDirectoryCheck` in
 * `@/lib/provider-host/providers-dir`): the directory, anything in it and its lock, from which Studio reads the provider
 * packages it may load.
 *
 * `opcuaPkiRoot`: OPC UA's PKI root. This module is the only code that reads `LIBREDB_OPCUA_PKI_ROOT`;
 * `tests/unit/lib/db/provider-environment-scan.test.ts` holds it, and holds that no provider module reaches
 * `@/lib/data-dir`.
 */
import * as path from "path";
import { reservedStorageCheck, storageLocation } from "@/lib/data-dir";
import { providersDirectoryCheck } from "@/lib/provider-host/providers-dir";
import {
  ADMITTED_FILE,
  ADMITTED_HOST_PATHS,
  type DatabaseConnection,
  type DatabaseType,
  type HostPathField,
} from "@/lib/types";
import { CONNECTION_STRING_ACCEPTED } from "./compatibility";
import { DatabaseConfigError } from "./errors";
import { servedEngineRecord } from "./server-catalog";
import { typeIdRow } from "./type-id";

/** The refusal of a connection that names one of Studio's own storage files. */
export const RESERVED_STORAGE_PATH =
  "This path is reserved for the server's own storage and cannot be opened as a connection";

/** The refusal of a connection that names the server's providers directory, a path in it or its lock. */
export const RESERVED_PROVIDERS_PATH =
  "This path is in the server's providers directory and cannot be opened as a connection";

/** The refusal of a file name holding a NUL byte, which no filesystem path holds. */
export const NUL_IN_DATABASE_PATH = "Invalid database path: NUL bytes are not allowed";

/** The refusal of a file name that is not text, which no stored or posted connection the forms write carries. */
export const FILE_NAME_NOT_TEXT = "Invalid database path: the file a connection names must be text";

/**
 * The refusal of a SQLite connection string that is `file:` and nothing after it, which names no file.
 * The sentence does not repeat the connection string, a secret-class field, so the scrub of provider text keeps it.
 */
export const NO_FILE_AFTER_SCHEME = "Invalid database path: the connection string names no file after its scheme";

/**
 * The start of the refusal of a path the reserved check could not read, followed by the filesystem's own reason: the
 * check resolves the path's real location, and the filesystem answered something other than "no such file".
 */
export const PATH_NOT_CHECKED = "This connection's file could not be checked against the server's own storage files";

/** The one in-memory name the local-file engines share, exactly as written; any other spelling is a file name. */
const IN_MEMORY = ":memory:";

/** The scheme SQLite's connection string may carry before the file it names. */
const FILE_SCHEME = "file:";

/** The connection without an admitted file: itself when it carries none, otherwise a copy without the caller's. */
function withoutAdmittedFile<T extends DatabaseConnection>(connection: T): T {
  // `in`, so a marker on the prototype counts too; the spread copies own properties only.
  if (!(ADMITTED_FILE in connection)) return connection;
  const copy: T = { ...connection };
  delete (copy as { [ADMITTED_FILE]?: string })[ADMITTED_FILE];
  return copy;
}

/**
 * The connection a local-file provider is built from: a copy carrying the file core admitted under `ADMITTED_FILE`.
 *
 * 1. An engine whose record does not grant `opensLocalFile`: the connection itself.
 * 2. The named file: the connection string, a leading `file:` removed, where the engine accepts one
 *    (`CONNECTION_STRING_ACCEPTED`) and it is not empty; otherwise `database`.
 * 3. Absent or empty: the connection without an admitted file, so the provider's own `validate()` refuses it with its
 *    own sentence, or its connect refuses it as not admitted.
 * 4. Not text: refused by name (`FILE_NAME_NOT_TEXT`).
 * 5. A connection string that is `file:` and nothing after it: refused by name (`NO_FILE_AFTER_SCHEME`), since the
 *    provider's `validate()` accepts a non-empty string and the string names no file.
 * 6. Exactly `:memory:`: admitted as `:memory:`.
 * 7. Holding a NUL byte: refused by name (`NUL_IN_DATABASE_PATH`), before anything is resolved.
 * 8. Resolved against the working directory now; one of Studio's own storage files (`reservedStorageCheck`) is refused
 *    by name (`RESERVED_STORAGE_PATH`), and then a path in the providers directory (`providersDirectoryCheck`) by its
 *    own name (`RESERVED_PROVIDERS_PATH`). A path the check cannot read, where the filesystem answers anything but "no
 *    such file" (a path through a regular file, a symbolic link loop, a directory the server cannot search), is refused
 *    by name too (`PATH_NOT_CHECKED`, followed by the filesystem's message, the original error kept as `cause`).
 *    An error reading Studio's own storage files or the providers directory is the server's, and is raised as it is.
 * 9. Otherwise admitted as that absolute path.
 *
 * The copy is an object spread, so every other marker survives, and `database` and `connectionString` stay as the
 * record holds them; the caller's record is never written, and an `ADMITTED_FILE` a caller set never survives. Every
 * refusal is a `DatabaseConfigError` naming the connection's own type.
 *
 * @throws {UnknownProviderError} When the connection's type is absent, not text, or names no engine the server knows.
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 */
export function admittedFileConnection<T extends DatabaseConnection>(connection: T): T {
  if (!servedEngineRecord(connection.type).grants.opensLocalFile) return connection;
  const file = namedFile(connection);
  if (file === null) return withoutAdmittedFile(connection);
  if (file === IN_MEMORY) return { ...connection, [ADMITTED_FILE]: IN_MEMORY };
  if (file.includes("\0")) throw new DatabaseConfigError(NUL_IN_DATABASE_PATH, connection.type);
  const absolute = path.resolve(file);
  const reserved = reservedOrUnchecked(absolute, connection.type, "");
  if (reserved !== null) throw new DatabaseConfigError(reserved, connection.type);
  return { ...connection, [ADMITTED_FILE]: absolute };
}

/**
 * The file a connection of an engine whose record grants `opensLocalFile` names, as `admittedFileConnection` reads it,
 * steps 2 to 5: the connection string, a leading `file:` removed, where the engine accepts one and it is not empty,
 * otherwise `database`; null when the name is absent or empty. A name that is not text, and a connection string that is
 * `file:` and nothing after it, are refused by name. The admission and `namesInMemoryDatabase` both read the name here,
 * so the two never read it differently.
 */
function namedFile(connection: DatabaseConnection): string | null {
  const fromString = typeIdRow(CONNECTION_STRING_ACCEPTED, connection.type) && connection.connectionString;
  const named: unknown = fromString ? fromString : connection.database;
  if (named === undefined || named === null || named === "") return null;
  if (typeof named !== "string") throw new DatabaseConfigError(FILE_NAME_NOT_TEXT, connection.type);
  const file = named === fromString && named.startsWith(FILE_SCHEME) ? named.slice(FILE_SCHEME.length) : named;
  if (file === "") throw new DatabaseConfigError(NO_FILE_AFTER_SCHEME, connection.type);
  return file;
}

/**
 * Whether `connection` names an in-memory database: an engine whose record grants `opensLocalFile`, whose named file is
 * exactly `:memory:`, the one name `admittedFileConnection` admits as `:memory:`. Every other spelling is a file, as
 * the admission resolves it. An in-memory database is one database per handle, so the host serves such a connection's
 * tree from the editor's session (`sessionCapacity` in `./session-capacity`, docs/providers/CONTRACT.md, clause C-66).
 * A name the admission refuses is refused here by the same sentence.
 *
 * @throws {UnknownProviderError} When the connection's type is absent, not text, or names no engine the server knows.
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 */
export function namesInMemoryDatabase(connection: DatabaseConnection): boolean {
  return servedEngineRecord(connection.type).grants.opensLocalFile && namedFile(connection) === IN_MEMORY;
}

/** The connection without admitted host paths: itself when it carries none, otherwise a copy without the caller's. */
function withoutAdmittedHostPaths<T extends DatabaseConnection>(connection: T): T {
  // `in`, so a marker on the prototype counts too; the spread copies own properties only.
  if (!(ADMITTED_HOST_PATHS in connection)) return connection;
  const copy: T = { ...connection };
  delete (copy as { [ADMITTED_HOST_PATHS]?: unknown })[ADMITTED_HOST_PATHS];
  return copy;
}

/**
 * The connection a provider that reads files on Studio's own host is built from: a copy carrying, under
 * `ADMITTED_HOST_PATHS`, the files core admitted for the fields its engine record's `hostPathFields` grant names (OPC
 * UA's client certificate and private key), on the footing of `admittedFileConnection`.
 *
 * 1. An engine whose grant names no field: the connection, without an `ADMITTED_HOST_PATHS` a caller set.
 * 2. Each field in row order: absent, `null` or empty is not admitted, so the provider's own rules answer it (OPC UA's
 *    pair rule refuses a certificate without its key).
 * 3. Not text: refused by name (`Invalid <field>: the file it names must be text`).
 * 4. Holding a NUL byte: refused by name (`Invalid <field>: NUL bytes are not allowed`), before anything is resolved.
 * 5. Resolved against the working directory now; one of Studio's own storage files (`reservedStorageCheck`) is refused
 *    by name (`<field>: ` and `RESERVED_STORAGE_PATH`), a path in the providers directory (`providersDirectoryCheck`)
 *    by its own name (`<field>: ` and `RESERVED_PROVIDERS_PATH`), and a path the check cannot read is refused by name too
 *    (`<field>: ` and `PATH_NOT_CHECKED`, followed by the filesystem's message, the original error kept as `cause`).
 *    An error reading Studio's own storage files or the providers directory is the server's, and is raised as it is.
 * 6. Otherwise admitted as that absolute path; text of spaces only is a path, as the library would be handed it.
 *
 * The admitted paths are a frozen record on an object spread of the connection, so every other marker survives and the
 * fields stay as the record holds them; the caller's record is never written, and an `ADMITTED_HOST_PATHS` a caller set
 * never survives. Every refusal is a `DatabaseConfigError` naming the connection's own type.
 *
 * @throws {UnknownProviderError} When the connection's type is absent, not text, or names no engine the server knows.
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 */
export function admittedHostPathConnection<T extends DatabaseConnection>(connection: T): T {
  const fields = servedEngineRecord(connection.type).grants.hostPathFields;
  if (fields.length === 0) return withoutAdmittedHostPaths(connection);
  const admitted: Partial<Record<HostPathField, string>> = {};
  for (const field of fields) {
    const named: unknown = connection[field];
    if (named === undefined || named === null || named === "") continue;
    if (typeof named !== "string") {
      throw new DatabaseConfigError(`Invalid ${field}: the file it names must be text`, connection.type);
    }
    if (named.includes("\0"))
      throw new DatabaseConfigError(`Invalid ${field}: NUL bytes are not allowed`, connection.type);
    const absolute = path.resolve(named);
    const reserved = reservedOrUnchecked(absolute, connection.type, `${field}: `);
    if (reserved !== null) throw new DatabaseConfigError(`${field}: ${reserved}`, connection.type);
    admitted[field] = absolute;
  }
  return { ...connection, [ADMITTED_HOST_PATHS]: Object.freeze(admitted) };
}

/**
 * The refusal of `absolute` when it is one of Studio's own storage files (`reservedStorageCheck`, `RESERVED_STORAGE_PATH`)
 * or a path in the providers directory (`providersDirectoryCheck`, `RESERVED_PROVIDERS_PATH`), in that order; null when
 * it is neither. An error reading Studio's own files or the providers directory is raised as it is, since it is the
 * server's fault and not the connection's. A filesystem error either check raises on the connection's path, one that
 * carries an error code, is raised again as a `DatabaseConfigError` naming `type`, with `prefix` (the field's name, for a
 * host path field), then the filesystem's message after `PATH_NOT_CHECKED`, and the original as `cause`: the connection
 * is refused either way, and the caller is told why. Any other error is raised as it is.
 */
function reservedOrUnchecked(
  absolute: string,
  type: DatabaseType,
  prefix: string,
): typeof RESERVED_STORAGE_PATH | typeof RESERVED_PROVIDERS_PATH | null {
  const isStorage = reservedStorageCheck();
  const isProviders = providersDirectoryCheck();
  try {
    if (isStorage(absolute)) return RESERVED_STORAGE_PATH;
    return isProviders(absolute) ? RESERVED_PROVIDERS_PATH : null;
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code !== "string") throw error;
    const refusal = new DatabaseConfigError(`${prefix}${PATH_NOT_CHECKED}: ${(error as Error).message}`, type);
    refusal.cause = error;
    throw refusal;
  }
}

/**
 * The environment variable naming OPC UA's PKI root.
 *
 * Read from the server's own environment rather than from a connection, because a private key is the installation's
 * identity and not one reader's setting: every connection from this Studio presents the same client certificate, which
 * is what a server administrator adds to a trust list once.
 */
export const OPCUA_PKI_ROOT_ENV = "LIBREDB_OPCUA_PKI_ROOT";

/** The directory under Studio's own data directory that holds OPC UA's client PKI by default. */
export const OPCUA_PKI_DIRECTORY = "opcua-pki";

/**
 * Where OPC UA keeps its client key pair and trust list: `LIBREDB_OPCUA_PKI_ROOT`, trimmed, when it is set and absolute;
 * `opcua-pki` under the data directory of the storage location this process took when it is unset, empty or blank; a
 * relative value is refused by name, naming `type`. Read at each OPC UA build in the legacy adapter's open
 * (src/lib/provider-host/legacy-adapter/open.ts), which hands the root to the provider.
 *
 * THE LIBRARY'S DEFAULT CANNOT WORK IN THE PRODUCT IMAGE, AND THAT IS MEASURED, NOT FEARED. On a first connect, even in
 * None mode, `node-opcua-client` generates a private key and a self-signed client certificate under the platform's own
 * config directory (`$HOME/.config/node-opcua-default-nodejs/PKI` on Linux). Measured on
 * `ghcr.io/libredb/libredb-studio:0.18.2`, the process runs as uid 1001 whose home is `/nonexistent`, and a `mkdir`
 * there fails `EACCES`; `src/lib/db/providers/industrial/opcua/pki.ts` keeps the measurement. So the root never falls
 * back to a setting that depends on `HOME`.
 *
 * THE DEFAULT IS STUDIO'S DATA DIRECTORY, AND IT IS THERE BECAUSE A BROWSER RUN SHOWED WHAT NO DEFAULT COST. Requiring
 * the variable was the first answer: measured end to end in a real browser, a reader who installed Studio, picked OPC
 * UA and pressed Test Connection was told the engine needs a directory nobody had told them about. The data directory
 * is the one Studio already owns and writes, beside the storage database, so it exists and is writable in every
 * deployment, and the deployments that mount it (the chart's PVC, a Docker volume) get a client identity that survives
 * a restart. The variable still overrides it, which is what a deployment sharing one identity between replicas sets.
 *
 * `isAbsolute`, NOT `startsWith("/")`, and the difference is measured: on Windows the cross-platform run refused
 * `C:\Users\RUNNER~1\AppData\Local\Temp\...` as relative. A relative value is refused because it would resolve against
 * whatever directory the server happened to start in.
 */
export function opcuaPkiRoot(type: DatabaseType): string {
  const root = process.env[OPCUA_PKI_ROOT_ENV]?.trim();
  if (root === undefined || root === "") return path.join(storageLocation().dataDirectory, OPCUA_PKI_DIRECTORY);
  if (!path.isAbsolute(root)) {
    throw new DatabaseConfigError(
      `${OPCUA_PKI_ROOT_ENV} is an absolute path, and this one is relative: ${root}. A relative path would ` +
        "resolve against whatever directory the server happened to start in.",
      type,
    );
  }
  return root;
}
