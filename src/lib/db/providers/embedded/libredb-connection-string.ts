import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `libredb`: no connection string scheme (LibreDB is embedded in the process), no TLS read from a URL query, no seed load check. */
export const LIBREDB_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
