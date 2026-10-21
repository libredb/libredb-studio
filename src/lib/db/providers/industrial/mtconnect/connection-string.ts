import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `mtconnect`: no connection string scheme, no TLS read from a URL query, no seed load check. */
export const MTCONNECT_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  validateSeed: null,
};
