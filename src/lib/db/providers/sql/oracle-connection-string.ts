import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `oracle`: the `oracle://` scheme, no TLS read from the URL query, no seed load check. */
export const ORACLE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "oracle",
  readTls: null,
  validateSeed: null,
};
