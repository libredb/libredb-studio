import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `sqlite`: no connection string scheme (SQLite is a file path), no TLS read from a URL query, no seed load check. */
export const SQLITE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
