/**
 * The file a local-file provider opens: the one Studio's provider factory admitted (FND-2 slice 3).
 *
 * `createDatabaseProvider` decides the file a SQLite, DuckDB or LibreDB connection names before it builds the provider
 * (`admittedFileConnection` in `src/lib/db/provider-files.ts`): resolved against the working directory then, and
 * refused when it is one of Studio's own storage files. The provider reads the outcome here and resolves no path and
 * reads neither `STORAGE_SQLITE_PATH` nor the working directory itself, so neither the working directory at connect
 * nor a provider of its own can move what it opens.
 *
 * The same holds for the files on Studio's host a connection's `HOST_PATH_FIELDS` name, OPC UA's client certificate
 * and private key: the factory admits them (`admittedHostPathConnection`), and the provider reads the outcome through
 * `requireAdmittedHostPath`.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  ADMITTED_FILE,
  ADMITTED_HOST_PATHS,
  type DatabaseConnection,
  type DatabaseType,
  type HostPathField,
  type WithAdmittedFile,
  type WithAdmittedHostPaths,
} from "@/lib/types";

/** The refusal of a connection that carries no admitted file: its provider was built without Studio's factory. */
export const ADMITTED_FILE_MISSING =
  "This connection's file was not admitted by Studio's provider factory: build the provider with createDatabaseProvider, which decides the file a connection opens";

/** The admitted file, an absolute path or `:memory:`, or a `DatabaseConfigError` naming `type` when there is none. */
export function requireAdmittedFile(connection: DatabaseConnection, type: DatabaseType): string {
  const admitted = (connection as WithAdmittedFile)[ADMITTED_FILE];
  if (admitted === undefined) throw new DatabaseConfigError(ADMITTED_FILE_MISSING, type);
  return admitted;
}

/** The refusal of a connection that sets a host path field the factory admitted no path for, after the field's name. */
export const ADMITTED_HOST_PATH_MISSING =
  "this connection's file was not admitted by Studio's provider factory: build the provider with createDatabaseProvider, which decides the files a connection names";

/**
 * The file the connection's `field` names, as Studio's provider factory admitted it: `undefined` when the record leaves
 * the field absent, `null` or empty, the admitted absolute path when the factory admitted one, and otherwise a
 * `DatabaseConfigError` naming `type` and the field (`ADMITTED_HOST_PATH_MISSING`), because the provider was built
 * without the factory.
 */
export function requireAdmittedHostPath(
  connection: DatabaseConnection,
  field: HostPathField,
  type: DatabaseType,
): string | undefined {
  const named: unknown = connection[field];
  if (named === undefined || named === null || named === "") return undefined;
  const admitted = (connection as WithAdmittedHostPaths)[ADMITTED_HOST_PATHS]?.[field];
  if (admitted === undefined) throw new DatabaseConfigError(`${field}: ${ADMITTED_HOST_PATH_MISSING}`, type);
  return admitted;
}
