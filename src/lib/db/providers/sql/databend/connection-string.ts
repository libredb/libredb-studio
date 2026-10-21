import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `databend`: the `databend://` scheme, no TLS read from the URL query, no seed load check. */
export const DATABEND_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "databend",
  readTls: null,
  validateSeed: null,
};
