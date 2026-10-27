// The extension's own rules for an engine that opens a file on this machine (OPENS_LOCAL_FILE) rather than reach a
// server, checked by connection/test and connection/open before the factory builds anything.
import { isAbsolute } from "node:path";
import { OPENS_LOCAL_FILE } from "@/lib/db/compatibility";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import type { Posture } from "../protocol";

/** What such an engine reads as an in-memory database rather than a path; an empty field means the same. */
const IN_MEMORY = ":memory:";

/**
 * Refuses a file-opening connection in Restricted Mode, where the posture denies external file access, in the
 * workspace-trust words a VS Code user acts on rather than the provider's own; and a relative path, which would
 * resolve against the child's working directory, the extension's own folder, where an update deletes the file.
 */
export function checkLocalFile(connection: DatabaseConnection, posture: Posture): void {
  if (!OPENS_LOCAL_FILE[connection.type]) return;
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
