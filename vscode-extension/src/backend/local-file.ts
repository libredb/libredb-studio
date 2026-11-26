// The extension's own rules for an engine that opens a file on this machine (its engine record's opensLocalFile grant,
// Studio's) rather than reach a server, checked by connection/test and connection/open before the factory builds anything.
import { isAbsolute } from "node:path";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { DatabaseConfigError } from "@/lib/db/errors";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseConnection } from "@/lib/types";
import type { Posture } from "../protocol";

/** What such an engine reads as an in-memory database rather than a path; an empty field means the same. */
const IN_MEMORY = ":memory:";

/**
 * Refuses a file-opening connection in Restricted Mode, where the posture denies external file access, in the
 * workspace-trust words a VS Code user acts on rather than the provider's own; and a relative path, which would
 * resolve against the child's working directory, the extension's own folder, where an update deletes the file.
 *
 * @throws {UnknownProviderError} When the connection's type is absent, not text, or names no engine the child knows,
 * read from the engine records before any rule (`servedEngineRecord`).
 */
export function checkLocalFile(connection: DatabaseConnection, posture: Posture): void {
  if (!servedEngineRecord(connection.type).grants.opensLocalFile) return;
  const { label } = CONNECTION_FORM[connection.type];
  if (!posture.allowExternalFileAccess) {
    throw new DatabaseConfigError(
      `Restricted Mode: LibreDB opens no ${label} database until you trust this workspace.`,
      connection.type,
    );
  }
  const path = connection.database;
  if (path === undefined || path === "" || path === IN_MEMORY || isAbsolute(path)) return;
  throw new DatabaseConfigError(
    `Enter the ${label} database file as an absolute path: a relative path resolves inside the extension's own folder, which an update replaces.`,
    connection.type,
  );
}
