/**
 * The file a local-file provider opens: the one Studio's provider factory admitted (FND-2 slice 3).
 *
 * `createDatabaseProvider` decides the file a SQLite, DuckDB or LibreDB connection names before it builds the provider
 * (`admittedFileConnection` in `src/lib/db/provider-files.ts`): resolved against the working directory then, and
 * refused when it is one of Studio's own storage files. The provider reads the outcome here and resolves no path and
 * reads neither `STORAGE_SQLITE_PATH` nor the working directory itself, so neither the working directory at connect
 * nor a provider of its own can move what it opens.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { ADMITTED_FILE, type DatabaseConnection, type DatabaseType, type WithAdmittedFile } from "@/lib/types";

/** The refusal of a connection that carries no admitted file: its provider was built without Studio's factory. */
export const ADMITTED_FILE_MISSING =
  "This connection's file was not admitted by Studio's provider factory: build the provider with createDatabaseProvider, which decides the file a connection opens";

/** The admitted file, an absolute path or `:memory:`, or a `DatabaseConfigError` naming `type` when there is none. */
export function requireAdmittedFile(connection: DatabaseConnection, type: DatabaseType): string {
  const admitted = (connection as WithAdmittedFile)[ADMITTED_FILE];
  if (admitted === undefined) throw new DatabaseConfigError(ADMITTED_FILE_MISSING, type);
  return admitted;
}
