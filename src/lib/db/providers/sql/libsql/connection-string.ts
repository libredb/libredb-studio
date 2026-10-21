import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `libsql`: the `libsql://` scheme, no TLS read from the URL query, no seed load check. */
export const LIBSQL_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "libsql",
  readTls: null,
  validateSeed: null,
};
